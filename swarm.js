'use strict';

const { sendChat, MODEL_PRESETS } = require('./providers');
const { styleSystemMessage } = require('./styles');
const { fableSystemMessage } = require('./fable');
const { recordAttempt, diagnose, pickReplacement } = require('./modelHealth');
const { effortMaxTokens } = require('./effort');
const trace = require('./trace');

// Zeiteffizienz in Swarm/Hive: weniger Retries pro Modell-Aufruf als im Einzel-Chat -- bei
// einem schlechten Modell lohnt sich hier nicht das volle Warten (1s/2s/4s Backoff, bis zu
// 3x), weil modelHealth.js ohnehin auf ein anderes Preset ausweicht, sobald sich ein Muster
// zeigt. Unabhaengig vom globalen /effort-Setting (das bleibt ausschliesslich fuer den
// Einzel-Chat massgeblich).
const SWARM_MAX_RETRIES = 1;
// ponytail: Bug, den ein echter Lauf aufgedeckt hat -- war auf 'medium' (4096) gesenkt, um
// pro Zug Zeit zu sparen. Fast alle Presets (deepseek-v4/qwen-397b/kimi-k2.6/glm-5) sind
// aber Reasoning-Modelle, die einen Teil ihres max_tokens-Budgets fuer eine interne, nicht
// sichtbare Gedankenkette verbrauchen (delta.reasoning_content, siehe providers.js), BEVOR
// sichtbarer Text/Tool-Aufruf kommt -- bei 4096 reichte das Budget bei komplexeren Coordinator-
// /Worker-Aufgaben oft nicht mehr fuer den sichtbaren Teil, das Ergebnis war eine "LEERE"
// Antwort (weder Text noch Tool-Aufruf). Ein leerer Zug kostet am Ende MEHR Zeit (Retry/
// Modell-Wechsel/Coordinator-Neustart) als das hoehere Budget gespart haette -- Zeit sparen
// war der urspruengliche Grund fuer 'medium', aber leere Zuege sind netto langsamer.
const SWARM_MAX_TOKENS = effortMaxTokens('high');

const SEND_MESSAGE_TOOL = {
  type: 'function',
  function: {
    name: 'send_message',
    description:
      'Sendet eine Nachricht an eine andere Agent-Rolle im Team. Die Nachricht wird eingeblendet, sobald diese Rolle das naechste Mal am Zug ist.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Name der Ziel-Rolle (z.B. "coder")' },
        content: { type: 'string', description: 'Nachrichtentext' },
      },
      required: ['to', 'content'],
    },
  },
};

function speakerTag(name, text) {
  return `[${name}]: ${text}`;
}

// Macht eine leere Antwort (weder Text noch Tool-Aufruf) diagnostizierbar statt nur "moeglicher
// Modell-Aussetzer" zu raten: finish_reason:"length" + reasoningChars>0 heisst konkret "Budget
// ging fuers Denken drauf, bevor sichtbarer Output kam" (siehe SWARM_MAX_TOKENS-Kommentar oben).
function describeEmptyTurn(chatResult) {
  if (!chatResult) return '';
  const parts = [];
  if (chatResult.finishReason) parts.push(`finish_reason: ${chatResult.finishReason}`);
  if (chatResult.reasoningChars) parts.push(`${chatResult.reasoningChars} Zeichen interne Gedankenkette verbraucht`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

// Selbstdiagnose (modelHealth.js): wenn das der Rolle zugewiesene Modell sich bereits als
// unzuverlaessig/langsam erwiesen hat, fuer DIESEN Zug automatisch auf ein anderes Preset
// ausweichen, statt erneut eine lange Retry-Kette zu riskieren. onModelSwap benachrichtigt
// den Aufrufer (index.js), damit der Nutzer sieht, dass/warum gewechselt wurde.
function pickEffectiveModel(role, onModelSwap, runId = null) {
  const diag = diagnose(role.model);
  if (!diag.unhealthy) return role.model;
  const replacement = pickReplacement(role.model, Object.keys(MODEL_PRESETS));
  if (replacement !== role.model) {
    trace.logEvent(runId, 'model_swap', { role: role.name, from: role.model, to: replacement, reason: diag.reason });
    onModelSwap(role, role.model, replacement, diag.reason);
    return replacement;
  }
  return role.model;
}

// ponytail: max. Assignments pro dispatch_agents-Aufruf gedeckelt -- verhindert, dass ein
// Coordinator-Modell versehentlich 50 parallele Calls in einer Runde auslöst (Kostenexplosion).
// Braucht der Coordinator mehr Worker als das Limit, ruft er dispatch_agents einfach in einer
// weiteren Runde erneut auf (sendChat erlaubt bis zu 10 Tool-Iterationen).
const MAX_ASSIGNMENTS_PER_DISPATCH = 10;

function buildDispatchTool(workerRoles) {
  return {
    type: 'function',
    function: {
      name: 'dispatch_agents',
      description:
        `Verteilt Teilaufgaben parallel an Worker-Agenten. Verfuegbare Rollen: ${workerRoles.map((r) => `"${r.name}" (${r.label})`).join(', ')}. ` +
        `Max. ${MAX_ASSIGNMENTS_PER_DISPATCH} Assignments pro Aufruf -- fuer mehr: dispatch_agents in einer weiteren Runde erneut aufrufen.`,
      parameters: {
        type: 'object',
        properties: {
          assignments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string', description: 'Name einer der verfuegbaren Worker-Rollen' },
                task: { type: 'string', description: 'Konkrete Teilaufgabe fuer diese Rolle' },
              },
              required: ['role', 'task'],
            },
          },
        },
        required: ['assignments'],
      },
    },
  };
}

// Ruflo-Vorbild (nested-coordinator): mehrstufige Hives -- ein Worker, den der Top-Coordinator
// dispatcht (Tiefe 1), bekommt SELBST ebenfalls das dispatch_agents-Tool und kann seine
// Teilaufgabe nochmal in kleinere Stuecke zerlegen, bis zur konfigurierten Tiefe. Bewusst mit
// hartem Deckel bei Ruflos Tiefe 5, um Kosten/Laufzeit nicht explodieren zu lassen (Tiefe*
// MAX_ASSIGNMENTS_PER_DISPATCH waechst multiplikativ). MAX_ASSIGNMENTS_PER_DISPATCH gilt pro
// Dispatch-Aufruf auf JEDER Ebene (kein zusaetzlicher Multiplikator-Deckel noetig).
//
// Auf Nutzerwunsch konfigurierbar statt fix 2: mehr eingetragene API-Keys (siehe keyPool.js)
// bedeuten weniger Rate-Limit-Risiko bei mehr gleichzeitigen Requests, also ist eine groessere
// Tiefe (mehr parallele Verschachtelung = mehr gleichzeitige Calls) dann eher vertretbar. Ohne
// explizite /hivedepth-Einstellung wird das automatisch aus der Key-Anzahl abgeleitet.
const HIVE_DEPTH_CAP = 5;
const HIVE_DEPTH_DEFAULT = 2;

function recommendHiveDepth(config) {
  const totalKeys = Object.values(config.keys || {}).reduce((sum, list) => {
    const arr = Array.isArray(list) ? list : (list ? [list] : []);
    return sum + arr.filter((k) => k && k.trim()).length;
  }, 0);
  if (totalKeys >= 6) return 4;
  if (totalKeys >= 3) return 3;
  return HIVE_DEPTH_DEFAULT;
}

function effectiveHiveDepth(config) {
  const override = config.hiveDepth;
  if (Number.isInteger(override) && override >= 1 && override <= HIVE_DEPTH_CAP) return override;
  return Math.min(recommendHiveDepth(config), HIVE_DEPTH_CAP);
}

// Ein einzelner Worker-Knoten im (moeglicherweise verschachtelten) Hive-Baum. `depth` zaehlt
// von 1 (direkt vom Top-Coordinator dispatcht) aufwaerts. `counter` ist ein ueber den GANZEN
// Baum geteiltes { n } Objekt (per Referenz durchgereicht) -- liefert eindeutige Worker-IDs
// (nicht nur pro Rollenname, siehe Kommentar bei workerSeq weiter unten) auch ueber mehrere
// Verschachtelungsebenen hinweg.
async function runWorkerNode({ config, role, task, depth, workerRoles, buildToolDefinitions, onWorkerStart, onWorkerDone, onFileToolCall, onRetry, projectContext, counter, onModelSwap = () => {}, runId = null }) {
  const workerId = `${role.name}#${counter.n++}`;
  // pickEffectiveModel VOR onWorkerStart, damit die Anzeige das TATSAECHLICH verwendete
  // (evtl. per Selbstdiagnose ersetzte) Modell zeigt statt immer role.model.
  const effectiveModel = pickEffectiveModel(role, onModelSwap, runId);
  onWorkerStart({ ...role, model: effectiveModel }, task, workerId);
  trace.logEvent(runId, 'worker_start', { workerId, role: role.name, depth, model: effectiveModel });
  const workerConfig = { ...config, activeModel: effectiveModel };
  const baseTools = buildToolDefinitions(config.projectRoot, { readOnly: role.readOnly });
  const canSubDispatch = depth < effectiveHiveDepth(config);
  const dispatchTool = canSubDispatch ? buildDispatchTool(workerRoles) : null;
  const tools = dispatchTool ? [dispatchTool, ...baseTools] : baseTools;

  let text = '';
  let toolCallHappened = false;
  let workerRetries = 0;
  const startMs = Date.now();
  let chatResult = null;
  try {
    chatResult = await sendChat({
      config: workerConfig,
      messages: [
        { role: 'system', content: role.systemPrompt },
        fableSystemMessage(),
        ...(projectContext ? [{ role: 'system', content: projectContext }] : []),
        { role: 'user', content: task },
      ],
      tools,
      onChunk: (delta) => { text += delta; },
      onToolCall: async (toolCall) => {
        toolCallHappened = true;
        if (dispatchTool && toolCall.function.name === 'dispatch_agents') {
          let args;
          try {
            args = JSON.parse(toolCall.function.arguments || '{}');
          } catch {
            return 'FEHLER: dispatch_agents Argumente nicht parsebar.';
          }
          const assignments = Array.isArray(args.assignments) ? args.assignments.slice(0, MAX_ASSIGNMENTS_PER_DISPATCH) : [];
          if (!assignments.length) {
            return 'FEHLER: keine gueltigen assignments uebergeben.';
          }
          const subOutcomes = await Promise.all(
            assignments.map((a) => {
              const subRole = workerRoles.find((r) => r.name === a.role);
              if (!subRole) return Promise.resolve({ role: a.role, label: a.role, error: `Rolle "${a.role}" nicht gefunden.` });
              return runWorkerNode({ config, role: subRole, task: a.task, depth: depth + 1, workerRoles, buildToolDefinitions, onWorkerStart, onWorkerDone, onFileToolCall, onRetry, projectContext, counter, onModelSwap, runId });
            })
          );
          return subOutcomes
            .map((o) => (o.error ? `[${o.label}] FEHLER: ${o.error}` : `[${o.label}] ${o.text}`))
            .join('\n\n');
        }
        return onFileToolCall(toolCall);
      },
      onRetry: (...a) => { workerRetries++; onRetry(...a); },
      maxRetries: SWARM_MAX_RETRIES,
      maxTokens: SWARM_MAX_TOKENS,
      runId,
    });
    const isEmpty = !text.trim() && !toolCallHappened;
    // Leere Antwort (HTTP 200, aber weder Text noch Tool-Aufruf) zaehlt jetzt als Fehler fuer
    // die Selbstdiagnose -- sonst wird ein Modell, das zuverlaessig leer statt mit echtem
    // Fehler antwortet, NIE als unhealthy erkannt und immer wieder als "Ersatz" gewaehlt.
    recordAttempt(effectiveModel, {
      retries: workerRetries,
      errored: isEmpty,
      durationMs: Date.now() - startMs,
      errorMessage: isEmpty ? 'leere Antwort (kein Text, kein Tool-Aufruf)' : '',
    });
    if (isEmpty) {
      const warning = `LEER: Modell hat weder Text noch Tool-Aufrufe geliefert${describeEmptyTurn(chatResult)}.`;
      trace.logEvent(runId, 'worker_empty', { workerId, role: role.name, model: effectiveModel, finishReason: chatResult?.finishReason, reasoningChars: chatResult?.reasoningChars });
      onWorkerDone(role, text, warning, workerId);
      return { role: role.name, label: role.label, error: warning };
    }
    trace.logEvent(runId, 'worker_done', { workerId, role: role.name, model: effectiveModel, durationMs: Date.now() - startMs });
    onWorkerDone(role, text, null, workerId);
    return { role: role.name, label: role.label, text };
  } catch (err) {
    recordAttempt(effectiveModel, { retries: workerRetries, errored: true, durationMs: Date.now() - startMs, errorMessage: err.message || String(err) });
    const message = err.message || String(err);
    trace.logEvent(runId, 'worker_error', { workerId, role: role.name, model: effectiveModel, error: message });
    onWorkerDone(role, '', message, workerId);
    return { role: role.name, label: role.label, error: message };
  }
}

// Coordinator-gefuehrter Schwarm (ruflo-swarm:coordinator-Vorbild): EIN Coordinator-Modell
// zerlegt die Aufgabe und dispatcht per Tool-Call an beliebig viele Worker-Rollen PARALLEL
// (Promise.all -- echte gleichzeitige HTTP-Requests, kein sequenzielles Abarbeiten). Jeder
// dispatchte Worker kann seinerseits nochmal dispatchen (siehe runWorkerNode/effectiveHiveDepth).
// ponytail: Bug, den ein echter Lauf aufgedeckt hat -- coordinatorToolCallHappened blieb
// fuer die GESAMTE (mehrstufige) Coordinator-Unterhaltung auf true, sobald IRGENDEIN Tool-
// Aufruf passiert war (z.B. ein exploratives list_directory ganz am Anfang). Als danach der
// naechste Modell-Call mit 503 fehlschlug, kurz retryte und leer zurueckkam, wertete der Code
// das als "erfolgreich abgeschlossen" -- der Coordinator hat aber nie dispatch_agents
// aufgerufen, Hive meldete trotzdem "fertig" mit 0 Workern. Fix: nicht "irgendein Tool-Call
// jemals", sondern konkret "wurde ueberhaupt dispatcht" pruefen (dispatchHappened) -- und bei
// "nein" den Coordinator-Versuch automatisch (mit explizitem Hinweis) wiederholen, statt
// stillschweigend mit 0 Workern abzuschliessen.
const MAX_COORDINATOR_ATTEMPTS = 2;

async function runHive({ config, task, coordinatorRole, workerRoles, buildToolDefinitions, onAgentStart, onChunk, onWorkerStart, onWorkerDone, onFileToolCall, onRetry, onEmptyTurn = () => {}, onCoordinatorRetry = () => {}, onModelSwap = () => {}, projectContext = null, runId = trace.newRunId() }) {
  trace.logEvent(runId, 'hive_start', { task: task.slice(0, 300), maxDepth: effectiveHiveDepth(config) });
  const dispatchTool = buildDispatchTool(workerRoles);
  // Coordinator bekommt volle Datei-Tools (er delegiert primaer, kann aber selbst nachschauen).
  const fileTools = buildToolDefinitions(config.projectRoot);

  let dispatchHappened = false;
  let result = null;
  // Eindeutige ID pro Worker-INSTANZ (nicht pro Rollenname!) -- derselbe Rollenname (z.B.
  // "coder") kann in einem einzigen dispatch_agents-Aufruf mehrfach gleichzeitig vorkommen
  // (mehrere Teilaufgaben an dieselbe Rolle), ueber Verschachtelungsebenen hinweg erneut
  // auftauchen, oder ueber einen Coordinator-Neustart hinweg erneut auftauchen. Ein Aufrufer
  // (index.js), der z.B. einen Wartesymbol-Timer pro Worker fuehrt, braucht dafuer einen
  // Schluessel, der NICHT einfach role.name ist -- sonst ueberschreibt eine zweite gleichnamige
  // Rolle den Timer-Handle der ersten, ohne ihn zu stoppen (Leak: der alte Timer laeuft fuer
  // immer weiter). Als Objekt (nicht primitive Zahl) durchgereicht, damit runWorkerNode den
  // Zaehler ueber beliebig viele Verschachtelungsebenen hinweg per Referenz weiterzaehlen kann.
  const counter = { n: 0 };

  let lastEffectiveModel = coordinatorRole.model;
  for (let attempt = 1; attempt <= MAX_COORDINATOR_ATTEMPTS && !dispatchHappened; attempt++) {
    // pickEffectiveModel VOR onAgentStart, damit die "=== Rolle (Modell) ==="-Kopfzeile das
    // TATSAECHLICH verwendete (evtl. per Selbstdiagnose ersetzte) Modell zeigt -- vorher zeigte
    // sie immer coordinatorRole.model, selbst wenn direkt danach ein [Modell-Wechsel] auf ein
    // anderes Modell folgte (verwirrend: Kopfzeile und Wechsel-Hinweis widersprachen sich).
    const effectiveModel = pickEffectiveModel(coordinatorRole, onModelSwap, runId);
    lastEffectiveModel = effectiveModel;
    onAgentStart({ ...coordinatorRole, model: effectiveModel });

    const coordinatorConfig = { ...config, activeModel: effectiveModel };
    const coordinatorMessages = [
      { role: 'system', content: coordinatorRole.systemPrompt },
      fableSystemMessage(),
      ...(projectContext ? [{ role: 'system', content: projectContext }] : []),
      { role: 'user', content: `Team-Aufgabe: ${task}` },
    ];
    if (attempt > 1) {
      onCoordinatorRetry(attempt);
      coordinatorMessages.push({
        role: 'user',
        content: 'Hinweis: der vorherige Versuch hat KEINEN einzigen Worker per dispatch_agents gestartet (z.B. durch einen voruebergehenden Server-Fehler mittendrin beendet). Rufe jetzt tatsaechlich dispatch_agents auf und verteile die Aufgabe an Worker.',
      });
    }

    let coordinatorToolCallHappened = false;
    let coordinatorRetries = 0;
    const startMs = Date.now();
    try {
      result = await sendChat({
        config: coordinatorConfig,
        messages: coordinatorMessages,
        tools: [dispatchTool, ...fileTools],
        onChunk,
        onRetry: (...a) => { coordinatorRetries++; onRetry(...a); },
        onToolCall: async (toolCall) => {
          coordinatorToolCallHappened = true;
          if (toolCall.function.name !== 'dispatch_agents') {
            return onFileToolCall(toolCall);
          }
          let args;
          try {
            args = JSON.parse(toolCall.function.arguments || '{}');
          } catch {
            return 'FEHLER: dispatch_agents Argumente nicht parsebar.';
          }
          const assignments = Array.isArray(args.assignments) ? args.assignments.slice(0, MAX_ASSIGNMENTS_PER_DISPATCH) : [];
          if (!assignments.length) {
            return 'FEHLER: keine gueltigen assignments uebergeben.';
          }
          dispatchHappened = true;
          trace.logEvent(runId, 'coordinator_dispatch', { assignments: assignments.map((a) => a.role) });

          const outcomes = await Promise.all(
            assignments.map((a) => {
              const role = workerRoles.find((r) => r.name === a.role);
              if (!role) return Promise.resolve({ role: a.role, label: a.role, error: `Rolle "${a.role}" nicht gefunden.` });
              return runWorkerNode({ config, role, task: a.task, depth: 1, workerRoles, buildToolDefinitions, onWorkerStart, onWorkerDone, onFileToolCall, onRetry, projectContext, counter, onModelSwap, runId });
            })
          );

          return outcomes
            .map((o) => (o.error ? `[${o.label}] FEHLER: ${o.error}` : `[${o.label}] ${o.text}`))
            .join('\n\n');
        },
        maxRetries: SWARM_MAX_RETRIES,
        maxTokens: SWARM_MAX_TOKENS,
        runId,
      });
      // ponytail: Bug, den dieser genaue Log-Ausschnitt aufgedeckt hat -- eine leere Antwort
      // (kein Text, kein Tool-Aufruf, aber sendChat wirft KEINEN Fehler -- HTTP 200 mit leerem
      // Content) wurde bisher als "errored: false" gewertet. Ein Modell, das zuverlaessig leer
      // statt mit einem echten Fehler antwortet, wurde dadurch NIE als unhealthy diagnostiziert
      // (0 Fehler in den Stats) und immer wieder als "Ersatz" gewaehlt -- genau das ist hier
      // passiert: kimi-k2.6 wurde als Ersatz fuer das langsame deepseek-v4 gewaehlt, lieferte
      // zweimal in Folge nichts, wurde aber trotzdem nicht als kaputt erkannt. Fix: leere
      // Antworten zaehlen jetzt als Fehler fuer die Selbstdiagnose (nicht fuer isRetryable in
      // providers.js -- das bleibt ein reines Diagnose-Signal fuer die NAECHSTE Modellwahl).
      const isEmpty = !result.finalText.trim() && !coordinatorToolCallHappened;
      recordAttempt(effectiveModel, {
        retries: coordinatorRetries,
        errored: isEmpty,
        durationMs: Date.now() - startMs,
        errorMessage: isEmpty ? 'leere Antwort (kein Text, kein Tool-Aufruf)' : '',
      });
      if (isEmpty) onEmptyTurn(coordinatorRole, describeEmptyTurn(result));
    } catch (err) {
      // Nicht die ganze Hive abbrechen -- als leerer Zug behandeln (loest im naechsten
      // Versuch automatisch einen Modell-Wechsel aus, falls das Muster sich wiederholt).
      recordAttempt(effectiveModel, { retries: coordinatorRetries, errored: true, durationMs: Date.now() - startMs, errorMessage: err.message || String(err) });
      result = { finalText: '', usage: null, provider: '', model: effectiveModel };
      onEmptyTurn(coordinatorRole);
    }
  }

  result.dispatchHappened = dispatchHappened;
  result.runId = runId;
  result.lastModel = lastEffectiveModel;
  trace.logEvent(runId, 'hive_done', { dispatchHappened });
  return result;
}

// ponytail: Deckel gegen endloses Hin-und-Her-Pingpong (z.B. zwei Rollen, die sich
// gegenseitig staendig neue Nachrichten schicken) -- mehr als das 3-fache der Rollenzahl
// an Gesamt-Zuegen wird abgebrochen statt unbegrenzt weiterzulaufen.
function maxTotalTurns(roleCount) {
  return Math.max(roleCount * 3, 6);
}

// Turn-Queue statt starrer for-Schleife: jede Rolle startet zwar in der konfigurierten
// Reihenfolge, aber wer waehrend eines FREMDEN Zugs per send_message neue Post bekommt,
// wird erneut in die Queue eingereiht -- auch wenn die eigene Runde laengst vorbei war
// (Ruecksprache: Reviewer kann den Coder z.B. nochmal ansprechen, Coder bekommt dann
// tatsaechlich einen weiteren Zug, statt dass die Nachricht ungelesen verpufft).
// buildToolDefinitions/onFileToolCall kommen vom Aufrufer (index.js), damit swarm.js nichts
// ueber Pfad-Sandboxing oder die Bestaetigungs-UI wissen muss.
async function runSwarm({ config, task, roles, buildToolDefinitions, onAgentStart, onChunk, onNotice, onFileToolCall, onRetry, onEmptyTurn = () => {}, onModelSwap = () => {}, projectContext = null, runId = trace.newRunId() }) {
  trace.logEvent(runId, 'swarm_start', { task: task.slice(0, 300), roles: roles.map((r) => r.name) });
  const transcript = [{ role: 'user', content: `Team-Aufgabe: ${task}` }];
  const mailbox = {};
  const turnQueue = [...roles];
  const cap = maxTotalTurns(roles.length);
  let turnsRun = 0;

  while (turnQueue.length && turnsRun < cap) {
    const role = turnQueue.shift();
    turnsRun++;
    // pickEffectiveModel VOR onAgentStart, damit die Anzeige das TATSAECHLICH verwendete
    // (evtl. per Selbstdiagnose ersetzte) Modell zeigt statt immer role.model.
    const effectiveModel = pickEffectiveModel(role, onModelSwap, runId);
    onAgentStart({ ...role, model: effectiveModel });

    const pending = mailbox[role.name] || [];
    mailbox[role.name] = [];

    const styleMsg = styleSystemMessage(config.style);
    const roleMessages = [
      { role: 'system', content: role.systemPrompt },
      fableSystemMessage(),
      ...(projectContext ? [{ role: 'system', content: projectContext }] : []),
      ...(styleMsg ? [styleMsg] : []),
      ...transcript,
      ...pending.map((m) => ({ role: 'user', content: speakerTag(`Nachricht von ${m.from}`, m.content) })),
      { role: 'user', content: `Du bist jetzt am Zug (Rolle: ${role.label}). Nutze die Datei-Tools falls fuer deine Rolle noetig.` },
    ];

    const roleConfig = { ...config, activeModel: effectiveModel };
    const tools = [...buildToolDefinitions(config.projectRoot, { readOnly: role.readOnly }), SEND_MESSAGE_TOOL];
    trace.logEvent(runId, 'turn_start', { role: role.name, model: effectiveModel });

    let finalText = '';
    let toolCallHappened = false;
    let roleRetries = 0;
    const wakeups = new Set();
    const startMs = Date.now();
    let chatResult = null;
    try {
      chatResult = await sendChat({
        config: roleConfig,
        messages: roleMessages,
        tools,
        onChunk: (delta) => {
          finalText += delta;
          onChunk(delta);
        },
        onRetry: (...a) => { roleRetries++; onRetry(...a); },
        onToolCall: async (toolCall) => {
          toolCallHappened = true;
          if (toolCall.function.name === 'send_message') {
            let args;
            try {
              args = JSON.parse(toolCall.function.arguments || '{}');
            } catch {
              return 'FEHLER: send_message Argumente nicht parsebar.';
            }
            if (!mailbox[args.to]) mailbox[args.to] = [];
            mailbox[args.to].push({ from: role.name, content: args.content });
            wakeups.add(args.to);
            onNotice(`${role.label} -> ${args.to}: ${args.content}`);
            return `OK: Nachricht an ${args.to} eingereiht.`;
          }
          return onFileToolCall(toolCall);
        },
        maxRetries: SWARM_MAX_RETRIES,
        maxTokens: SWARM_MAX_TOKENS,
        runId,
      });
      // Leere Antwort (kein Text, kein Tool-Aufruf, aber kein geworfener Fehler) zaehlt jetzt
      // als Fehler fuer die Selbstdiagnose -- sonst wird ein Modell, das zuverlaessig leer
      // statt mit echtem Fehler antwortet, nie als unhealthy erkannt.
      const isEmptyTurn = !finalText.trim() && !toolCallHappened;
      recordAttempt(effectiveModel, {
        retries: roleRetries,
        errored: isEmptyTurn,
        durationMs: Date.now() - startMs,
        errorMessage: isEmptyTurn ? 'leere Antwort (kein Text, kein Tool-Aufruf)' : '',
      });
      trace.logEvent(runId, 'turn_done', { role: role.name, model: effectiveModel, durationMs: Date.now() - startMs });
    } catch (err) {
      // Nicht den ganzen Schwarm abbrechen -- als leerer Zug behandeln, Diagnose merkt sich
      // den Fehlschlag (fuehrt bei Wiederholung zum automatischen Modell-Wechsel).
      recordAttempt(effectiveModel, { retries: roleRetries, errored: true, durationMs: Date.now() - startMs, errorMessage: err.message || String(err) });
      trace.logEvent(runId, 'turn_error', { role: role.name, model: effectiveModel, error: err.message || String(err) });
      finalText = '';
      toolCallHappened = false;
    }

    if (!finalText.trim() && !toolCallHappened) {
      trace.logEvent(runId, 'empty_turn', { role: role.name, model: effectiveModel, finishReason: chatResult?.finishReason, reasoningChars: chatResult?.reasoningChars });
      onEmptyTurn(role, describeEmptyTurn(chatResult));
    }

    transcript.push({ role: 'assistant', content: speakerTag(role.label, finalText) });

    for (const name of wakeups) {
      const wakeRole = roles.find((r) => r.name === name);
      if (wakeRole && !turnQueue.includes(wakeRole)) turnQueue.push(wakeRole);
    }
  }

  if (turnsRun >= cap && turnQueue.length) {
    onNotice(`Zug-Limit (${cap}) erreicht -- Schwarm beendet, obwohl noch Nachrichten offen waren.`);
  }

  trace.logEvent(runId, 'swarm_done', { turnsRun });
  transcript.runId = runId; // Arrays sind Objekte -- zusaetzliches Feld stoert Index/length/Iteration nicht.
  return transcript;
}

// Hive-Mind-Konsens (Ruflo-Vorbild, vereinfacht auf 3 unabhaengige Read-only-Stimmen statt
// vollem Byzantine-Konsens): nach einem erfolgreichen Hive-Lauf bewerten 3 unabhaengige,
// PARALLELE Modell-Aufrufe (kein Panel-Teilnehmer der eigentlichen Arbeit, gegen Selbst-
// Bevorzugung) die tatsaechlich veraenderten Dateien und stimmen FERTIG/NACHBESSERUNG ab.
// Nur Lese-Tools (buildToolDefinitions mit readOnly:true) -- ein Richter darf nichts aendern.
const CONSENSUS_JUDGE_MODELS = ['deepseek-v4', 'qwen-397b', 'kimi-k2.6'];

async function runConsensusCheck({ config, task, files, buildToolDefinitions, onFileToolCall, onRetry, runId = null }) {
  const filesList = files.length ? files.join(', ') : '(keine Dateien erkannt)';
  const prompt =
    `Aufgabe war: ${task}\n\nFolgende Dateien wurden in diesem Lauf veraendert: ${filesList}\n\n` +
    'Pruefe sie (list_directory/read_file) und entscheide, ob die Aufgabe FERTIG ist oder noch ' +
    'NACHBESSERUNG braucht. Antworte in der ERSTEN Zeile nur mit genau einem Wort: FERTIG oder ' +
    'NACHBESSERUNG. Danach in maximal 2 Saetzen die Begruendung.';

  const votes = await Promise.all(
    CONSENSUS_JUDGE_MODELS.map(async (modelKey) => {
      const judgeConfig = { ...config, activeModel: modelKey };
      let text = '';
      try {
        await sendChat({
          config: judgeConfig,
          messages: [{ role: 'user', content: prompt }],
          tools: buildToolDefinitions(config.projectRoot, { readOnly: true }),
          onChunk: (d) => { text += d; },
          onToolCall: onFileToolCall,
          onRetry,
          maxRetries: SWARM_MAX_RETRIES,
          maxTokens: SWARM_MAX_TOKENS,
          runId,
        });
      } catch (err) {
        text = `NACHBESSERUNG\n(Fehler beim Bewerten: ${err.message || err})`;
      }
      const firstLine = (text.trim().split('\n')[0] || '').toUpperCase();
      const verdict = firstLine.includes('FERTIG') && !firstLine.includes('NACHBESSER') ? 'FERTIG' : 'NACHBESSERUNG';
      trace.logEvent(runId, 'consensus_vote', { model: modelKey, verdict });
      return { model: modelKey, verdict, reason: text.trim() || '(keine Begruendung geliefert)' };
    })
  );

  const approvals = votes.filter((v) => v.verdict === 'FERTIG').length;
  return { approved: approvals >= 2, votes };
}

module.exports = { runSwarm, runHive, runConsensusCheck, SEND_MESSAGE_TOOL, recommendHiveDepth, effectiveHiveDepth };
