'use strict';

const { sendChat } = require('./providers');
const { styleSystemMessage } = require('./styles');
const { fableSystemMessage } = require('./fable');

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

// Ruflo-Vorbild (nested-coordinator): 2-stufige Hives -- ein Worker, den der Top-Coordinator
// dispatcht (Tiefe 1), bekommt SELBST ebenfalls das dispatch_agents-Tool und kann seine
// Teilaufgabe nochmal in kleinere Stuecke zerlegen. Tiefe 2 (von einem Tiefe-1-Worker
// dispatchte Worker) bekommt das Tool NICHT MEHR -- reiner Leaf-Worker. Bewusst kleiner als
// Ruflos Tiefe 5, um Kosten/Laufzeit nicht explodieren zu lassen. MAX_ASSIGNMENTS_PER_DISPATCH
// gilt pro Dispatch-Aufruf auf JEDER Ebene (kein zusaetzlicher Multiplikator-Deckel noetig,
// da jede Ebene schon einzeln gedeckelt ist).
const MAX_HIVE_DEPTH = 2;

// Ein einzelner Worker-Knoten im (moeglicherweise verschachtelten) Hive-Baum. `depth` zaehlt
// von 1 (direkt vom Top-Coordinator dispatcht) aufwaerts. `counter` ist ein ueber den GANZEN
// Baum geteiltes { n } Objekt (per Referenz durchgereicht) -- liefert eindeutige Worker-IDs
// (nicht nur pro Rollenname, siehe Kommentar bei workerSeq weiter unten) auch ueber mehrere
// Verschachtelungsebenen hinweg.
async function runWorkerNode({ config, role, task, depth, workerRoles, buildToolDefinitions, onWorkerStart, onWorkerDone, onFileToolCall, onRetry, projectContext, counter }) {
  const workerId = `${role.name}#${counter.n++}`;
  onWorkerStart(role, task, workerId);
  const workerConfig = { ...config, activeModel: role.model };
  const baseTools = buildToolDefinitions(config.projectRoot, { readOnly: role.readOnly });
  const canSubDispatch = depth < MAX_HIVE_DEPTH;
  const dispatchTool = canSubDispatch ? buildDispatchTool(workerRoles) : null;
  const tools = dispatchTool ? [dispatchTool, ...baseTools] : baseTools;

  let text = '';
  let toolCallHappened = false;
  try {
    await sendChat({
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
              return runWorkerNode({ config, role: subRole, task: a.task, depth: depth + 1, workerRoles, buildToolDefinitions, onWorkerStart, onWorkerDone, onFileToolCall, onRetry, projectContext, counter });
            })
          );
          return subOutcomes
            .map((o) => (o.error ? `[${o.label}] FEHLER: ${o.error}` : `[${o.label}] ${o.text}`))
            .join('\n\n');
        }
        return onFileToolCall(toolCall);
      },
      onRetry,
    });
    if (!text.trim() && !toolCallHappened) {
      const warning = 'LEER: Modell hat weder Text noch Tool-Aufrufe geliefert (moeglicher Modell-Aussetzer).';
      onWorkerDone(role, text, warning, workerId);
      return { role: role.name, label: role.label, error: warning };
    }
    onWorkerDone(role, text, null, workerId);
    return { role: role.name, label: role.label, text };
  } catch (err) {
    const message = err.message || String(err);
    onWorkerDone(role, '', message, workerId);
    return { role: role.name, label: role.label, error: message };
  }
}

// Coordinator-gefuehrter Schwarm (ruflo-swarm:coordinator-Vorbild): EIN Coordinator-Modell
// zerlegt die Aufgabe und dispatcht per Tool-Call an beliebig viele Worker-Rollen PARALLEL
// (Promise.all -- echte gleichzeitige HTTP-Requests, kein sequenzielles Abarbeiten). Jeder
// dispatchte Worker kann seinerseits nochmal dispatchen (siehe runWorkerNode/MAX_HIVE_DEPTH).
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

async function runHive({ config, task, coordinatorRole, workerRoles, buildToolDefinitions, onAgentStart, onChunk, onWorkerStart, onWorkerDone, onFileToolCall, onRetry, onEmptyTurn = () => {}, onCoordinatorRetry = () => {}, projectContext = null }) {
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

  for (let attempt = 1; attempt <= MAX_COORDINATOR_ATTEMPTS && !dispatchHappened; attempt++) {
    onAgentStart(coordinatorRole);

    const coordinatorConfig = { ...config, activeModel: coordinatorRole.model };
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
    result = await sendChat({
      config: coordinatorConfig,
      messages: coordinatorMessages,
      tools: [dispatchTool, ...fileTools],
      onChunk,
      onRetry,
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

        const outcomes = await Promise.all(
          assignments.map((a) => {
            const role = workerRoles.find((r) => r.name === a.role);
            if (!role) return Promise.resolve({ role: a.role, label: a.role, error: `Rolle "${a.role}" nicht gefunden.` });
            return runWorkerNode({ config, role, task: a.task, depth: 1, workerRoles, buildToolDefinitions, onWorkerStart, onWorkerDone, onFileToolCall, onRetry, projectContext, counter });
          })
        );

        return outcomes
          .map((o) => (o.error ? `[${o.label}] FEHLER: ${o.error}` : `[${o.label}] ${o.text}`))
          .join('\n\n');
      },
    });

    if (!result.finalText.trim() && !coordinatorToolCallHappened) {
      onEmptyTurn(coordinatorRole);
    }
  }

  result.dispatchHappened = dispatchHappened;
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
async function runSwarm({ config, task, roles, buildToolDefinitions, onAgentStart, onChunk, onNotice, onFileToolCall, onRetry, onEmptyTurn = () => {}, projectContext = null }) {
  const transcript = [{ role: 'user', content: `Team-Aufgabe: ${task}` }];
  const mailbox = {};
  const turnQueue = [...roles];
  const cap = maxTotalTurns(roles.length);
  let turnsRun = 0;

  while (turnQueue.length && turnsRun < cap) {
    const role = turnQueue.shift();
    turnsRun++;
    onAgentStart(role);

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

    const roleConfig = { ...config, activeModel: role.model };
    const tools = [...buildToolDefinitions(config.projectRoot, { readOnly: role.readOnly }), SEND_MESSAGE_TOOL];

    let finalText = '';
    let toolCallHappened = false;
    const wakeups = new Set();
    await sendChat({
      config: roleConfig,
      messages: roleMessages,
      tools,
      onChunk: (delta) => {
        finalText += delta;
        onChunk(delta);
      },
      onRetry,
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
    });

    if (!finalText.trim() && !toolCallHappened) {
      onEmptyTurn(role);
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

  return transcript;
}

module.exports = { runSwarm, runHive, SEND_MESSAGE_TOOL };
