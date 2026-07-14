#!/usr/bin/env node
'use strict';

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { PROVIDERS, MODEL_PRESETS, loadConfig, saveConfig, sendChat, resolveTarget, CONFIG_PATH } = require('./providers');
const { isExhausted: isKeyExhausted } = require('./keyPool');
const { listHealth, resetHealth } = require('./modelHealth');
const { buildToolDefinitions: buildFileTools, WRITE_TOOLS, executeTool, undoLastWrite, previewDiff } = require('./tools');
const { buildShellToolDefinitions, runCommand, readBackgroundOutput, checkDangerous, SHELL_WRITE_TOOLS, resetCwd } = require('./shell');
const { AGENTS_DIR, loadAgentRoles, loadPipelineOrder } = require('./agents');
const { runSwarm, runHive, runConsensusCheck, recommendHiveDepth, effectiveHiveDepth } = require('./swarm');
const { STYLES, styleSystemMessage } = require('./styles');
const { EFFORT_LEVELS, effortMaxTokens, effortSystemMessage } = require('./effort');
const { MCPClient, mcpToolDefinitions, isMcpTool, parseMcpTool } = require('./mcp');
const { loadCustomCommand, listCustomCommands, renderCommand } = require('./commands');
const { scanForInjection, appendAuditLog } = require('./permissions');
const { fableSystemMessage } = require('./fable');
const { PROJECT_MEMORY_FILENAME, loadProjectMemory, appendProjectMemory, searchProjectMemory } = require('./memory');
const trace = require('./trace');

const AUDIT_LOG_PATH = path.join(path.dirname(CONFIG_PATH), 'audit.log');

// Crash-Schutz: ohne das killt Node den GESAMTEN CLI-Prozess bei jedem unabgefangenen Fehler
// (z.B. ein voruebergehender ENOTCONN beim Spawnen eines Kindprozesses in shell.js -- ein
// bekannter, seltener Windows/Node-Bug, kein Fehler in unserem Code). Bei einem mehrstuendigen
// Hive-Lauf darf ein einzelner solcher Ausreisser nicht die ganze Sitzung beenden. Node warnt
// zurecht, dass der Prozesszustand nach uncaughtException technisch undefiniert sein kann --
// hier bewusst in Kauf genommen, weil die Alternative (kompletter Absturz mitten in einem
// Multi-Agent-Lauf) fuer dieses Tool schlimmer ist.
process.on('uncaughtException', (err) => {
  console.log(`\n${ANSI.error}[Unerwarteter Fehler] ${err && err.message ? err.message : err} -- CLI laeuft weiter.${ANSI.reset}`);
});
process.on('unhandledRejection', (err) => {
  console.log(`\n${ANSI.error}[Unerwarteter Fehler] ${err && err.message ? err.message : err} -- CLI laeuft weiter.${ANSI.reset}`);
});

const mcpClients = new Map();

// Kombiniert Datei-Tools + Shell-Tool zu einer Liste, wie sie an sendChat/runSwarm/runHive
// gereicht wird. readOnly-Rollen (z.B. Explorer) bekommen KEIN run_command -- beliebige
// Shell-Befehle sind das Gegenteil von "read-only", egal wie harmlos der Befehlstext aussieht.
function buildToolDefinitions(root, opts) {
  const fileTools = buildFileTools(root, opts);
  if (opts && opts.readOnly) return fileTools;
  const mcpTools = [...mcpClients.values()].flatMap((c) => mcpToolDefinitions(c));
  return [...fileTools, ...buildShellToolDefinitions(root), ...mcpTools];
}

// Einfache Marker-Datei-Erkennung (kein AST/Deep-Scan) -- reicht, um beim Start grob
// einzuordnen, in welchem Projekt-Typ man sich befindet.
const PROJECT_MARKERS = [
  { file: 'package.json', label: 'Node/JavaScript/TypeScript' },
  { file: 'requirements.txt', label: 'Python' },
  { file: 'pyproject.toml', label: 'Python' },
  { file: 'go.mod', label: 'Go' },
  { file: 'Cargo.toml', label: 'Rust' },
  { file: 'pom.xml', label: 'Java (Maven)' },
  { file: 'build.gradle', label: 'Java/Kotlin (Gradle)' },
  { file: 'Gemfile', label: 'Ruby' },
  { file: 'composer.json', label: 'PHP' },
];

function detectProjectType(root) {
  const hits = PROJECT_MARKERS.filter((m) => fs.existsSync(path.join(root, m.file)));
  const csproj = fs.existsSync(root) && fs.readdirSync(root).some((f) => f.endsWith('.csproj'));
  if (csproj) hits.push({ label: 'C#/.NET' });
  return [...new Set(hits.map((h) => h.label))];
}

// ponytail: einfache Baum-Zusammenfassung (Ordner + Datei-Anzahl pro Endung), kein
// semantisches Architektur-Verstehen -- reicht als schneller Ueberblick vor dem eigentlichen
// Arbeiten. Schwere Ordner (node_modules/.git/etc.) werden uebersprungen, sonst dauert das
// ewig und die Zahlen sind nutzlos (tausende node_modules-Dateien dominieren jede Statistik).
const CODEMAP_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv']);

function buildCodemap(root) {
  const extCounts = new Map();
  const topLevel = [];
  let totalFiles = 0;

  function walk(dir, depth) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (CODEMAP_SKIP_DIRS.has(e.name)) continue;
        if (depth === 0) topLevel.push(`${e.name}/`);
        walk(path.join(dir, e.name), depth + 1);
      } else {
        if (depth === 0) topLevel.push(e.name);
        totalFiles++;
        const ext = path.extname(e.name) || '(ohne Endung)';
        extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
      }
    }
  }
  walk(root, 0);

  const extLines = [...extCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([ext, count]) => `  ${ext.padEnd(16)} ${count}`);

  const graphifyInsights = extractGraphifyInsights(root);

  return [
    `Wurzel: ${root}`,
    `Top-Level: ${topLevel.join(', ') || '(leer)'}`,
    `Dateien gesamt: ${totalFiles} (node_modules/.git/dist/build/__pycache__/venv uebersprungen)`,
    'Nach Endung:',
    ...extLines,
    ...(graphifyInsights ? ['', '--- graphify-Erkenntnisse (graphify-out/GRAPH_REPORT.md gefunden) ---', graphifyInsights] : []),
  ].join('\n');
}

// Auf Nutzerwunsch (offener Punkt aus der ersten Verbesserungsrunde, "Selbst-Wissen nutzen"):
// falls dieses Projekt schonmal per /graphify analysiert wurde, die God-Nodes-Sektion des
// Reports mit in /codemap einblenden -- zeigt auf einen Blick, welche Dateien/Funktionen am
// staerksten gekoppelt sind, ohne dass graphify (separates, schwereres Skill) erneut laufen
// muss. Rein optional: existiert kein Report, bleibt /codemap unveraendert wie bisher.
function extractGraphifyInsights(root) {
  let lines;
  try {
    lines = fs.readFileSync(path.join(root, 'graphify-out', 'GRAPH_REPORT.md'), 'utf-8').split('\n');
  } catch {
    return null;
  }
  const startIdx = lines.findIndex((l) => /god nodes/i.test(l));
  if (startIdx === -1) return null;
  return lines.slice(startIdx, startIdx + 13).join('\n').trim();
}

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  accent: '\x1b[38;2;217;119;87m',
  error: '\x1b[38;2;229;72;77m',
  bold: '\x1b[1m',
};

let config = loadConfig();

// Sitzungs-Wiederaufnahme: Verlauf landet nach jeder Nachricht auf der Platte und wird beim
// naechsten Start automatisch geladen -- /new loescht ihn wieder explizit. Nur der Einzel-Chat-
// Verlauf wird persistiert, Swarm/Hive-Transkripte sind pro Lauf ohnehin fluechtig.
const SESSION_PATH = path.join(path.dirname(CONFIG_PATH), 'session.json');

function loadSession() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSession(msgs) {
  try {
    fs.writeFileSync(SESSION_PATH, JSON.stringify(msgs), 'utf-8');
  } catch {
    /* Session-Persistenz ist ein Komfortfeature, kein Fehlerfall wert */
  }
}

// Statt beim /new einfach zu loeschen: ins Archiv verschieben, damit /history search
// spaetere Sitzungen durchsuchen kann.
const SESSIONS_DIR = path.join(path.dirname(CONFIG_PATH), 'sessions');

function archiveSession() {
  if (!fs.existsSync(SESSION_PATH)) return;
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(SESSION_PATH, path.join(SESSIONS_DIR, `${stamp}.json`));
  } catch {
    /* Archivierung ist ein Komfortfeature, kein Fehlerfall wert */
  }
}

// CLAUDE.md-Aequivalent: wird einmal beim Start geladen und als zusaetzliche System-Nachricht
// injiziert (nur Einzel-Chat -- Swarm/Hive-Rollen haben bereits eigene, spezifische Prompts).
const PROJECT_INSTRUCTIONS_FILENAME = 'NEMOTRON.md';

function loadProjectInstructions(root) {
  try {
    return fs.readFileSync(path.join(root, PROJECT_INSTRUCTIONS_FILENAME), 'utf-8');
  } catch {
    return null;
  }
}

// Kombiniert NEMOTRON.md (nutzer-verfasst) + AGENTS_MEMORY.md (vom Tool selbst nach jedem
// erfolgreichen Lauf geschrieben) zu EINER System-Nachricht -- fuer Einzel-Chat UND fuer
// Swarm/Hive/Agent-Rollen (die bekommen sie als projectContext durchgereicht). Loest das
// Problem, dass ein Modellwechsel nach einem Hive-Lauf vorher nichts vom Projekt wusste.
// `task` optional: wird eine Aufgabenbeschreibung mitgegeben, werden per searchProjectMemory
// (TF-IDF-artige Stichwortsuche, memory.js) nur die dazu passenden Eintraege ausgewaehlt statt
// immer der GESAMTE Speicher bis zur Zeichen-Grenze -- relevanter UND kuerzer (weniger Tokens/
// Kosten pro Zug) bei wachsender Projekt-Historie. Ohne task (z.B. beim allerersten Aufruf vor
// der ersten Nutzernachricht) faellt es auf den vollen Speicher zurueck.
function buildAgentContext(root, task = '') {
  const instructions = loadProjectInstructions(root);
  const memory = task ? searchProjectMemory(root, task) : loadProjectMemory(root);
  const parts = [];
  if (instructions) parts.push(`Projekt-Instruktionen (${PROJECT_INSTRUCTIONS_FILENAME}):\n${instructions}`);
  if (memory) parts.push(`Relevante bisherige Agent-Aktivitaet in diesem Projekt (${PROJECT_MEMORY_FILENAME}):\n${memory}`);
  return parts.length ? parts.join('\n\n---\n\n') : null;
}

// Einfache JSON-Datei-backed Aufgabenliste (kein DB-Overhead fuer ein Ein-Personen-Tool).
const TODO_PATH = path.join(path.dirname(CONFIG_PATH), 'todo.json');

function loadTodos() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TODO_PATH, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveTodos(todos) {
  fs.writeFileSync(TODO_PATH, JSON.stringify(todos, null, 2), 'utf-8');
}

let messages = loadSession();

// Token-Nutzung: nur befuellt, wenn der Provider stream_options.include_usage honoriert
// (die meisten OpenAI-kompatiblen Endpunkte tun das) -- sonst bleibt usage null und wird
// stillschweigend uebersprungen statt NaN anzuzeigen.
const sessionUsage = { promptTokens: 0, completionTokens: 0, calls: 0 };

function addUsage(usage) {
  if (!usage) return;
  sessionUsage.promptTokens += usage.prompt_tokens || 0;
  sessionUsage.completionTokens += usage.completion_tokens || 0;
  sessionUsage.calls += 1;
}

// Auf Nutzerwunsch: /usage zaehlte bisher NUR Einzel-Chat, Swarm/Hive/Agent-Zuege fehlten
// komplett (dokumentierte Luecke, siehe README). runSwarm/runHive summieren ihre eigenen
// Zuege bereits in einem usageTotals-Objekt (swarm.js) -- hier nur noch einmal draufaddieren,
// statt jeden einzelnen verschachtelten Zug separat durchzureichen.
function addUsageTotals(totals) {
  if (!totals || !totals.calls) return;
  sessionUsage.promptTokens += totals.promptTokens;
  sessionUsage.completionTokens += totals.completionTokens;
  sessionUsage.calls += totals.calls;
}

// Auf Nutzerwunsch ("Modelle machen haeufig dieselben Fehler, sprechen sich wenig ab"):
// swarm.js' mistakeLog (leere/fehlgeschlagene Zuege innerhalb EINES Laufs) wird dedupliziert
// und in AGENTS_MEMORY.md als Lektion gespeichert -- damit ein KUENFTIGER Lauf (auch in einer
// neuen Session oder dem naechsten /hive loop-Durchlauf) beim Start bereits weiss, was schon
// schiefging, statt es blind zu wiederholen.
function formatLessons(mistakeLog) {
  if (!mistakeLog || !mistakeLog.length) return undefined;
  const seen = new Set();
  const lessons = [];
  for (const m of mistakeLog) {
    const line = `${m.who}: ${m.what}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lessons.push(line);
  }
  return lessons.slice(-10);
}

// Scope-Warnung: reine Beobachtung, kein Blocker -- viele veraenderte Dateien in einer
// Sitzung sind oft ein Zeichen, dass die Aufgabe aus dem Ruder laeuft (nach demselben Muster
// wie die GateGuard-Hooks in diesem Repo selbst).
const touchedFiles = new Set();
const SCOPE_WARNING_THRESHOLD = 15;
let scopeWarningShown = false;

// Kurz-/Langtext pro Befehl fuer /help -- ersetzt die vorher einzige lange Banner-Zeile.
// Bei ueberlappend wirkenden Befehlen (agent/swarm/team, provider/baseurl) steht der
// Unterschied explizit im Langtext, statt den Befehl zu streichen (Redundanz-Audit-Ergebnis:
// kein Befehl ist tatsaechlich ueberfluessig, siehe README).
const COMMAND_HELP = {
  models: { short: 'Verfuegbare Modell-Presets auflisten', long: 'Zeigt alle vordefinierten Presets (Provider + Modell-ID). Fuer alles ausserhalb der Presets: /model <eigene-id> + /provider <name>.' },
  model: { short: 'Aktives Modell wechseln oder Presets anzeigen', long: '/model <preset-oder-id> setzt das aktive Modell. Ohne Argument: gleich wie /models.' },
  recommend: { short: 'Modell-Empfehlung fuer eine Aufgabe', long: 'Keyword-Heuristik (kein gelerntes Routing) -- schlaegt anhand der Aufgabenbeschreibung ein passendes Preset vor. /model <preset> uebernimmt die Empfehlung.' },
  fallback: { short: 'Zweitmodell fuer Fehlerfaelle setzen', long: 'Wird nur genutzt, wenn das Hauptmodell nach allen Retries weiter fehlschlaegt (Einzel-Chat). /fallback off deaktiviert.' },
  provider: { short: 'Anbieter fuer nicht-Preset-Modelle waehlen', long: 'Wirkt nur, wenn /model eine eigene Modell-ID (kein Preset) gesetzt hat. Fuer Custom-Endpunkte reicht meist direkt /baseurl (setzt Provider automatisch mit).' },
  setkey: { short: 'API-Key fuer einen Anbieter speichern (ersetzt ALLE bisherigen)', long: '/setkey <openrouter|nim|ollama> <key>. Ersetzt die komplette Key-Liste dieses Anbieters durch genau diesen einen Key. Zum Hinzufuegen (mehrere Accounts fuer parallele Projekte) stattdessen /addkey nutzen.' },
  addkey: { short: 'Weiteren API-Key fuer einen Anbieter hinzufuegen', long: '/addkey <openrouter|nim|ollama> <key>. Ist ein Key limitiert (429/Kontingent), wechselt sendChat automatisch zum naechsten in der Liste -- nuetzlich, wenn mehrere Projekte/CLI-Instanzen parallel laufen und ein Account an sein Limit stoesst. Cooldown-Status je Key: /keys.' },
  removekey: { short: 'Einen bestimmten API-Key wieder entfernen', long: '/removekey <provider> <nummer>. Nummer aus /keys uebernehmen.' },
  keys: { short: 'Alle gespeicherten Keys je Anbieter auflisten (maskiert)', long: 'Zeigt Anzahl + Cooldown-Status je Key (limitiert = wartet auf Erholung, siehe key-health.json).' },
  hivedepth: { short: 'Verschachtelungstiefe von /hive einstellen', long: '/hivedepth <1-5> setzt sie fest, /hivedepth auto laesst sie automatisch anhand der Anzahl eingetragener API-Keys empfehlen (mehr Keys = weniger Rate-Limit-Risiko = mehr Tiefe vertretbar). Ohne Argument: aktueller Wert + Empfehlung. Achtung: Tiefe wirkt multiplikativ auf Kosten/Laufzeit.' },
  trace: { short: 'Strukturiertes Ereignis-Log eines Swarm/Hive-Laufs ansehen', long: '/trace <lauf-id> zeigt alle Ereignisse (Modell-Wechsel, Key-Wechsel, Worker-Start/-Ende, Konsens-Stimmen) EINES Laufs in Reihenfolge. Ohne Argument: die letzten 30 Ereignisse ueber alle Laeufe. Lauf-ID wird nach jedem Swarm/Hive-Abschluss angezeigt.' },
  modelhealth: { short: 'Diagnose-Status aller Modell-Presets anzeigen/zuruecksetzen', long: 'Ohne Argument: Aufrufe/Fehler/Antwortzeit/Status (gesund, unhealthy, gesperrt, ungetestet) je Preset -- beantwortet "warum wird nur zwischen 2 Modellen gewechselt" direkt statt zu raten. /modelhealth <preset> setzt nur eins zurueck, /modelhealth reset alle (statt bis zu 6h auf STALE_MS zu warten).' },
  baseurl: { short: 'Eigene OpenAI-kompatible Basis-URL setzen', long: 'Setzt gleichzeitig /provider custom -- fuer jeden OpenAI-kompatiblen Endpunkt, der kein eigenes Preset hat.' },
  projectroot: { short: 'Projekt-Ordner fuer die Datei-/Shell-Tools wechseln', long: 'Wird automatisch angelegt, falls er noch nicht existiert. Default ist ~/nemotron-projects (portabel, kein hart codiertes Laufwerk).' },
  agents: { short: 'Verfuegbare Agent-Rollen auflisten', long: 'Zeigt alle Rollen aus agents/*.json mit Modell-Zuordnung.' },
  agent: { short: 'Genau EINE Rolle ad-hoc auf eine Aufgabe ansetzen', long: 'Anders als /swarm: keine feste Pipeline-Reihenfolge, nur die eine angegebene Rolle fuer genau einen Zug. Sinnvoll fuer kleine Einzelaufgaben, wo Planner->Coder->Reviewer ueberdimensioniert waere.' },
  team: { short: 'Fragt nach: /swarm oder /hive fuer diese Aufgabe?', long: 'Reine Rueckfrage-Huelle, kein eigener Modus -- startet je nach Antwort entweder /swarm oder /hive. /team loop [n] <aufgabe> fragt einmal, wiederholt die gewaehlte Variante dann unbegrenzt (oder n-mal, falls angegeben) -- /stop waehrend des Laufs beendet manuell.' },
  swarm: { short: 'Feste Pipeline (Planner -> Coder -> Reviewer, Ruecksprache moeglich)', long: 'Reihenfolge aus agents/pipeline.json. Rollen koennen sich per send_message gegenseitig erneut anstossen (Ruecksprache). Laeuft autonom, siehe /swarmautonomy. /swarm loop [n] <aufgabe> wiederholt unbegrenzt (oder n-mal, falls angegeben), baut dabei auf der Projekt-Gedaechtnis-Datei auf, bricht frueher ab bei mark_task_complete, oder per "/stop" waehrend des Laufs manuell beendbar.' },
  hive: { short: 'Coordinator verteilt Teilaufgaben an >=5 Worker PARALLEL', long: 'Ein Coordinator-Modell zerlegt die Aufgabe und dispatcht per Tool-Call gleichzeitig an mehrere Worker-Rollen (echte parallele HTTP-Requests, bis zu 2 Verschachtelungsebenen). Nach Abschluss pruefen 3 unabhaengige Modelle per Konsens, ob wirklich fertig ist. /hive loop [n] <aufgabe> wiederholt unbegrenzt (oder n-mal, falls angegeben) -- /stop waehrend des Laufs beendet manuell.' },
  panel: { short: 'Judge-Panel: 3 Modelle parallel, 1 Richter waehlt/synthetisiert', long: 'Keine Datei-Tools -- reiner Text-Vergleich fuer Fragen, wo mehrere unabhaengige Meinungen sinnvoll sind (z.B. Architektur-Entscheidungen).' },
  style: { short: 'Antwortstil setzen (caveman/ponytail/off)', long: 'Wirkt als zusaetzliche System-Nachricht bei Einzel-Chat und Swarm/Hive-Rollen.' },
  effort: { short: 'Gruendlichkeit/Antwortlaenge steuern', long: 'low|medium|high|xhigh -- kein echtes Thinking-Budget (OpenAI-kompatible Endpunkte haben das nicht), nur Antwortlaenge + Gruendlichkeits-Hinweis.' },
  permission: { short: 'Bestaetigungspflicht pro Tool ueberschreiben', long: '/permission <tool> <allow|ask|deny>. "deny" blockiert IMMER, auch in Swarm/Hive-Autonomie und /autoapprove.' },
  plan: { short: 'Plan-Modus: Schreib-/Shell-/MCP-Tools nur beschreiben, nicht ausfuehren', long: 'Blockiert auch im Swarm/Hive-Autonomie-Modus vollstaendig -- staerker als jede andere Einstellung.' },
  autoapprove: { short: 'Einzel-Chat: Bestaetigungen global uebergehen', long: 'Gilt NUR fuer den Einzel-Chat. Swarm/Hive haben ihren eigenen Autonomie-Schalter, siehe /swarmautonomy.' },
  swarmautonomy: { short: 'Swarm/Hive: Bestaetigungsfragen an/aus', long: 'Standard AN -- /agent, /swarm, /hive fragen nicht nach (sonst haengt ein unbeaufsichtigter Lauf auf die Antwort). Gefaehrliche Shell-Befehle werden bei aktiver Autonomie stattdessen hart blockiert statt nachgefragt.' },
  todo: { short: 'Einfache Aufgabenliste', long: '/todo add <text> | /todo done <id> | /todo (Liste anzeigen). Datei-backed, kein Kalender/Erinnerungen.' },
  history: { short: 'Archivierte Sitzungen durchsuchen', long: '/history search <begriff> -- durchsucht alle per /new archivierten Sitzungen (sessions/*.json).' },
  codemap: { short: 'Grober Ordner-/Dateityp-Ueberblick des Projekt-Ordners', long: 'Kein AST/Deep-Scan -- nur Top-Level-Listing + Datei-Endungs-Histogramm.' },
  undo: { short: 'Letzten write_file/edit_file fuer einen Pfad rueckgaengig machen', long: 'Bis zu 5 Undo-Schritte pro Datei (Ring-Puffer, kein voller Verlauf).' },
  usage: { short: 'Token-Nutzung dieser Sitzung anzeigen', long: 'Zaehlt Einzel-Chat, /agent, /swarm und /hive (inkl. verschachtelter Worker), nur wenn der Provider usage-Daten liefert.' },
  mcp: { short: 'MCP-Server verbinden/trennen/auflisten', long: '/mcp connect <name> <kommando> [args...] | /mcp list | /mcp disconnect <name>. Nur stdio-Transport.' },
  help: { short: 'Diese Hilfe -- /help <befehl> fuer Details', long: 'Ohne Argument: alle Befehle mit Kurzbeschreibung. Mit Argument: ausfuehrlicher Text zu genau diesem Befehl.' },
  settings: { short: 'Aktuelle Konfiguration anzeigen (Keys maskiert)', long: '' },
  new: { short: 'Neue Unterhaltung starten (alte wird archiviert)', long: 'Archivierte Sitzung bleibt per /history search durchsuchbar.' },
  exit: { short: 'Programm beenden', long: '' },
};

// Gruppiert statt einer flachen, historisch gewachsenen Liste -- /help zeigt die Gruppen-Titel
// als Zwischenueberschriften, Tab-Vervollstaendigung nutzt weiterhin die flache Ableitung unten.
const COMMAND_GROUPS = [
  { title: 'Modelle & Anbieter', commands: ['models', 'model', 'recommend', 'fallback', 'provider', 'baseurl', 'modelhealth'] },
  { title: 'API-Keys (mehrere Accounts)', commands: ['setkey', 'addkey', 'removekey', 'keys'] },
  { title: 'Agenten & Teams', commands: ['agents', 'agent', 'swarm', 'hive', 'team', 'panel', 'hivedepth', 'trace'] },
  { title: 'Sicherheit & Berechtigungen', commands: ['permission', 'plan', 'autoapprove', 'swarmautonomy'] },
  { title: 'Projekt & Werkzeuge', commands: ['projectroot', 'codemap', 'undo', 'todo', 'mcp'] },
  { title: 'Verhalten & Ausgabe', commands: ['style', 'effort'] },
  { title: 'Sitzung & Sonstiges', commands: ['new', 'history', 'usage', 'settings', 'help', 'exit'] },
];
const BUILTIN_COMMANDS = COMMAND_GROUPS.flatMap((g) => g.commands);

// Tab-Vervollstaendigung: erstes Wort = Slash-Command (eingebaut + eigene commands/*.md),
// jedes weitere Wort = Datei-/Ordnerpfad relativ zu config.projectRoot. Rein synchrone Logik,
// daher direkt als reine Funktion testbar (ohne echtes TTY/Tab-Ereignis noetig).
function completer(line) {
  const parts = line.split(' ');
  if (parts.length === 1) {
    if (!line.startsWith('/')) return [[], line];
    const all = [...BUILTIN_COMMANDS, ...listCustomCommands()].map((c) => '/' + c);
    const hits = all.filter((c) => c.startsWith(line));
    return [hits.length ? hits : all, line];
  }
  const lastPart = parts[parts.length - 1];
  try {
    const target = path.join(config.projectRoot, lastPart);
    const dir = lastPart.endsWith('/') || lastPart.endsWith('\\') ? target : path.dirname(target);
    const baseName = lastPart.endsWith('/') || lastPart.endsWith('\\') ? '' : path.basename(lastPart);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const matches = entries
      .filter((e) => e.name.startsWith(baseName))
      .map((e) => path.join(path.dirname(lastPart) === '.' && !lastPart.includes(path.sep) ? '' : path.dirname(lastPart), e.name) + (e.isDirectory() ? path.sep : ''));
    return [matches.length ? matches : [], lastPart];
  } catch {
    return [[], lastPart];
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '', completer });

function activeLabel() {
  const preset = MODEL_PRESETS[config.activeModel];
  if (preset) return `${preset.label} (${PROVIDERS[preset.provider].label})`;
  const target = resolveTarget(config);
  return `${config.activeModel} (${target.providerLabel})`;
}

// Der Projekt-Ordner ist portabel (kein hart codiertes Laufwerk mehr), existiert bei einem
// frischen Start aber moeglicherweise noch nicht -- automatisch anlegen statt erst beim
// ersten Tool-Aufruf mit ENOENT zu scheitern. Schlaegt das Anlegen fehl (z.B. ungueltiger
// Pfad nach manueller config.json-Bearbeitung), klar warnen statt still weiterzumachen.
function ensureProjectRoot(root) {
  try {
    fs.mkdirSync(root, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function printBanner() {
  console.log(`${ANSI.accent}${ANSI.bold}Open-Source Terminal Chat${ANSI.reset}`);
  console.log(`${ANSI.dim}Modell: ${activeLabel()}${ANSI.reset}`);
  console.log(`${ANSI.dim}Projekt-Ordner (Datei-Tools): ${config.projectRoot}${ANSI.reset}`);
  if (!ensureProjectRoot(config.projectRoot)) {
    console.log(`${ANSI.error}Projekt-Ordner existiert nicht und konnte nicht angelegt werden -- /projectroot <anderer-pfad> zum Aendern.${ANSI.reset}`);
  }
  const detected = detectProjectType(config.projectRoot);
  if (detected.length) {
    console.log(`${ANSI.dim}Erkannt: ${detected.join(', ')}${ANSI.reset}`);
  }
  console.log(
    `${ANSI.dim}Befehle: ${BUILTIN_COMMANDS.map((c) => '/' + c).join('  ')}${ANSI.reset}`
  );
  console.log(`${ANSI.dim}/help zeigt eine Kurzbeschreibung, /help <befehl> eine ausfuehrliche Erklaerung.${ANSI.reset}`);
  if (config.style && STYLES[config.style]) {
    console.log(`${ANSI.dim}Stil: ${STYLES[config.style].label}${ANSI.reset}`);
  }
  console.log(`${ANSI.dim}Effort: ${(EFFORT_LEVELS[config.effort] || EFFORT_LEVELS.high).label}${ANSI.reset}`);
  if (config.swarmAutonomy) {
    console.log(`${ANSI.dim}/agent, /swarm, /hive laufen autonom (keine Bestaetigungsfragen) -- /swarmautonomy off zum Abschalten.${ANSI.reset}`);
  }
  if (messages.length) {
    console.log(`${ANSI.dim}Verlauf wiederhergestellt (${messages.length} Nachrichten) -- /new fuer einen frischen Start.${ANSI.reset}`);
  }
  if (loadProjectInstructions(config.projectRoot)) {
    console.log(`${ANSI.dim}Projekt-Instruktionen geladen aus ${PROJECT_INSTRUCTIONS_FILENAME}.${ANSI.reset}`);
  }
  if (loadProjectMemory(config.projectRoot)) {
    console.log(`${ANSI.dim}Projekt-Gedaechtnis aus vorherigen Agent-Laeufen gefunden (${PROJECT_MEMORY_FILENAME}).${ANSI.reset}`);
  }
  const target = resolveTarget(config);
  if (!target.apiKey) {
    console.log(`${ANSI.error}Kein Key fuer ${target.providerLabel} gesetzt -- /setkey ${target.provider} <key>${ANSI.reset}`);
  }
  console.log('');
}

// Auf Nutzerwunsch: kurzer Ueberblick (Modell/Effort/Key-Anzahl) VOR jeder Eingabezeile, statt
// dass der Nutzer dafuer erst /settings tippen muss. ponytail: bewusst reprinted statt einer
// echten "live gepinnten" Statuszeile -- letzteres braucht ANSI-Cursor-Region-Redraw, das je
// nach Terminal (Windows Terminal/cmd/VS Code) unterschiedlich zuverlaessig ist. Ein einfacher
// Reprint vor jedem Prompt erreicht denselben Informationsgewinn ohne dieses Risiko.
function statusLine() {
  const providerLabel = PROVIDERS[config.activeProvider]?.label || config.activeProvider;
  const keyCount = Object.values(config.keys || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.filter((k) => k && k.trim()).length : 0), 0);
  return `${ANSI.dim}[${config.activeModel} @ ${providerLabel} | Effort ${config.effort} | ${keyCount} Key(s)]${ANSI.reset}`;
}

function printPrompt() {
  process.stdout.write(`${statusLine()}\n${ANSI.bold}> ${ANSI.reset}`);
}

// Sichtbares Lebenszeichen waehrend Wartezeiten (Modell-Antwort, run_command) -- vorher war
// zwischen Start und erstem Chunk/Ergebnis komplette Stille, ein 5-Minuten-Lauf sah dann aus
// wie ein Haenger. overwrite:true ueberschreibt dieselbe Zeile per \r (nur fuer garantiert
// SEQUENZIELLE Kontexte -- Einzel-Chat, ein Swarm-Zug, der Hive-Coordinator). Fuer parallele
// Hive-Worker (mehrere gleichzeitige Promise.all-Zweige) waere \r auf derselben Zeile ein
// Wirrwarr aus ueberschriebenen Heartbeats -- dort overwrite:false (eigene Log-Zeile, seltener).
function makeWaitIndicator(label, { overwrite = true, intervalMs = 4000 } = {}) {
  let done = false;
  const start = Date.now();
  const timer = setInterval(() => {
    if (done) return;
    const secs = Math.round((Date.now() - start) / 1000);
    if (overwrite) {
      process.stdout.write(`\r${ANSI.dim}${label} (${secs}s)...${ANSI.reset}`);
    } else {
      console.log(`${ANSI.dim}${label} (${secs}s)...${ANSI.reset}`);
    }
  }, intervalMs);
  return function stop(clearLine) {
    if (done) return;
    done = true;
    clearInterval(timer);
    if (overwrite && clearLine) process.stdout.write('\r' + ' '.repeat(70) + '\r');
  };
}

// Statt des vollen JSON.stringify(args) im Terminal (bei write_file/edit_file steckt dort der
// KOMPLETTE Dateiinhalt drin -- verschmutzt die Anzeige bei jeder erzeugten Datei massiv):
// tool-spezifische Kurzdarstellung. Alle anderen Tools (list_directory/read_file/glob/grep/MCP)
// sind ohnehin kurz und bleiben unveraendert als JSON.
function shorten(text, max) {
  if (typeof text !== 'string') return text;
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function formatToolCallForDisplay(name, args) {
  if (name === 'write_file') {
    const len = typeof args.content === 'string' ? args.content.length : 0;
    return `write_file(${args.path}, ${len} Zeichen)`;
  }
  if (name === 'edit_file') {
    return `edit_file(${args.path}, "${shorten(args.old_string || '', 40)}" -> "${shorten(args.new_string || '', 40)}")`;
  }
  if (name === 'run_command') {
    return `run_command(${shorten(args.command || '', 200)})`;
  }
  return `${name}(${JSON.stringify(args)})`;
}

// Sichtbares Feedback bei transientem Fehler (5xx/429/Netzwerk) statt stillem Warten --
// sonst sieht ein 1-4s-Backoff genauso aus wie ein Haenger.
function printRetry(err, attempt, maxRetries, delayMs) {
  console.log(
    `${ANSI.error}[Retry ${attempt}/${maxRetries}] ${err.message || err} -- warte ${Math.round(delayMs / 1000)}s...${ANSI.reset}`
  );
}

// Ein Zug ohne Text UND ohne Tool-Aufruf sieht sonst aus wie ein Haenger, ist aber nur ein
// stiller Modell-Aussetzer (leere Antwort) -- explizit sichtbar machen statt kommentarlos
// weiterzugehen.
function printEmptyTurn(role, detail = '') {
  console.log(
    `\n${ANSI.error}[Warnung] ${role.label} hat nichts geliefert (weder Text noch Tool-Aufruf)${detail || ' -- moeglicher Modell-Aussetzer'}.${ANSI.reset}`
  );
}

// Selbstdiagnose (modelHealth.js) hat entschieden, dass das Modell dieser Rolle zu oft
// Retries/Fehler/Langsamkeit produziert -- fuer diesen Zug automatisch ersetzt. Identische
// Wechsel-Meldungen direkt hintereinander (z.B. jeder Loop-Durchlauf trifft dieselbe
// Entscheidung neu) werden nur EINMAL gedruckt -- der gemeldete Log-Spam bestand zu einem
// grossen Teil aus exakt derselben Zeile in jeder Runde.
let lastModelSwapLine = '';
function printModelSwap(role, oldModel, newModel, reason) {
  const line = `[Modell-Wechsel] ${role.label}: "${oldModel}" wirkt unzuverlaessig (${reason}) -- ersetzt durch "${newModel}".`;
  if (line === lastModelSwapLine) return;
  lastModelSwapLine = line;
  console.log(`\n${ANSI.error}${line}${ANSI.reset}`);
}

// ponytail: reine Keyword-Heuristik, kein gelerntes Routing -- reicht als grobe Empfehlung,
// /model + eigenes Urteil bleiben massgeblich.
function recommendModel(taskText) {
  const t = taskText.toLowerCase();
  const rules = [
    { test: /schnell|kurz\b|fast|eilig/, key: 'nemotron-nano9b', reason: 'klingt nach einer schnellen, einfachen Aufgabe' },
    { test: /security|sicherheit|xss|injection|vulnerab/, key: 'deepseek-v4', reason: 'Security-Aufgaben profitieren von starkem Reasoning' },
    { test: /review|pruef|feedback/, key: 'glm-5', reason: 'Code-Review-Aufgabe' },
    { test: /code|programm|implementier|bug|fix|funktion|api/, key: 'deepseek-v4', reason: 'Coding-Aufgabe, staerkstes Reasoning-Preset' },
    { test: /plan|architektur|design|struktur/, key: 'qwen-397b', reason: 'Planungs-/Architektur-Aufgabe' },
    { test: /recherch|analysi|zusammenfass|erklaer/, key: 'kimi-k2.6', reason: 'Recherche-/Analyse-Aufgabe' },
  ];
  const hit = rules.find((r) => r.test.test(t));
  return hit || { key: 'nemotron-super', reason: 'keine spezifischen Anhaltspunkte, solider Allrounder' };
}

function printModelList() {
  console.log(`${ANSI.dim}Verfuegbare Presets:${ANSI.reset}`);
  for (const [key, info] of Object.entries(MODEL_PRESETS)) {
    const marker = key === config.activeModel ? '*' : ' ';
    console.log(`${ANSI.dim}${marker} ${key.padEnd(16)} ${info.label.padEnd(38)} [${PROVIDERS[info.provider].label}]${ANSI.reset}`);
  }
  console.log(
    `${ANSI.dim}  (oder /model <beliebige-modell-id> + /provider <openrouter|nim|ollama|custom> fuer alles andere)${ANSI.reset}\n`
  );
}

async function handleCommand(line) {
  const [cmd, ...rest] = line.slice(1).split(' ');
  const arg = rest.join(' ').trim();

  if (cmd === 'exit') {
    rl.close();
    return;
  }
  if (cmd === 'new') {
    messages = [];
    archiveSession();
    console.log(`${ANSI.dim}Neue Unterhaltung gestartet (alte Sitzung archiviert -- /history search <begriff>).${ANSI.reset}\n`);
    return;
  }
  if (cmd === 'todo') {
    const [sub, ...rest3] = arg.split(' ');
    const todos = loadTodos();
    if (sub === 'add') {
      const text = rest3.join(' ').trim();
      if (!text) {
        console.log(`${ANSI.error}Nutzung: /todo add <text>${ANSI.reset}\n`);
        return;
      }
      const id = todos.length ? Math.max(...todos.map((t) => t.id)) + 1 : 1;
      todos.push({ id, text, done: false });
      saveTodos(todos);
      console.log(`${ANSI.dim}Todo #${id} hinzugefuegt.${ANSI.reset}\n`);
      return;
    }
    if (sub === 'done') {
      const id = Number(rest3[0]);
      const todo = todos.find((t) => t.id === id);
      if (!todo) {
        console.log(`${ANSI.error}Todo #${rest3[0]} nicht gefunden.${ANSI.reset}\n`);
        return;
      }
      todo.done = true;
      saveTodos(todos);
      console.log(`${ANSI.dim}Todo #${id} erledigt.${ANSI.reset}\n`);
      return;
    }
    if (!todos.length) {
      console.log(`${ANSI.dim}(keine Todos -- /todo add <text>)${ANSI.reset}\n`);
      return;
    }
    for (const t of todos) {
      console.log(`${ANSI.dim}${t.done ? '[x]' : '[ ]'} #${t.id} ${t.text}${ANSI.reset}`);
    }
    console.log('');
    return;
  }
  if (cmd === 'history') {
    const [sub, ...rest4] = arg.split(' ');
    if (sub !== 'search') {
      console.log(`${ANSI.error}Nutzung: /history search <begriff>${ANSI.reset}\n`);
      return;
    }
    const term = rest4.join(' ').trim().toLowerCase();
    if (!term) {
      console.log(`${ANSI.error}Nutzung: /history search <begriff>${ANSI.reset}\n`);
      return;
    }
    if (!fs.existsSync(SESSIONS_DIR)) {
      console.log(`${ANSI.dim}(kein archiviertes Verlauf -- entsteht bei /new)${ANSI.reset}\n`);
      return;
    }
    let hits = 0;
    for (const f of fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))) {
      let msgs;
      try {
        msgs = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
      } catch {
        continue;
      }
      for (const m of msgs) {
        if (m.content && m.content.toLowerCase().includes(term)) {
          hits++;
          console.log(`${ANSI.dim}${f} [${m.role}]: ${m.content.slice(0, 150)}${ANSI.reset}`);
        }
      }
    }
    console.log(hits ? '' : `${ANSI.dim}(keine Treffer)${ANSI.reset}\n`);
    return;
  }
  if (cmd === 'effort') {
    if (!arg || !EFFORT_LEVELS[arg]) {
      console.log(`${ANSI.error}Nutzung: /effort <${Object.keys(EFFORT_LEVELS).join('|')}>  (aktuell: ${config.effort})${ANSI.reset}\n`);
      return;
    }
    config.effort = arg;
    saveConfig(config);
    console.log(`${ANSI.dim}Effort gesetzt: ${EFFORT_LEVELS[arg].label}${ANSI.reset}\n`);
    return;
  }
  if (cmd === 'fallback') {
    if (!arg) {
      console.log(
        `${ANSI.error}Nutzung: /fallback <modell-preset-oder-id>  (aktuell: ${config.fallbackModel || '(keiner)'})  -- /fallback off zum Deaktivieren${ANSI.reset}\n`
      );
      return;
    }
    config.fallbackModel = arg === 'off' ? '' : arg;
    saveConfig(config);
    console.log(`${ANSI.dim}Fallback-Modell: ${config.fallbackModel || '(deaktiviert)'}${ANSI.reset}\n`);
    return;
  }
  if (cmd === 'recommend') {
    if (!arg) {
      console.log(`${ANSI.error}Nutzung: /recommend <Aufgabenbeschreibung>${ANSI.reset}\n`);
      return;
    }
    const rec = recommendModel(arg);
    console.log(`${ANSI.dim}Empfehlung: ${rec.key} -- ${rec.reason}${ANSI.reset}`);
    console.log(`${ANSI.dim}Uebernehmen mit: /model ${rec.key}${ANSI.reset}\n`);
    return;
  }
  if (cmd === 'models') {
    printModelList();
    return;
  }
  if (cmd === 'settings') {
    const maskedKeys = Object.fromEntries(Object.entries(config.keys).map(([k, v]) => {
      const count = (Array.isArray(v) ? v : [v]).filter((x) => x && x.trim()).length;
      return [k, count ? `${count} Key(s)` : '(leer)'];
    }));
    console.log(JSON.stringify({ ...config, keys: maskedKeys }, null, 2));
    console.log('');
    return;
  }
  if (cmd === 'model') {
    if (!arg) {
      printModelList();
      return;
    }
    config.activeModel = arg;
    saveConfig(config);
    console.log(`${ANSI.dim}Modell gewechselt zu: ${activeLabel()}.${ANSI.reset}\n`);
    return;
  }
  if (cmd === 'provider') {
    if (!arg || !PROVIDERS[arg]) {
      console.log(`${ANSI.error}Nutzung: /provider <${Object.keys(PROVIDERS).join('|')}>${ANSI.reset}\n`);
      return;
    }
    config.activeProvider = arg;
    saveConfig(config);
    console.log(`${ANSI.dim}Anbieter gewechselt zu: ${PROVIDERS[arg].label} (wirkt nur bei nicht-Preset-Modellen).${ANSI.reset}\n`);
    return;
  }
  if (cmd === 'setkey') {
    const [providerArg, ...keyParts] = arg.split(' ');
    const key = keyParts.join(' ').trim();
    if (!PROVIDERS[providerArg] || providerArg === 'custom' || !key) {
      console.log(`${ANSI.error}Nutzung: /setkey <openrouter|nim|ollama> <key>${ANSI.reset}\n`);
      return;
    }
    config.keys[providerArg] = [key];
    saveConfig(config);
    console.log(`${ANSI.dim}Key fuer ${PROVIDERS[providerArg].label} gespeichert (ersetzt alle bisherigen, ${CONFIG_PATH}).${ANSI.reset}\n`);
    return;
  }
  if (cmd === 'addkey') {
    const [providerArg, ...keyParts] = arg.split(' ');
    const key = keyParts.join(' ').trim();
    if (!PROVIDERS[providerArg] || providerArg === 'custom' || !key) {
      console.log(`${ANSI.error}Nutzung: /addkey <openrouter|nim|ollama> <key>${ANSI.reset}\n`);
      return;
    }
    if (!Array.isArray(config.keys[providerArg])) config.keys[providerArg] = [];
    if (config.keys[providerArg].includes(key)) {
      console.log(`${ANSI.dim}Dieser Key ist fuer ${PROVIDERS[providerArg].label} schon eingetragen.${ANSI.reset}\n`);
      return;
    }
    config.keys[providerArg].push(key);
    saveConfig(config);
    // Kontingent-Sperren sind PRO KEY, modelHealth sperrt aber das MODELL "permanent" -- ein
    // neuer Key bringt frisches Kontingent, also die quota-basierten Modell-Sperren dieses
    // Anbieters aufheben. Sonst: Nutzer traegt 3 neue Accounts ein und die Modelle bleiben
    // trotzdem gesperrt, weil die Sperre noch vom alten, erschoepften Key stammt.
    let unlocked = 0;
    for (const [presetKey, preset] of Object.entries(MODEL_PRESETS)) {
      if (preset.provider === providerArg && listHealth([presetKey])[0].permanent) {
        resetHealth(presetKey);
        unlocked++;
      }
    }
    console.log(`${ANSI.dim}Weiterer Key fuer ${PROVIDERS[providerArg].label} hinzugefuegt (jetzt ${config.keys[providerArg].length}). Automatischer Wechsel bei Limit aktiv.${unlocked ? ` ${unlocked} kontingent-gesperrte(s) Modell(e) dieses Anbieters wieder freigegeben (neuer Key = frisches Kontingent).` : ''}${ANSI.reset}\n`);
    return;
  }
  if (cmd === 'removekey') {
    const [providerArg, idxArg] = arg.split(' ');
    const idx = Number(idxArg) - 1;
    const list = Array.isArray(config.keys[providerArg]) ? config.keys[providerArg] : [];
    if (!PROVIDERS[providerArg] || !(idx >= 0 && idx < list.length)) {
      console.log(`${ANSI.error}Nutzung: /removekey <provider> <nummer>  (siehe /keys)${ANSI.reset}\n`);
      return;
    }
    list.splice(idx, 1);
    saveConfig(config);
    console.log(`${ANSI.dim}Key #${idxArg} fuer ${PROVIDERS[providerArg].label} entfernt (noch ${list.length} uebrig).${ANSI.reset}\n`);
    return;
  }
  if (cmd === 'keys') {
    for (const p of Object.keys(PROVIDERS)) {
      if (p === 'custom') continue;
      const list = Array.isArray(config.keys[p]) ? config.keys[p].filter((k) => k && k.trim()) : [];
      if (!list.length) {
        console.log(`${ANSI.dim}${PROVIDERS[p].label}: keine Keys${ANSI.reset}`);
        continue;
      }
      const parts = list.map((k, i) => `#${i + 1}${isKeyExhausted(p, k) ? ' (limitiert)' : ''}`);
      console.log(`${ANSI.dim}${PROVIDERS[p].label}: ${list.length} Key(s) -- ${parts.join(', ')}${ANSI.reset}`);
    }
    console.log('');
    return;
  }
  if (cmd === 'modelhealth') {
    if (arg === 'reset') {
      resetHealth();
      console.log(`${ANSI.dim}Gesamte Modell-Diagnose zurueckgesetzt -- alle Presets bekommen wieder eine neutrale Chance.${ANSI.reset}\n`);
      return;
    }
    if (arg) {
      if (!MODEL_PRESETS[arg]) {
        console.log(`${ANSI.error}Unbekanntes Preset "${arg}". /models zeigt alle. /modelhealth reset (ohne Preset) setzt alle zurueck.${ANSI.reset}\n`);
        return;
      }
      resetHealth(arg);
      console.log(`${ANSI.dim}Diagnose fuer "${arg}" zurueckgesetzt.${ANSI.reset}\n`);
      return;
    }
    const rows = listHealth(Object.keys(MODEL_PRESETS));
    for (const r of rows) {
      const status = r.permanent ? 'GESPERRT (Kontingent/Tageslimit)' : r.unhealthy ? `UNHEALTHY (${r.reason})` : r.calls ? 'gesund' : 'ungetestet';
      console.log(
        `${ANSI.dim}${r.key.padEnd(16)} Aufrufe:${String(r.calls).padEnd(4)} Fehler:${String(r.errors).padEnd(4)} Oe-Zeit:${(r.avgMs !== null ? r.avgMs + 'ms' : '-').padEnd(8)} ${status}${ANSI.reset}`
      );
    }
    console.log(`\n${ANSI.dim}/modelhealth <preset> -- nur dieses zuruecksetzen. /modelhealth reset -- alle zuruecksetzen.${ANSI.reset}\n`);
    return;
  }
  if (cmd === 'hivedepth') {
    if (!arg) {
      const rec = recommendHiveDepth(config);
      const eff = effectiveHiveDepth(config);
      console.log(
        `${ANSI.dim}Aktive Hive-Tiefe: ${eff}${config.hiveDepth ? ' (manuell gesetzt)' : ` (automatisch empfohlen anhand ${Object.values(config.keys || {}).flat().filter((k) => k && k.trim()).length} eingetragener Key(s): ${rec})`}. Setzen mit /hivedepth <1-5> oder /hivedepth auto.${ANSI.reset}\n`
      );
      return;
    }
    if (arg === 'auto') {
      config.hiveDepth = null;
      saveConfig(config);
      console.log(`${ANSI.dim}Hive-Tiefe wieder auf automatische Empfehlung gestellt (aktuell: ${recommendHiveDepth(config)}).${ANSI.reset}\n`);
      return;
    }
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      console.log(`${ANSI.error}Nutzung: /hivedepth <1-5|auto>${ANSI.reset}\n`);
      return;
    }
    config.hiveDepth = n;
    saveConfig(config);
    console.log(`${ANSI.dim}Hive-Tiefe manuell auf ${n} gesetzt (mehr Verschachtelung = multiplikativ mehr Kosten/Zeit pro Lauf).${ANSI.reset}\n`);
    return;
  }
  if (cmd === 'trace') {
    const events = trace.readTrace({ run: arg || null, limit: arg ? 200 : 30 });
    if (!events.length) {
      console.log(`${ANSI.dim}Keine Trace-Eintraege${arg ? ` fuer "${arg}"` : ''} gefunden.${ANSI.reset}\n`);
      return;
    }
    for (const e of events) {
      const { ts, run, event, ...detail } = e;
      console.log(`${ANSI.dim}${ts.slice(11, 19)} [${run || '-'}] ${event} ${JSON.stringify(detail)}${ANSI.reset}`);
    }
    console.log('');
    return;
  }
  if (cmd === 'projectroot') {
    if (!arg) {
      console.log(`${ANSI.error}Nutzung: /projectroot <pfad>  (aktuell: ${config.projectRoot})${ANSI.reset}\n`);
      return;
    }
    const resolved = path.resolve(arg);
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (err) {
      console.log(`${ANSI.error}Ordner konnte nicht angelegt/gefunden werden: ${err.message}${ANSI.reset}\n`);
      return;
    }
    config.projectRoot = resolved;
    saveConfig(config);
    resetCwd();
    console.log(`${ANSI.dim}Projekt-Ordner gesetzt: ${resolved}${ANSI.reset}\n`);
    return;
  }
  if (cmd === 'baseurl') {
    if (!arg) {
      console.log(`${ANSI.error}Nutzung: /baseurl <url>  (aktuell custom: ${config.customBaseUrl || '(leer)'})${ANSI.reset}\n`);
      return;
    }
    config.customBaseUrl = arg;
    config.activeProvider = 'custom';
    saveConfig(config);
    console.log(`${ANSI.dim}Custom Base-URL gesetzt und aktiviert: ${arg}${ANSI.reset}\n`);
    return;
  }
  if (cmd === 'agents') {
    const roles = loadAgentRoles();
    if (!roles.length) {
      console.log(`${ANSI.error}Keine Agent-Rollen in ${AGENTS_DIR} gefunden (JSON-Dateien anlegen, siehe README).${ANSI.reset}\n`);
      return;
    }
    console.log(`${ANSI.dim}Agent-Rollen (${AGENTS_DIR}):${ANSI.reset}`);
    for (const role of roles) {
      console.log(`${ANSI.dim}  ${role.name.padEnd(12)} ${role.label.padEnd(20)} Modell: ${role.model}${ANSI.reset}`);
    }
    console.log('');
    return;
  }
  if (cmd === 'agent') {
    const [roleName, ...taskParts] = arg.split(' ');
    const task = taskParts.join(' ').trim();
    if (!roleName || !task) {
      console.log(`${ANSI.error}Nutzung: /agent <rolle> <aufgabe>  (Rollen: /agents)${ANSI.reset}\n`);
      return;
    }
    const role = loadAgentRoles().find((r) => r.name === roleName);
    if (!role) {
      console.log(`${ANSI.error}Rolle "${roleName}" nicht gefunden. /agents zeigt verfuegbare Rollen.${ANSI.reset}\n`);
      return;
    }
    console.log(`${ANSI.dim}Einzel-Agent startet: ${role.label}${ANSI.reset}`);
    let stopWaiting = () => {};
    let firstOutput = true;
    const beforeFiles = new Set(touchedFiles);
    try {
      const transcript = await runSwarm({
        config,
        task,
        roles: [role],
        buildToolDefinitions,
        projectContext: buildAgentContext(config.projectRoot, task),
        onAgentStart: (r) => {
          console.log(`\n\n${ANSI.accent}${ANSI.bold}=== ${r.label} (${r.model}) ===${ANSI.reset}`);
          firstOutput = true;
          stopWaiting = makeWaitIndicator(`${ANSI.dim}(wartet auf Modell-Antwort)${ANSI.reset}`);
        },
        onChunk: (delta) => {
          if (firstOutput) { stopWaiting(true); firstOutput = false; }
          process.stdout.write(delta);
        },
        onNotice: (text) => console.log(`\n${ANSI.accent}[Nachricht] ${text}${ANSI.reset}`),
        onFileToolCall: (toolCall) => {
          if (firstOutput) { stopWaiting(true); firstOutput = false; }
          return handleToolCall(toolCall, { swarmMode: true });
        },
        onRetry: (...a) => { stopWaiting(true); printRetry(...a); firstOutput = true; },
        onEmptyTurn: (r, detail) => { stopWaiting(true); printEmptyTurn(r, detail); },
        onModelSwap: printModelSwap,
      });
      addUsageTotals(transcript.usageTotals);
      console.log(`\n${ANSI.dim}Fertig.${ANSI.reset}\n`);
      const newFiles = [...touchedFiles].filter((f) => !beforeFiles.has(f));
      const lastMsg = transcript[transcript.length - 1];
      appendProjectMemory(config.projectRoot, {
        task,
        files: newFiles,
        summary: lastMsg ? shorten(lastMsg.content, 500) : '(keine Textzusammenfassung)',
        lessons: formatLessons(transcript.mistakeLog),
      });
    } catch (err) {
      stopWaiting(true);
      console.log(`\n${ANSI.error}Fehler: ${err.message || err}${ANSI.reset}\n`);
    }
    return;
  }
  if (cmd === 'style') {
    if (!arg || (!STYLES[arg] && arg !== 'off')) {
      console.log(`${ANSI.error}Nutzung: /style <${[...Object.keys(STYLES), 'off'].join('|')}>${ANSI.reset}\n`);
      return;
    }
    config.style = arg;
    saveConfig(config);
    console.log(
      `${ANSI.dim}Stil gesetzt: ${STYLES[arg] ? STYLES[arg].label : 'aus'}${ANSI.reset}\n`
    );
    return;
  }
  if (cmd === 'codemap') {
    console.log(`${ANSI.dim}${buildCodemap(config.projectRoot)}${ANSI.reset}\n`);
    return;
  }
  if (cmd === 'undo') {
    if (!arg) {
      console.log(`${ANSI.error}Nutzung: /undo <pfad relativ zu ${config.projectRoot}>${ANSI.reset}\n`);
      return;
    }
    try {
      console.log(`${ANSI.dim}${undoLastWrite(config.projectRoot, arg)}${ANSI.reset}\n`);
    } catch (err) {
      console.log(`${ANSI.error}${err.message}${ANSI.reset}\n`);
    }
    return;
  }
  if (cmd === 'usage') {
    console.log(
      `${ANSI.dim}Token-Nutzung diese Sitzung: ${sessionUsage.promptTokens} prompt + ${sessionUsage.completionTokens} completion ` +
        `(${sessionUsage.calls} Antworten mit Nutzungsdaten). Zaehlt Einzel-Chat, /agent, /swarm, /hive.${ANSI.reset}\n`
    );
    return;
  }
  if (cmd === 'swarm') {
    const loopArgs = parseLoopArgs(arg);
    if (loopArgs) {
      if (!loopArgs.task) {
        console.log(`${ANSI.error}Nutzung: /swarm loop [n] <aufgabe>  (n optional -- ohne n unbegrenzt, /stop zum manuellen Beenden)${ANSI.reset}\n`);
        return;
      }
      await runLoopCommand('swarm', loopArgs.n, loopArgs.task);
      return;
    }
    if (!arg) {
      console.log(`${ANSI.error}Nutzung: /swarm <Aufgabe>  (oder /swarm loop [n] <aufgabe>)${ANSI.reset}\n`);
      return;
    }
    await runSwarmCommand(arg);
    return;
  }
  if (cmd === 'hive') {
    const loopArgs = parseLoopArgs(arg);
    if (loopArgs) {
      if (!loopArgs.task) {
        console.log(`${ANSI.error}Nutzung: /hive loop [n] <aufgabe>  (n optional -- ohne n unbegrenzt, /stop zum manuellen Beenden)${ANSI.reset}\n`);
        return;
      }
      await runLoopCommand('hive', loopArgs.n, loopArgs.task);
      return;
    }
    if (!arg) {
      console.log(`${ANSI.error}Nutzung: /hive <aufgabe>  (oder /hive loop [n] <aufgabe>)${ANSI.reset}\n`);
      return;
    }
    await runHiveCommand(arg);
    return;
  }
  if (cmd === 'team') {
    const loopArgs = parseLoopArgs(arg);
    if (loopArgs) {
      if (!loopArgs.task) {
        console.log(`${ANSI.error}Nutzung: /team loop [n] <aufgabe>  (n optional -- ohne n unbegrenzt, /stop zum manuellen Beenden)${ANSI.reset}\n`);
        return;
      }
      const loopAnswer = (await askQuestion(`${ANSI.bold}Swarm (feste Pipeline) oder Hive (Coordinator, parallel, >=5 Worker)? [swarm/hive] ${ANSI.reset}`)).toLowerCase();
      const loopKind = loopAnswer === 'hive' || loopAnswer === 'h' ? 'hive' : loopAnswer === 'swarm' || loopAnswer === 's' ? 'swarm' : null;
      if (!loopKind) {
        console.log(`${ANSI.error}Unbekannte Auswahl "${loopAnswer}" -- abgebrochen, bitte "swarm" oder "hive" eingeben.${ANSI.reset}\n`);
        return;
      }
      await runLoopCommand(loopKind, loopArgs.n, loopArgs.task);
      return;
    }
    if (!arg) {
      console.log(`${ANSI.error}Nutzung: /team <Aufgabe> -- fragt danach, ob /swarm oder /hive laufen soll.${ANSI.reset}\n`);
      return;
    }
    const answer = (await askQuestion(`${ANSI.bold}Swarm (feste Pipeline) oder Hive (Coordinator, parallel, >=5 Worker)? [swarm/hive] ${ANSI.reset}`)).toLowerCase();
    if (answer === 'hive' || answer === 'h') {
      await runHiveCommand(arg);
    } else if (answer === 'swarm' || answer === 's') {
      await runSwarmCommand(arg);
    } else {
      console.log(`${ANSI.error}Unbekannte Auswahl "${answer}" -- abgebrochen, bitte "swarm" oder "hive" eingeben.${ANSI.reset}\n`);
    }
    return;
  }
  if (cmd === 'panel') {
    if (!arg) {
      console.log(`${ANSI.error}Nutzung: /panel <aufgabe>${ANSI.reset}\n`);
      return;
    }
    await runPanelCommand(arg);
    return;
  }
  if (cmd === 'permission') {
    const [toolName, level] = arg.split(' ');
    if (!toolName || !['allow', 'ask', 'deny'].includes(level)) {
      const current = Object.entries(config.toolPermissions).map(([t, l]) => `${t}=${l}`).join(', ') || '(keine Ausnahmen)';
      console.log(`${ANSI.error}Nutzung: /permission <tool> <allow|ask|deny>  (aktuell: ${current})${ANSI.reset}\n`);
      return;
    }
    if (level === 'ask') delete config.toolPermissions[toolName];
    else config.toolPermissions[toolName] = level;
    saveConfig(config);
    console.log(`${ANSI.dim}Permission fuer "${toolName}": ${level}${ANSI.reset}\n`);
    return;
  }
  if (cmd === 'plan') {
    if (arg !== 'on' && arg !== 'off') {
      console.log(`${ANSI.error}Nutzung: /plan <on|off>  (aktuell: ${config.planMode ? 'on' : 'off'})${ANSI.reset}\n`);
      return;
    }
    config.planMode = arg === 'on';
    saveConfig(config);
    console.log(
      `${ANSI.dim}Plan-Modus: ${config.planMode ? 'AN -- Schreib-/Shell-/MCP-Tools werden blockiert und nur beschrieben' : 'aus'}${ANSI.reset}\n`
    );
    return;
  }
  if (cmd === 'autoapprove') {
    if (arg !== 'on' && arg !== 'off') {
      console.log(`${ANSI.error}Nutzung: /autoapprove <on|off>  (aktuell: ${config.autoApprove ? 'on' : 'off'})${ANSI.reset}\n`);
      return;
    }
    config.autoApprove = arg === 'on';
    saveConfig(config);
    console.log(
      `${ANSI.dim}Auto-Approve: ${config.autoApprove ? 'AN -- Bestaetigungen werden uebersprungen, ausser bei explizitem "deny"' : 'aus'}${ANSI.reset}\n`
    );
    return;
  }
  if (cmd === 'swarmautonomy') {
    if (arg !== 'on' && arg !== 'off') {
      console.log(`${ANSI.error}Nutzung: /swarmautonomy <on|off>  (aktuell: ${config.swarmAutonomy ? 'on' : 'off'})${ANSI.reset}\n`);
      return;
    }
    config.swarmAutonomy = arg === 'on';
    saveConfig(config);
    console.log(
      `${ANSI.dim}Swarm/Hive-Autonomie: ${config.swarmAutonomy ? 'AN -- /agent, /swarm und /hive fragen nicht mehr nach, gefaehrliche Befehle werden stattdessen blockiert' : 'aus -- /agent, /swarm und /hive fragen wieder wie im Einzel-Chat nach'}${ANSI.reset}\n`
    );
    return;
  }
  if (cmd === 'mcp') {
    const [sub, ...rest2] = arg.split(' ');
    if (sub === 'list') {
      if (!mcpClients.size) {
        console.log(`${ANSI.dim}(keine verbundenen MCP-Server)${ANSI.reset}\n`);
        return;
      }
      for (const [name, client] of mcpClients) {
        console.log(`${ANSI.dim}${name}: ${client.tools.map((t) => t.name).join(', ') || '(keine Tools)'}${ANSI.reset}`);
      }
      console.log('');
      return;
    }
    if (sub === 'disconnect') {
      const name = rest2[0];
      const client = mcpClients.get(name);
      if (!client) {
        console.log(`${ANSI.error}MCP-Server "${name}" nicht verbunden.${ANSI.reset}\n`);
        return;
      }
      client.close();
      mcpClients.delete(name);
      console.log(`${ANSI.dim}MCP-Server "${name}" getrennt.${ANSI.reset}\n`);
      return;
    }
    if (sub === 'connect') {
      const [name, command, ...cmdArgs] = rest2;
      if (!name || !command) {
        console.log(`${ANSI.error}Nutzung: /mcp connect <name> <kommando> [args...]${ANSI.reset}\n`);
        return;
      }
      console.log(`${ANSI.dim}Verbinde mit MCP-Server "${name}" (${command} ${cmdArgs.join(' ')})...${ANSI.reset}`);
      try {
        const client = new MCPClient(name, command, cmdArgs);
        const tools = await client.initialize();
        mcpClients.set(name, client);
        console.log(`${ANSI.dim}OK: ${tools.length} Tool(s) von "${name}": ${tools.map((t) => t.name).join(', ')}${ANSI.reset}\n`);
      } catch (err) {
        console.log(`${ANSI.error}FEHLER beim Verbinden: ${err.message || err}${ANSI.reset}\n`);
      }
      return;
    }
    console.log(`${ANSI.error}Nutzung: /mcp connect <name> <kommando> [args...] | /mcp list | /mcp disconnect <name>${ANSI.reset}\n`);
    return;
  }

  if (cmd === 'help') {
    if (!arg) {
      console.log(`${ANSI.dim}Befehle (${ANSI.bold}/help <befehl>${ANSI.reset}${ANSI.dim} fuer Details):${ANSI.reset}`);
      for (const group of COMMAND_GROUPS) {
        console.log(`\n${ANSI.accent}${group.title}${ANSI.reset}`);
        for (const name of group.commands) {
          const h = COMMAND_HELP[name];
          console.log(`${ANSI.dim}  /${name.padEnd(16)} ${h ? h.short : ''}${ANSI.reset}`);
        }
      }
      const custom = listCustomCommands();
      if (custom.length) {
        console.log(`${ANSI.dim}Eigene Commands (commands/*.md):${ANSI.reset}`);
        for (const name of custom) {
          console.log(`${ANSI.dim}  /${name}${ANSI.reset}`);
        }
      }
      console.log('');
      return;
    }
    const key = arg.replace(/^\//, '');
    const h = COMMAND_HELP[key];
    if (!h) {
      console.log(`${ANSI.error}Kein Hilfetext fuer "${key}". /help zeigt alle Befehle.${ANSI.reset}\n`);
      return;
    }
    console.log(`${ANSI.bold}/${key}${ANSI.reset} ${ANSI.dim}-- ${h.short}${ANSI.reset}`);
    if (h.long) console.log(`${ANSI.dim}${h.long}${ANSI.reset}`);
    console.log('');
    return;
  }

  const customTemplate = loadCustomCommand(cmd);
  if (customTemplate) {
    await handleMessage(renderCommand(customTemplate, arg));
    return;
  }

  console.log(`${ANSI.error}Unbekannter Befehl. Eigene Commands: ${listCustomCommands().join(', ') || '(keine)'}${ANSI.reset}\n`);
}

// Aus handleCommand('/swarm ...') UND '/team ...' aufrufbar (gleiche Logik, nur der
// Einstiegspunkt unterscheidet sich).
// Nur im Loop-Modus verfuegbar (siehe runLoopCommand) -- eine Rolle kann damit die GESAMTE
// mehrstufige Aufgabe als fertig markieren und den Loop vor dem naechsten geplanten
// Durchlauf beenden. Bewusst getrennt von "dieser einzelne Durchlauf ist fertig" (das meldet
// jeder normale Zug ohnehin durch schlichtes Nicht-mehr-Tool-Aufrufen).
const MARK_COMPLETE_TOOL = {
  type: 'function',
  function: {
    name: 'mark_task_complete',
    description:
      'Nur im Loop-Modus: markiert die GESAMTE Mehrfach-Durchlauf-Aufgabe als abgeschlossen und beendet den Loop. ' +
      'Nur aufrufen, wenn wirklich alles fertig ist -- nicht nur dieser einzelne Durchlauf.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Kurze Begruendung, warum die Gesamtaufgabe fertig ist' } },
      required: ['reason'],
    },
  },
};

// "/swarm loop [n] <aufgabe>" / "/hive loop [n] <aufgabe>" / "/team loop [n] <aufgabe>" --
// n ist optional; OHNE n laeuft der Loop UNBEGRENZT (bis mark_task_complete oder manuelles
// /stop waehrend des Laufs). Mit expliziter Zahl bleibt eine feste Obergrenze weiter moeglich.
// Kein echter Hintergrundprozess (bleibt synchron/REPL-gebunden wie der Rest des Tools) --
// laeuft einfach hintereinander im aktuellen Prozess, nutzt dabei automatisch die Projekt-
// Gedaechtnis-Datei (Phase B) als wachsenden Kontext, so dass Durchlauf 2 auf Durchlauf 1
// aufbaut statt neu anzufangen.
function parseLoopArgs(arg) {
  const parts = arg.split(' ');
  if (parts[0] !== 'loop') return null;
  const rest = parts.slice(1);
  const maybeN = Number(rest[0]);
  const hasN = Number.isInteger(maybeN) && maybeN > 0;
  const n = hasN ? maybeN : Infinity;
  const task = (hasN ? rest.slice(1) : rest).join(' ').trim();
  return { n, task };
}

async function runLoopCommand(kind, n, task) {
  const unbounded = !Number.isFinite(n);
  console.log(
    `${ANSI.dim}${kind === 'hive' ? 'Hive' : 'Swarm'}-Loop startet: ${unbounded ? 'unbegrenzt viele Durchlaeufe' : `bis zu ${n} Durchlaeufe`} ` +
      `(bricht frueher ab bei mark_task_complete). Waehrend des Laufs "/stop" oder "stop" + Enter tippen, um manuell abzubrechen.${ANSI.reset}\n`
  );
  loopActive = true;
  loopStopRequested = false;
  try {
    for (let i = 1; unbounded || i <= n; i++) {
      console.log(`\n${ANSI.accent}${ANSI.bold}=== Loop-Durchlauf ${i}${unbounded ? '' : `/${n}`} ===${ANSI.reset}`);
      let stopped = false;
      let stopReason = '';
      const loopBuildTools = (root, toolOpts) => [...buildToolDefinitions(root, toolOpts), MARK_COMPLETE_TOOL];
      const loopFileToolCall = (toolCall) => {
        if (toolCall.function.name === 'mark_task_complete') {
          let args = {};
          try {
            args = JSON.parse(toolCall.function.arguments || '{}');
          } catch {
            /* leeres Objekt reicht als Fallback */
          }
          stopped = true;
          stopReason = args.reason || '(kein Grund angegeben)';
          return `OK: Gesamtaufgabe als abgeschlossen markiert (${stopReason}).`;
        }
        return handleToolCall(toolCall, { swarmMode: true });
      };

      if (kind === 'hive') {
        await runHiveCommand(task, { buildToolDefinitions: loopBuildTools, onFileToolCall: loopFileToolCall });
      } else {
        await runSwarmCommand(task, { buildToolDefinitions: loopBuildTools, onFileToolCall: loopFileToolCall });
      }

      if (stopped) {
        console.log(`\n${ANSI.dim}Loop vorzeitig beendet nach Durchlauf ${i}: ${stopReason}${ANSI.reset}\n`);
        return;
      }
      if (loopStopRequested) {
        console.log(`\n${ANSI.dim}Loop auf Nutzerwunsch nach Durchlauf ${i} gestoppt.${ANSI.reset}\n`);
        return;
      }
    }
    console.log(`${ANSI.dim}Loop-Limit (${n}) erreicht -- Loop beendet.${ANSI.reset}\n`);
  } finally {
    loopActive = false;
    loopStopRequested = false;
  }
}

// opts.buildToolDefinitions/opts.onFileToolCall: Ueberschreibbar fuer den Loop-Modus (fuegt
// dort das mark_task_complete-Tool hinzu) -- normale Einzel-Laeufe nutzen unveraendert die
// Standardwerte, kein Verhaltensunterschied ausserhalb von /swarm loop.
// Auf Nutzerwunsch: VOR dem Start zeigen, welche Rollen-Modelle bereits als unzuverlaessig
// markiert sind, statt es den Nutzer erst mitten im Lauf per [Modell-Wechsel]-Zeile entdecken
// zu lassen. Rein informativ -- pickEffectiveModel weicht ohnehin automatisch aus, hier geht
// es nur um Sichtbarkeit VORHER, keine zusaetzliche Bestaetigungsfrage noetig.
function preflightHealthWarning(modelKeys) {
  const unique = [...new Set(modelKeys)];
  const unhealthy = listHealth(unique).filter((h) => h.unhealthy);
  if (!unhealthy.length) return null;
  return unhealthy.map((h) => `  - ${h.key}: ${h.reason}`).join('\n');
}

async function runSwarmCommand(task, opts = {}) {
  const buildTools = opts.buildToolDefinitions || buildToolDefinitions;
  const fileToolCall = opts.onFileToolCall || ((toolCall) => handleToolCall(toolCall, { swarmMode: true }));
  const roles = loadAgentRoles();
  if (!roles.length) {
    console.log(`${ANSI.error}Keine Agent-Rollen in ${AGENTS_DIR} gefunden (JSON-Dateien anlegen, siehe README).${ANSI.reset}\n`);
    return;
  }
  const order = loadPipelineOrder(roles.map((r) => r.name));
  const orderedRoles = order.map((n) => roles.find((r) => r.name === n)).filter(Boolean);
  if (!orderedRoles.length) {
    console.log(`${ANSI.error}Pipeline-Reihenfolge (agents/pipeline.json) passt zu keiner vorhandenen Rolle.${ANSI.reset}\n`);
    return;
  }
  const swarmPreflight = preflightHealthWarning(orderedRoles.map((r) => r.model));
  if (swarmPreflight) {
    console.log(`${ANSI.error}[Vorab-Check] Aktuell unzuverlaessig markiert (wird automatisch ersetzt):\n${swarmPreflight}${ANSI.reset}`);
  }
  console.log(`${ANSI.dim}Swarm startet (autonom, keine Bestaetigungsfragen -- /swarmautonomy off zum Abschalten): ${orderedRoles.map((r) => r.label).join(' -> ')}${ANSI.reset}`);
  let retryCount = 0;
  let emptyTurnCount = 0;
  let turnCount = 0;
  let stopWaiting = () => {};
  let firstOutput = true;
  const beforeFiles = new Set(touchedFiles);
  try {
    const transcript = await runSwarm({
      config,
      task,
      roles: orderedRoles,
      buildToolDefinitions: buildTools,
      projectContext: buildAgentContext(config.projectRoot, task),
      onAgentStart: (role) => {
        turnCount++;
        console.log(`\n\n${ANSI.accent}${ANSI.bold}=== ${role.label} (${role.model}) ===${ANSI.reset}`);
        firstOutput = true;
        stopWaiting = makeWaitIndicator(`${ANSI.dim}(wartet auf Modell-Antwort)${ANSI.reset}`);
      },
      onChunk: (delta) => {
        if (firstOutput) { stopWaiting(true); firstOutput = false; }
        process.stdout.write(delta);
      },
      onNotice: (text) => console.log(`\n${ANSI.accent}[Nachricht] ${text}${ANSI.reset}`),
      onFileToolCall: (toolCall) => {
        if (firstOutput) { stopWaiting(true); firstOutput = false; }
        return fileToolCall(toolCall);
      },
      onRetry: (...args) => { retryCount++; stopWaiting(true); printRetry(...args); firstOutput = true; },
      onEmptyTurn: (role, detail) => { emptyTurnCount++; stopWaiting(true); printEmptyTurn(role, detail); },
      onModelSwap: printModelSwap,
    });
    addUsageTotals(transcript.usageTotals);
    console.log(`\n${ANSI.dim}Swarm fertig. (${turnCount} Zuege, ${retryCount} Retries, ${emptyTurnCount} leere Zuege) -- Trace-ID: ${transcript.runId} (Details: /trace ${transcript.runId})${ANSI.reset}\n`);
    const newFiles = [...touchedFiles].filter((f) => !beforeFiles.has(f));
    const lastMsg = transcript[transcript.length - 1];
    appendProjectMemory(config.projectRoot, {
      task,
      files: newFiles,
      summary: lastMsg ? shorten(lastMsg.content, 500) : '(keine Textzusammenfassung)',
      lessons: formatLessons(transcript.mistakeLog),
    });
  } catch (err) {
    stopWaiting(true);
    console.log(`\n${ANSI.error}Swarm-Fehler: ${err.message || err}${ANSI.reset}\n`);
  }
}

// Aus handleCommand('/hive ...') UND '/team ...' aufrufbar.
async function runHiveCommand(task, opts = {}) {
  const buildTools = opts.buildToolDefinitions || buildToolDefinitions;
  const fileToolCall = opts.onFileToolCall || ((toolCall) => handleToolCall(toolCall, { swarmMode: true }));
  const roles = loadAgentRoles();
  const coordinatorRole = roles.find((r) => r.name === 'coordinator');
  const workerRoles = roles.filter((r) => r.name !== 'coordinator');
  if (!coordinatorRole) {
    console.log(`${ANSI.error}Keine "coordinator"-Rolle in ${AGENTS_DIR} gefunden (agents/coordinator.json fehlt).${ANSI.reset}\n`);
    return;
  }
  if (!workerRoles.length) {
    console.log(`${ANSI.error}Keine Worker-Rollen gefunden (ausser Coordinator).${ANSI.reset}\n`);
    return;
  }
  const hivePreflight = preflightHealthWarning([coordinatorRole.model, ...workerRoles.map((r) => r.model)]);
  if (hivePreflight) {
    console.log(`${ANSI.error}[Vorab-Check] Aktuell unzuverlaessig markiert (wird automatisch ersetzt):\n${hivePreflight}${ANSI.reset}`);
  }
  console.log(
    `${ANSI.dim}Hive startet (autonom, keine Bestaetigungsfragen -- /swarmautonomy off zum Abschalten): ${coordinatorRole.label} verteilt an bis zu ${workerRoles.length} Worker (${workerRoles.map((r) => r.name).join(', ')})${ANSI.reset}`
  );
  let retryCount = 0;
  let emptyTurnCount = 0;
  let workerCount = 0;
  let workerErrorCount = 0;
  let stopWaiting = () => {};
  let firstOutput = true;
  // Worker laufen PARALLEL (Promise.all) -- ein \r-Overwrite-Heartbeat auf einer gemeinsamen
  // Zeile wuerde bei mehreren gleichzeitigen Workern nur wirres Ueberschreiben produzieren.
  // Deshalb hier overwrite:false (eigene Log-Zeile alle 15s, sicher unter Nebenlaeufigkeit).
  const workerWaiters = new Map();
  let coordinatorRetries = 0;
  const beforeFiles = new Set(touchedFiles);
  try {
    const result = await runHive({
      config,
      task,
      coordinatorRole,
      workerRoles,
      buildToolDefinitions: buildTools,
      projectContext: buildAgentContext(config.projectRoot, task),
      onAgentStart: (r) => {
        console.log(`\n\n${ANSI.accent}${ANSI.bold}=== ${r.label} (${r.model}) ===${ANSI.reset}`);
        firstOutput = true;
        stopWaiting = makeWaitIndicator(`${ANSI.dim}(wartet auf Modell-Antwort)${ANSI.reset}`);
      },
      onChunk: (delta) => {
        if (firstOutput) { stopWaiting(true); firstOutput = false; }
        process.stdout.write(delta);
      },
      onWorkerStart: (role, task, workerId) => {
        workerCount++;
        console.log(`\n${ANSI.accent}[Worker] ${role.label} (${role.model}) startet: ${task}${ANSI.reset}`);
        workerWaiters.set(workerId, makeWaitIndicator(`  [${role.label}] arbeitet noch`, { overwrite: false, intervalMs: 15000 }));
      },
      onWorkerDone: (role, text, error, workerId) => {
        const stop = workerWaiters.get(workerId);
        if (stop) { stop(false); workerWaiters.delete(workerId); }
        if (error) {
          workerErrorCount++;
          console.log(`${ANSI.error}[Worker] ${role.label} FEHLER: ${error}${ANSI.reset}`);
        } else {
          console.log(`${ANSI.dim}[Worker] ${role.label} fertig: ${text.length > 300 ? text.slice(0, 300) + '...' : text}${ANSI.reset}`);
        }
      },
      onFileToolCall: (toolCall) => {
        if (firstOutput) { stopWaiting(true); firstOutput = false; }
        return fileToolCall(toolCall);
      },
      onRetry: (...args) => { retryCount++; stopWaiting(true); printRetry(...args); firstOutput = true; },
      onEmptyTurn: (role, detail) => { emptyTurnCount++; stopWaiting(true); printEmptyTurn(role, detail); },
      onModelSwap: printModelSwap,
      onCoordinatorRetry: (attempt) => {
        coordinatorRetries++;
        console.log(`\n${ANSI.error}[Coordinator-Neustart] Vorheriger Versuch hat keinen Worker gestartet -- Versuch ${attempt}...${ANSI.reset}`);
      },
    });
    // Sicherheitsnetz: normalerweise raeumt onWorkerDone jeden Eintrag selbst ab, aber falls
    // doch mal einer haengen bleibt (z.B. ein nie aufgeloester Promise-Zweig), hier hart stoppen
    // statt einen tickenden Heartbeat nach Lauf-Ende weiterlaufen zu lassen.
    for (const stop of workerWaiters.values()) stop(false);
    workerWaiters.clear();
    addUsageTotals(result.usageTotals);
    if (!result.dispatchHappened) {
      console.log(
        `\n${ANSI.error}[Fehlschlag] Coordinator hat trotz ${coordinatorRetries + 1} Versuch(en) keinen einzigen Worker gestartet (zuletzt versucht mit "${result.lastModel || coordinatorRole.model}" -- haeufige Ursache: wiederholte Server-Ueberlastung oder leere Antworten). Aufgabe erneut per /hive versuchen oder /model fuer die Coordinator-Rolle wechseln.${ANSI.reset}\n`
      );
    } else {
      console.log(
        `\n${ANSI.dim}Hive fertig. (${workerCount} Worker gestartet, ${workerErrorCount} Fehler, ${retryCount} Retries, ${emptyTurnCount} leere Zuege${coordinatorRetries ? `, ${coordinatorRetries} Coordinator-Neustarts` : ''}) -- Trace-ID: ${result.runId} (Details: /trace ${result.runId})${ANSI.reset}\n`
      );
      let newFiles = [...touchedFiles].filter((f) => !beforeFiles.has(f));
      let finalSummary = result.finalText || '(keine Textzusammenfassung)';

      console.log(`${ANSI.dim}[Konsens] 3 unabhaengige Modelle pruefen das Ergebnis...${ANSI.reset}`);
      const consensus = await runConsensusCheck({
        config,
        task,
        files: newFiles,
        buildToolDefinitions: buildTools,
        onFileToolCall: fileToolCall,
        onRetry: printRetry,
        runId: result.runId,
      });
      for (const v of consensus.votes) {
        console.log(`${ANSI.dim}[Konsens] ${v.model}: ${v.verdict} -- ${shorten(v.reason, 200)}${ANSI.reset}`);
      }

      if (!consensus.approved) {
        console.log(`${ANSI.error}[Konsens] Mehrheit: NACHBESSERUNG -- ein zusaetzlicher Coordinator-Durchlauf mit dem Feedback startet.${ANSI.reset}`);
        const feedback = consensus.votes.map((v) => `- ${v.model}: ${v.reason}`).join('\n');
        const followupTask = `${task}\n\nHINWEIS: Eine unabhaengige Konsens-Pruefung durch 3 Modelle hat NACHBESSERUNG entschieden. Begruendungen:\n${feedback}\nBitte behebe das jetzt.`;
        const beforeFollowup = new Set(touchedFiles);
        try {
          const followupResult = await runHive({
            config,
            task: followupTask,
            coordinatorRole,
            workerRoles,
            buildToolDefinitions: buildTools,
            projectContext: buildAgentContext(config.projectRoot, followupTask),
            runId: result.runId,
            onAgentStart: (r) => console.log(`\n\n${ANSI.accent}${ANSI.bold}=== ${r.label} (${r.model}) [Nachbesserung] ===${ANSI.reset}`),
            onChunk: (delta) => process.stdout.write(delta),
            onWorkerStart: (role, t) => console.log(`\n${ANSI.accent}[Worker] ${role.label} startet (Nachbesserung): ${t}${ANSI.reset}`),
            onWorkerDone: (role, text, error) =>
              console.log(
                error
                  ? `${ANSI.error}[Worker] ${role.label} FEHLER: ${error}${ANSI.reset}`
                  : `${ANSI.dim}[Worker] ${role.label} fertig.${ANSI.reset}`
              ),
            onFileToolCall: fileToolCall,
            onRetry: printRetry,
            onEmptyTurn: printEmptyTurn,
            onModelSwap: printModelSwap,
          });
          console.log(`\n${ANSI.dim}Nachbesserung abgeschlossen (kein weiterer Konsens-Check, um Pingpong zu vermeiden).${ANSI.reset}\n`);
          const followupFiles = [...touchedFiles].filter((f) => !beforeFollowup.has(f));
          newFiles = [...new Set([...newFiles, ...followupFiles])];
          finalSummary = followupResult.finalText || finalSummary;
        } catch (err) {
          console.log(`${ANSI.error}[Konsens-Nachbesserung] fehlgeschlagen: ${err.message || err}${ANSI.reset}\n`);
        }
      } else {
        console.log(`${ANSI.dim}[Konsens] Mehrheit: FERTIG.${ANSI.reset}\n`);
      }

      appendProjectMemory(config.projectRoot, {
        task,
        files: newFiles,
        summary: shorten(finalSummary, 500),
        lessons: formatLessons(result.mistakeLog),
      });
    }
  } catch (err) {
    stopWaiting(true);
    for (const stop of workerWaiters.values()) stop(false);
    console.log(`\n${ANSI.error}Hive-Fehler: ${err.message || err}${ANSI.reset}\n`);
  }
}

// ponytail: keine echte Tokenzaehlung moeglich (OpenAI-kompatible Endpunkte haben kein
// count_tokens) -- Zeichenlaenge als grobe Naeherung (~4 Zeichen/Token, konservativ). Bei
// Ueberschreitung fasst das Modell selbst die AELTEREN Nachrichten zusammen, die letzten
// paar Zuege bleiben woertlich erhalten (der Kontext, der gerade am wichtigsten ist).
const MAX_HISTORY_CHARS = 60000;
const KEEP_RECENT_MESSAGES = 4;

async function compactHistoryIfNeeded() {
  const totalChars = messages.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0);
  if (totalChars < MAX_HISTORY_CHARS || messages.length <= KEEP_RECENT_MESSAGES) return;

  const toSummarize = messages.slice(0, -KEEP_RECENT_MESSAGES);
  const recent = messages.slice(-KEEP_RECENT_MESSAGES);
  const transcript = toSummarize.map((m) => `[${m.role}]: ${m.content}`).join('\n\n');

  console.log(`${ANSI.dim}[Kontext-Kompaktierung] ${toSummarize.length} aeltere Nachrichten werden zusammengefasst...${ANSI.reset}`);
  try {
    const result = await sendChat({
      config,
      messages: [
        { role: 'system', content: 'Fasse den folgenden Gespraechsverlauf knapp zusammen (Kernpunkte, Entscheidungen, offene Fragen). Max. 300 Woerter, auf Deutsch.' },
        { role: 'user', content: transcript },
      ],
      tools: [],
      onChunk: () => {},
      onToolCall: async () => 'FEHLER: Tools sind bei der Zusammenfassung nicht verfuegbar.',
      onRetry: printRetry,
    });
    messages = [{ role: 'user', content: `Zusammenfassung des bisherigen Verlaufs:\n${result.finalText}` }, ...recent];
    console.log(`${ANSI.dim}[Kontext-Kompaktierung] fertig (${totalChars} -> ${messages.reduce((s, m) => s + m.content.length, 0)} Zeichen).${ANSI.reset}\n`);
  } catch (err) {
    console.log(`${ANSI.error}[Kontext-Kompaktierung] fehlgeschlagen (${err.message || err}) -- Verlauf bleibt unveraendert.${ANSI.reset}\n`);
  }
}

// Ein Versuch mit `activeConfig` (kann der Fallback-Config entsprechen). Wirft weiter,
// wenn es fehlschlaegt -- handleMessage entscheidet, ob/wie ein zweiter Versuch folgt.
async function attemptChat(activeConfig) {
  const styleMsg = styleSystemMessage(activeConfig.style);
  const effortMsg = effortSystemMessage(activeConfig.effort);
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const agentContext = buildAgentContext(activeConfig.projectRoot, lastUserMsg ? lastUserMsg.content : '');
  const projectMsg = agentContext ? { role: 'system', content: agentContext } : null;
  const extraMessages = [fableSystemMessage(), styleMsg, effortMsg, projectMsg].filter(Boolean);
  let assistantText = '';
  let firstOutput = true;
  let stopWaiting = makeWaitIndicator(`${ANSI.dim}(wartet auf Modell-Antwort)${ANSI.reset}`);
  try {
    const result = await sendChat({
      config: activeConfig,
      messages: extraMessages.length ? [...extraMessages, ...messages] : messages,
      tools: buildToolDefinitions(activeConfig.projectRoot),
      maxTokens: effortMaxTokens(activeConfig.effort),
      onChunk: (delta) => {
        if (firstOutput) { stopWaiting(true); firstOutput = false; }
        process.stdout.write(delta);
        assistantText += delta;
      },
      onToolCall: (toolCall) => {
        if (firstOutput) { stopWaiting(true); firstOutput = false; }
        return handleToolCall(toolCall);
      },
      onRetry: (...args) => {
        stopWaiting(true);
        printRetry(...args);
        firstOutput = true;
        stopWaiting = makeWaitIndicator(`${ANSI.dim}(wartet auf Modell-Antwort)${ANSI.reset}`);
      },
    });
    return { result, assistantText };
  } finally {
    stopWaiting(true);
  }
}

// Judge-Panel + Adversarial-Verify in einer schlanken Implementierung: 3 verschiedene
// Modell-Presets bearbeiten dieselbe Aufgabe unabhaengig und PARALLEL (Promise.all -- die
// Kandidaten sehen sich gegenseitig nicht, echte Unabhaengigkeit), ein vierter Richter-Call
// (bewusst ein Modell, das nicht im Panel sitzt, gegen Selbst-Bevorzugung) waehlt die beste
// Antwort oder synthetisiert eine bessere aus den staerksten Teilen.
const PANEL_MODELS = ['deepseek-v4', 'qwen-397b', 'kimi-k2.6'];
// ponytail: glm-5 (z-ai/glm-5.2) hat in dieser Session wiederholt 140s+ bis zum ersten Byte
// gebraucht (Server-Latenz, kein Bug) -- als Standard-Richter unbrauchbar. nemotron-super
// (anderer Provider, OpenRouter statt NIM) war in Tests durchgehend zuegig.
const PANEL_JUDGE_MODEL = 'nemotron-super';

async function runPanelCommand(task) {
  console.log(`${ANSI.dim}Panel startet (parallel): ${PANEL_MODELS.join(', ')} -- Richter: ${PANEL_JUDGE_MODEL}${ANSI.reset}`);

  const candidates = await Promise.all(
    PANEL_MODELS.map(async (modelKey) => {
      const candidateConfig = { ...config, activeModel: modelKey };
      let text = '';
      try {
        await sendChat({
          config: candidateConfig,
          messages: [{ role: 'user', content: task }],
          tools: [],
          onChunk: (d) => { text += d; },
          onToolCall: async () => 'FEHLER: Tools sind im Panel-Modus nicht verfuegbar.',
          onRetry: printRetry,
        });
        return { model: modelKey, text, error: null };
      } catch (err) {
        return { model: modelKey, text: '', error: err.message || String(err) };
      }
    })
  );

  for (const c of candidates) {
    console.log(`\n${ANSI.accent}${ANSI.bold}=== Kandidat: ${c.model} ===${ANSI.reset}`);
    console.log(c.error ? `${ANSI.error}FEHLER: ${c.error}${ANSI.reset}` : `${ANSI.dim}${c.text}${ANSI.reset}`);
  }

  const valid = candidates.filter((c) => !c.error && c.text.trim());
  if (valid.length < 2) {
    console.log(`${ANSI.error}Zu wenige gueltige Kandidaten fuer eine Richter-Bewertung.${ANSI.reset}\n`);
    return;
  }

  const judgePrompt =
    `Aufgabe: ${task}\n\n` +
    valid.map((c, i) => `Kandidat ${i + 1} (${c.model}):\n${c.text}`).join('\n\n---\n\n') +
    `\n\nBewerte die Kandidaten-Antworten oben kurz und waehle die beste ODER synthetisiere eine bessere Antwort aus den staerksten Teilen. Begruendung in 2-3 Saetzen, danach die finale Antwort.`;

  console.log(`\n${ANSI.accent}${ANSI.bold}=== Richter (${PANEL_JUDGE_MODEL}) ===${ANSI.reset}`);
  try {
    const judgeConfig = { ...config, activeModel: PANEL_JUDGE_MODEL };
    await sendChat({
      config: judgeConfig,
      messages: [{ role: 'user', content: judgePrompt }],
      tools: [],
      onChunk: (d) => process.stdout.write(d),
      onToolCall: async () => 'FEHLER: Tools sind im Panel-Modus nicht verfuegbar.',
      onRetry: printRetry,
    });
    console.log(`\n${ANSI.dim}Panel fertig.${ANSI.reset}\n`);
  } catch (err) {
    console.log(`\n${ANSI.error}Richter-Fehler: ${err.message || err}${ANSI.reset}\n`);
  }
}

async function handleMessage(text) {
  await compactHistoryIfNeeded();
  messages.push({ role: 'user', content: text });
  try {
    const { result, assistantText } = await attemptChat(config);
    messages.push({ role: 'assistant', content: assistantText });
    saveSession(messages);
    addUsage(result.usage);
    const usageSuffix = result.usage ? `, ${result.usage.prompt_tokens}+${result.usage.completion_tokens} Tokens` : '';
    console.log(`\n${ANSI.dim}(${result.model} via ${result.provider}${usageSuffix})${ANSI.reset}\n`);
  } catch (err) {
    if (config.fallbackModel && config.fallbackModel !== config.activeModel) {
      console.log(`${ANSI.error}[Fallback] ${err.message || err} -- versuche Fallback-Modell "${config.fallbackModel}"...${ANSI.reset}`);
      try {
        const fallbackConfig = { ...config, activeModel: config.fallbackModel };
        const { result, assistantText } = await attemptChat(fallbackConfig);
        messages.push({ role: 'assistant', content: assistantText });
        saveSession(messages);
        addUsage(result.usage);
        console.log(`\n${ANSI.dim}(Fallback: ${result.model} via ${result.provider})${ANSI.reset}\n`);
        return;
      } catch (err2) {
        console.log(`${ANSI.error}[Fallback] ebenfalls fehlgeschlagen: ${err2.message || err2}${ANSI.reset}`);
      }
    }
    console.log(`\n${ANSI.error}Fehler: ${err.message || err}${ANSI.reset}\n`);
    messages.pop();
  }
}

// Kein rl.question() -- das laeuft ueber Nodes eigene 'line'-Behandlung und koennte mit
// dem persistenten rl.on('line', ...) unten kollidieren (Antwort doppelt verarbeitet).
// Stattdessen: eine Frage-QUEUE (nicht nur ein einzelnes Pending-Flag) -- /hive laesst
// mehrere Worker PARALLEL laufen, die gleichzeitig write_file/make_directory aufrufen
// koennen. Mit nur einer einzelnen Pending-Variable wuerde eine zweite gleichzeitige Frage
// die erste resolve-Funktion ueberschreiben, bevor der Nutzer geantwortet hat -- der erste
// Worker haengt dann fuer immer. Die Queue zeigt Fragen nacheinander an und beantwortet sie
// in der Reihenfolge, in der sie ankamen. askQuestion liefert die rohe Antwort (getrimmt);
// askConfirmation baut y/N-Auswertung nur noch obendrauf -- /team nutzt askQuestion direkt
// fuer die Swarm/Hive-Auswahl.
const questionQueue = [];
let questionActive = false;

// Loop-Abbruch per Prompt WAEHREND ein Loop laeuft: braucht denselben Seitenkanal-Trick wie
// die Frage-Queue oben, sonst wuerde eine getippte "/stop"-Zeile einfach hinten an die
// normale Befehls-Queue angehaengt und erst NACH dem kompletten (jetzt potenziell
// unbegrenzten) Loop verarbeitet -- der Nutzer koennte also gar nicht eingreifen. loopActive
// wird von runLoopCommand gesetzt/zurueckgesetzt, loopStopRequested von rl.on('line') unten.
let loopActive = false;
let loopStopRequested = false;
const STOP_COMMANDS = new Set(['/stop', 'stop', '/abbrechen', 'abbrechen']);

function processQuestionQueue() {
  if (questionActive || !questionQueue.length) return;
  questionActive = true;
  process.stdout.write(questionQueue[0].promptText);
}

function askQuestion(promptText) {
  return new Promise((resolve) => {
    questionQueue.push({ promptText, resolve });
    processQuestionQueue();
  });
}

function askConfirmation(promptText) {
  return askQuestion(promptText).then((answer) => /^(y|yes|j|ja)$/i.test(answer));
}

// Auf Nutzerwunsch: "Allow once/Always/Reject" statt reinem y/N -- "Always" spart die
// wiederholte Nachfrage fuer dasselbe Tool (setzt /permission <tool> allow direkt). ponytail:
// bewusst NUMMERIERTE Textauswahl statt echtem Pfeiltasten-Menu -- ein echtes Menu braucht
// TTY-Raw-Mode-Keypress-Events, die mit der bestehenden Frage-Queue (siehe questionQueue oben,
// gebaut fuer GLEICHZEITIGE Bestaetigungsfragen von parallelen Hive-Workern) kollidieren
// wuerden. Gleicher Funktionsgewinn (3 Optionen statt 2), ohne dieses Risiko.
async function askToolConfirmation(promptText) {
  const answer = (await askQuestion(`${promptText}\n  [1] Einmal erlauben  [2] Immer erlauben  [3] Ablehnen (Enter=1): `)).trim();
  if (answer === '2') return 'always';
  if (answer === '3' || /^(n|no|nein)$/i.test(answer)) return 'reject';
  if (!answer || answer === '1' || /^(y|yes|j|ja)$/i.test(answer)) return 'once';
  return 'reject'; // unbekannte Eingabe -- im Zweifel ablehnen, nicht erlauben
}

// Reads/Listings laufen ohne Nachfrage (nicht destruktiv). write_file/make_directory/
// run_command/MCP-Tools verlangen erst eine explizite Bestaetigung -- das Modell kommt von
// einem Drittanbieter-Endpunkt ohne die gleichen Garantien wie Claude, deshalb kein
// automatisches Schreiben ohne Blick des Nutzers. Reihenfolge: explizites "deny" schlaegt
// immer zu (auch Plan-Modus/Auto-Approve koennen das nicht aufheben) -- Plan-Modus blockiert
// als naechstes alle sonst bestaetigungspflichtigen Tools (nur Beschreibung, keine Ausfuehrung)
// -- explizites "allow" oder globales Auto-Approve ueberspringen die y/N-Nachfrage.
// ctx.swarmMode = true wenn der Aufruf aus /agent, /swarm oder /hive kommt (index.js reicht
// das an den jeweiligen Call-Sites explizit durch). Im Einzel-Chat bleibt ctx leer.
async function handleToolCall(toolCall, ctx = {}) {
  const name = toolCall.function.name;
  let args;
  try {
    args = JSON.parse(toolCall.function.arguments || '{}');
  } catch {
    return `FEHLER: Tool-Argumente nicht parsebar: ${toolCall.function.arguments}`;
  }

  console.log(`\n${ANSI.accent}[Tool] ${formatToolCallForDisplay(name, args)}${ANSI.reset}`);

  const permission = config.toolPermissions[name];

  if (permission === 'deny') {
    console.log(`${ANSI.error}Abgelehnt (Permission "deny" fuer ${name}).${ANSI.reset}`);
    appendAuditLog(AUDIT_LOG_PATH, { name, args, outcome: 'denied-by-permission' });
    return `ABGELEHNT: Tool "${name}" ist per /permission auf "deny" gesetzt.`;
  }

  const needsConfirmationBase = WRITE_TOOLS.has(name) || SHELL_WRITE_TOOLS.has(name) || isMcpTool(name);
  // Explizites deny/Plan-Modus stehen darueber (oben/unten unveraendert) -- Autonomie gilt nur
  // fuer die sonst noetige y/N-Nachfrage, und nur wenn der Nutzer sie nicht per
  // /swarmautonomy off abgeschaltet hat.
  const swarmAutonomyActive = !!ctx.swarmMode && config.swarmAutonomy;

  if (name === 'run_command') {
    const danger = checkDangerous(args.command || '');
    if (danger && swarmAutonomyActive) {
      console.log(`${ANSI.error}${ANSI.bold}[Autonomie-Block] Befehl sieht aus wie "${danger}" -- im autonomen Swarm/Hive-Modus wird das NICHT ausgefuehrt.${ANSI.reset}`);
      appendAuditLog(AUDIT_LOG_PATH, { name, args, outcome: 'blocked-dangerous-in-swarm-mode' });
      return `BLOCKIERT: Befehl wirkt gefaehrlich ("${danger}") und wird im autonomen Modus ohne Rueckfragemoeglichkeit nicht ausgefuehrt. Versuche einen anderen, ungefaehrlicheren Weg.`;
    }
    if (danger) {
      console.log(`${ANSI.error}${ANSI.bold}[GEFAHR] Befehl sieht aus wie "${danger}" -- besonders sorgfaeltig pruefen!${ANSI.reset}`);
    }
  }

  if (needsConfirmationBase && config.planMode) {
    console.log(`${ANSI.error}[Plan-Modus] ${name} wuerde ausgefuehrt, aber Plan-Modus ist aktiv -- keine echte Aenderung.${ANSI.reset}`);
    appendAuditLog(AUDIT_LOG_PATH, { name, args, outcome: 'blocked-by-plan-mode' });
    return `PLAN-MODUS: "${name}" wurde NICHT ausgefuehrt (Plan-Modus aktiv). Beschreibe stattdessen in Worten, was du tun wuerdest.`;
  }

  if (needsConfirmationBase && permission !== 'allow' && !config.autoApprove && !swarmAutonomyActive) {
    if (name === 'write_file' || name === 'edit_file') {
      const diff = previewDiff(config.projectRoot, name, args);
      if (diff) console.log(`${ANSI.dim}${diff}${ANSI.reset}`);
    }
    const decision = await askToolConfirmation(`${ANSI.bold}Erlauben -- ${formatToolCallForDisplay(name, args)}?${ANSI.reset}`);
    if (decision === 'always') {
      config.toolPermissions[name] = 'allow';
      saveConfig(config);
      console.log(`${ANSI.dim}"${name}" dauerhaft erlaubt (siehe /permission).${ANSI.reset}`);
    } else if (decision === 'reject') {
      console.log(`${ANSI.dim}Abgelehnt.${ANSI.reset}`);
      appendAuditLog(AUDIT_LOG_PATH, { name, args, outcome: 'denied-by-user' });
      return 'ABGELEHNT: Der Nutzer hat diesen Vorgang nicht erlaubt.';
    }
  }

  try {
    let result;
    if (name === 'run_command') {
      const stopWaiting = makeWaitIndicator(`  (fuehrt aus: ${shorten(args.command || '', 60)})`);
      try {
        result = await runCommand(config.projectRoot, args);
      } finally {
        stopWaiting(true);
      }
    } else if (name === 'read_background_output') {
      result = readBackgroundOutput(args.id);
    } else if (isMcpTool(name)) {
      const { serverName, toolName } = parseMcpTool(name);
      const client = mcpClients.get(serverName);
      if (!client) throw new Error(`MCP-Server "${serverName}" nicht (mehr) verbunden.`);
      result = await client.callTool(toolName, args);
    } else {
      result = executeTool(config.projectRoot, name, args);
    }
    console.log(`${ANSI.dim}${result.length > 300 ? result.slice(0, 300) + '...' : result}${ANSI.reset}`);

    const injectionHit = scanForInjection(result);
    if (injectionHit) {
      console.log(`${ANSI.error}[Warnung] Tool-Ergebnis enthaelt einen Text, der wie ein Anweisungs-Versuch aussieht (Muster: ${injectionHit}). Inhalt mit Vorsicht behandeln.${ANSI.reset}`);
    }

    if (['write_file', 'edit_file', 'make_directory'].includes(name) && args.path) {
      touchedFiles.add(args.path);
      if (touchedFiles.size >= SCOPE_WARNING_THRESHOLD && !scopeWarningShown) {
        scopeWarningShown = true;
        console.log(
          `${ANSI.error}[Scope-Warnung] ${touchedFiles.size} verschiedene Dateien in dieser Sitzung veraendert -- laesst sich die Aufgabe noch ueberblicken?${ANSI.reset}`
        );
      }
    }

    appendAuditLog(AUDIT_LOG_PATH, { name, args, outcome: 'ok' });
    return result;
  } catch (err) {
    appendAuditLog(AUDIT_LOG_PATH, { name, args, outcome: 'error', error: err.message || String(err) });
    return `FEHLER: ${err.message || err}`;
  }
}

printBanner();
printPrompt();

// readline emits 'line' events without waiting for async handlers, so overlapping
// input (e.g. a message immediately followed by /exit) can race -- queue keeps
// each line's handling fully finished before the next one starts.
let queue = Promise.resolve();

async function processLine(trimmed) {
  if (!trimmed) {
    printPrompt();
    return;
  }
  if (trimmed.startsWith('/')) {
    await handleCommand(trimmed);
  } else {
    await handleMessage(trimmed);
  }
  printPrompt();
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  // Bestaetigungsantworten muessen SOFORT ran, nicht durch die Queue -- die laufende
  // Nachricht wartet ja gerade genau auf diese Zeile. Wuerde man sie mit-queuen, entstuende
  // ein Deadlock (Nachricht wartet auf die Antwort, Antwort wartet in der Queue auf die
  // Nachricht).
  if (questionActive) {
    const { resolve } = questionQueue.shift();
    questionActive = false;
    resolve(trimmed);
    processQuestionQueue();
    return;
  }
  // Gleicher Seitenkanal-Grund wie oben: waehrend ein (jetzt potenziell unbegrenzter) Loop
  // laeuft, muss "/stop" SOFORT wirken, nicht erst nach dem Loop aus der Queue verarbeitet
  // werden -- sonst koennte der Nutzer einen unbegrenzten Loop nie manuell beenden.
  if (loopActive && STOP_COMMANDS.has(trimmed.toLowerCase())) {
    loopStopRequested = true;
    console.log(`${ANSI.dim}[Loop] Abbruch angefordert -- wird nach dem aktuellen Durchlauf gestoppt.${ANSI.reset}`);
    return;
  }
  queue = queue.then(() => processLine(trimmed));
});

rl.on('close', async () => {
  await queue;
  console.log(`${ANSI.dim}Bis bald.${ANSI.reset}`);
  process.exit(0);
});
