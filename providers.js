'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getActiveKey, reportKeyFailure } = require('./keyPool');
const trace = require('./trace');

const CONFIG_DIR = path.join(os.homedir(), '.claude-nemotron-cli');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// Ollama-Standard-Adresse -- Auf Nutzerwunsch ueberschreibbar (config.ollamaBaseUrl, siehe
// resolveTarget), damit ein Ollama-Server auf einem ANDEREN Rechner (z.B. Laptop im selben
// Netzwerk) genutzt werden kann, nicht nur der lokale. Der andere Rechner muss dafuer Ollama
// mit OLLAMA_HOST=0.0.0.0 starten (Standard ist nur 127.0.0.1, von aussen nicht erreichbar)
// und Port 11434 in der Firewall freigeben -- reine Netzwerkkonfiguration, die dieses Tool
// nicht uebernehmen kann.
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

const PROVIDERS = {
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  nim: { label: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1' },
  ollama: { label: 'Ollama', baseUrl: DEFAULT_OLLAMA_BASE_URL },
  custom: { label: 'Custom', baseUrl: '' },
};

// "Die 5 Staerksten" (Stand Recherche dieser Session, DeepSeek/Qwen/Kimi/GLM ueber
// NVIDIA NIM, dort laut mehreren Quellen kostenlos verfuegbar). Alle 4 IDs live gegen
// GET /v1/models + einen echten Chat-Call geprueft (200 OK) -- siehe Debugging-Runde
// nach dem 404-Report: 3 von 4 urspruenglich geratenen IDs waren falsch (Kimi/Qwen
// hatten ein unnoetiges "-instruct"-Suffix, GLM lief unter "z-ai/glm-5.2" statt
// "zhipuai/glm-5"). Bei kuenftigen 404s: GET https://integrate.api.nvidia.com/v1/models
// mit dem eigenen NIM-Key abfragen statt neu zu raten.
const MODEL_PRESETS = {
  'deepseek-v4': { label: 'DeepSeek V4 Flash (staerkstes Reasoning)', provider: 'nim', model: 'deepseek-ai/deepseek-v4-flash' },
  'qwen-397b': { label: 'Qwen 3.5 397B', provider: 'nim', model: 'qwen/qwen3.5-397b-a17b' },
  'kimi-k2.6': { label: 'Kimi K2.6 (Moonshot AI)', provider: 'nim', model: 'moonshotai/kimi-k2.6' },
  'glm-5': { label: 'GLM-5.2 (Z.ai)', provider: 'nim', model: 'z-ai/glm-5.2' },
  'nemotron-super': { label: 'NVIDIA Nemotron 3 Super 120B', provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free' },
  // Weitere verifizierte gratis Optionen (OpenRouter free-models Katalog)
  'nemotron-nano': { label: 'NVIDIA Nemotron 3 Nano 30B (schnell)', provider: 'openrouter', model: 'nvidia/nemotron-3-nano-30b-a3b:free' },
  'nemotron-nano9b': { label: 'NVIDIA Nemotron Nano 9B v2 (sehr schnell)', provider: 'openrouter', model: 'nvidia/nemotron-nano-9b-v2:free' },
  'gpt-oss-120b': { label: 'OpenAI gpt-oss-120b', provider: 'openrouter', model: 'openai/gpt-oss-120b:free' },
  'gpt-oss-20b': { label: 'OpenAI gpt-oss-20b (schnell)', provider: 'openrouter', model: 'openai/gpt-oss-20b:free' },
  'gemma': { label: 'Google Gemma 4 31B', provider: 'openrouter', model: 'google/gemma-4-31b-it:free' },
  // Persoenlich/maschinenspezifisch (anders als die Presets oben, die fuer JEDEN Nutzer dieses
  // Tools gleich funktionieren) -- zeigt auf ein lokales Ollama-Modell, das per /ollamahost auf
  // einem beliebigen Rechner im Netzwerk erreichbar gemacht wird (siehe README). Als Preset
  // (statt nur rohe Modell-ID) angelegt, damit Rollen es einfach ueber role.model referenzieren
  // koennen, OHNE vom aktuellen globalen /provider abzuhaengen (swarm.js ueberschreibt bei
  // Rollen nur activeModel, nicht activeProvider -- eine rohe ID ohne Preset waere fragil).
  'ollama-laptop': { label: 'Qwen 2.5 Coder 14B (lokal, Laptop im Netzwerk)', provider: 'ollama', model: 'qwen2.5-coder:14b' },
};

const DEFAULT_CONFIG = {
  // Je Anbieter eine LISTE von Keys statt nur einem -- mehrere kostenlose Accounts fuer
  // parallele Projekte eintragbar (/addkey), sendChat wechselt automatisch zum naechsten,
  // sobald einer limitiert ist (siehe keyPool.js).
  keys: { openrouter: [], nim: [], ollama: ['ollama'] },
  customBaseUrl: '',
  // Leer = lokaler Standard (DEFAULT_OLLAMA_BASE_URL). Gesetzt (per /ollamahost) = Ollama auf
  // einem anderen Rechner im Netzwerk statt localhost.
  ollamaBaseUrl: '',
  activeModel: 'nemotron-super',
  activeProvider: 'openrouter',
  // Portabler Default statt eines hart codierten Laufwerks (war 'E:\\' -- funktionierte nur
  // auf dem Rechner, auf dem das gebaut wurde; ein anderer Nutzer haette dieses Laufwerk
  // wahrscheinlich gar nicht). Wird bei Bedarf automatisch angelegt (siehe index.js), per
  // /projectroot <pfad> jederzeit aenderbar.
  projectRoot: path.join(os.homedir(), 'nemotron-projects'),
  style: 'off',
  effort: 'high',
  fallbackModel: '',
  toolPermissions: {},
  planMode: false,
  autoApprove: false,
  swarmAutonomy: true,
  // null = automatisch empfohlen anhand der Anzahl eingetragener API-Keys (siehe
  // swarm.js:recommendHiveDepth) -- explizit auf 1-5 setzbar per /hivedepth.
  hiveDepth: null,
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    let needsSave = false;

    // Migration: sehr altes Schema (Claude+Fallback-Split, Sicherheitsfix von vorhin)
    if ('anthropicApiKey' in raw || 'fallback' in raw) {
      raw.apiKey = raw.apiKey || raw.fallback?.apiKey || '';
      delete raw.anthropicApiKey;
      delete raw.activeClaudeModel;
      delete raw.contextThreshold;
      delete raw.fallback;
      needsSave = true;
    }

    // Migration: Zwischen-Schema (flacher apiKey/baseUrl) -> keys{}/activeProvider
    if ('apiKey' in raw && !('keys' in raw)) {
      raw.keys = { openrouter: raw.apiKey || '', nim: '', ollama: 'ollama' };
      raw.activeProvider = 'openrouter';
      delete raw.apiKey;
      delete raw.baseUrl;
      needsSave = true;
    }

    const config = {
      ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
      ...raw,
      keys: { ...DEFAULT_CONFIG.keys, ...(raw.keys || {}) },
    };

    // Migration: einzelner Key als String (altes Schema) -> Liste mit einem Eintrag.
    for (const p of Object.keys(config.keys)) {
      if (typeof config.keys[p] === 'string') {
        config.keys[p] = config.keys[p] ? [config.keys[p]] : [];
        needsSave = true;
      } else if (!Array.isArray(config.keys[p])) {
        config.keys[p] = [];
      }
    }

    if (needsSave) saveConfig(config);
    return config;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* chmod hat auf Windows nur eingeschraenkte Wirkung -- kein Fehlerfall */
  }
}

function resolveTarget(config) {
  const preset = MODEL_PRESETS[config.activeModel];
  const provider = preset ? preset.provider : config.activeProvider;
  const model = preset ? preset.model : config.activeModel;
  const baseUrl = provider === 'custom'
    ? config.customBaseUrl
    : provider === 'ollama' && config.ollamaBaseUrl
      ? config.ollamaBaseUrl
      : PROVIDERS[provider]?.baseUrl;
  const keyList = Array.isArray(config.keys[provider]) ? config.keys[provider] : (config.keys[provider] ? [config.keys[provider]] : []);
  const keyCount = keyList.filter((k) => k && k.trim()).length;
  const apiKey = getActiveKey(provider, keyList);
  return { provider, providerLabel: PROVIDERS[provider]?.label || provider, model, baseUrl, apiKey, keyCount };
}

// Traegt den HTTP-Status mit, damit sendChat entscheiden kann, ob sich ein Retry lohnt
// (5xx/429 = Server-/Kapazitaetsproblem, oft transient) oder nicht (4xx = falsche
// Anfrage/Modell-ID, ein Retry wuerde nur denselben Fehler wiederholen).
class ModelError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ponytail: kein offizielles SDK fuer beliebige OpenAI-kompatible Endpunkte (OpenRouter/
// NVIDIA NIM/Ollama/...) -- generischer fetch-Client deckt alle Anbieter/Modelle gleich ab.
// Streamt Text-Deltas live; tool_calls kommen bei den meisten Providern ebenfalls
// fragmentiert (nur .function.arguments in Stuecken) und werden hier nach OpenAI-
// Konvention per `index` zusammengesetzt.
async function* streamOpenAICompatible({ baseUrl, apiKey, model, messages, maxTokens, tools }) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      // Manche Endpunkte lehnen tool_choice:"auto" zusammen mit einer leeren tools-Liste ab
      // (z.B. bei der Kontext-Kompaktierung, die bewusst ohne Tools zusammenfasst) --
      // beide Felder nur mitschicken, wenn tatsaechlich Tools vorhanden sind.
      ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
    }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new ModelError(res.status, `Modell-Fehler ${res.status}: ${text.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  let finishReason = null;
  let reasoningChars = 0;
  const toolCalls = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = rawEvent.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (parsed.usage) usage = parsed.usage;
      const choice = parsed.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (!delta) continue;
      if (delta.content) yield { type: 'text', text: delta.content };
      // Reasoning-Modelle (DeepSeek/Qwen/Kimi/GLM ueber NIM) senden ihre interne Gedankenkette
      // oft in einem EIGENEN Feld (reasoning_content/reasoning), NICHT in delta.content -- zaehlt
      // aber genauso gegen max_tokens. Nur mitgezaehlt (nicht angezeigt), damit sich bei einer
      // leeren SICHTBAREN Antwort unterscheiden laesst: "Budget ging fuers Denken drauf, bevor
      // sichtbarer Text/Tool-Aufruf kam" vs. "Modell hat wirklich nichts geliefert".
      const reasoningDelta = delta.reasoning_content || delta.reasoning;
      if (reasoningDelta) reasoningChars += reasoningDelta.length;
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
    }
  }
  yield { type: 'done', usage, toolCalls: toolCalls.filter(Boolean), finishReason, reasoningChars };
}

// onChunk(text) streamt die sichtbare Antwort. onToolCall(toolCall) fuehrt EIN Tool aus
// (inkl. Bestaetigungsabfrage fuer Schreibvorgaenge in index.js) und gibt den String
// zurueck, der als tool-Message an das Modell geht. Loop endet, sobald das Modell keine
// weiteren Tool-Aufrufe mehr macht, oder nach maxIterations als Notbremse. `tools` kommt
// vom Aufrufer (index.js fuer Einzel-Chat, swarm.js fuer Team-Rollen mit zusaetzlichem
// send_message-Tool) -- providers.js kennt selbst keine konkreten Tools mehr.
// 5xx/429 = Server-/Kapazitaetsproblem (z.B. NIMs "ResourceExhausted: All workers are busy"),
// meist transient -- lohnt sich zu wiederholen. 4xx (falsches Modell/Auth) wuerde beim Retry
// nur denselben Fehler reproduzieren, also sofort durchreichen. Netzwerkfehler (fetch selbst
// wirft, kein ModelError) ebenfalls als transient behandeln.
function isRetryable(err) {
  if (err instanceof ModelError) return err.status >= 500 || err.status === 429;
  return true;
}

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

// Aufrufer (index.js/swarm.js) bauen die Nachrichtenliste aus mehreren UNABHAENGIGEN Quellen
// zusammen (Rollen-Prompt, Fable-Qualitaets-Layer, Projekt-Kontext/Gedaechtnis, Stil) -- jede
// eine eigene { role: 'system', ... }-Nachricht. Reale Auswirkung eines echten Langzeit-Laufs:
// manche Modell-Server-Templates (hier qwen-397b via NIM) akzeptieren strikt NUR EINE System-
// Nachricht an Position 0 und lehnen mit HTTP 500 "System message must be at the beginning"
// ab, sobald eine zweite folgt -- kein Zuverlässigkeitsproblem des Modells, sondern ein
// Formatfehler unsererseits, den JEDES gleich strenge Modell reproduzieren wuerde. Fix hier
// zentral (nicht an jeder Aufrufstelle einzeln): alle FUEHRENDEN System-Nachrichten zu einer
// einzigen zusammenfassen, bevor sie rausgehen -- deckt automatisch alle Aufrufer ab.
function mergeLeadingSystemMessages(messages) {
  const systemParts = [];
  const rest = [];
  let pastLeadingSystem = false;
  for (const m of messages) {
    if (!pastLeadingSystem && m.role === 'system') {
      if (m.content) systemParts.push(m.content);
    } else {
      pastLeadingSystem = true;
      rest.push(m);
    }
  }
  // Immer eine NEUE Array-Referenz zurueckgeben (nie die des Aufrufers) -- sendChat haengt
  // spaeter Tool-Call-/Tool-Result-Nachrichten an loopMessages an; ohne eigene Kopie wuerde
  // das sonst je nach Fall das Original-Array des Aufrufers unbemerkt mitveraendern.
  if (systemParts.length <= 1) return [...messages];
  return [{ role: 'system', content: systemParts.join('\n\n') }, ...rest];
}

async function sendChat({ config, messages, tools, onChunk, onToolCall, onRetry = () => {}, maxTokens = 8192, maxRetries = MAX_RETRIES, runId = null }) {
  let target = resolveTarget(config);
  if (!target.baseUrl) {
    throw new Error(`Kein Base-URL fuer Anbieter "${target.provider}" gesetzt (/baseurl <url>).`);
  }
  if (!target.apiKey) {
    const msg = target.keyCount > 0
      ? `Alle ${target.keyCount} Key(s) fuer ${target.providerLabel} sind aktuell limitiert (Cooldown) -- kurz warten oder /addkey ${target.provider} <weiterer Key>.`
      : `Kein API-Key fuer ${target.providerLabel} gesetzt (/setkey ${target.provider} <key>).`;
    throw new Error(msg);
  }

  const loopMessages = mergeLeadingSystemMessages(messages);
  let usage = null;
  let finishReason = null;
  let reasoningChars = 0;
  const maxIterations = 50;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let assistantText = '';
    let toolCalls = [];

    let keySwapAttempts = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        assistantText = '';
        toolCalls = [];
        for await (const chunk of streamOpenAICompatible({
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          model: target.model,
          messages: loopMessages,
          maxTokens,
          tools,
        })) {
          if (chunk.type === 'text') {
            onChunk(chunk.text);
            assistantText += chunk.text;
          } else if (chunk.type === 'done') {
            usage = chunk.usage;
            toolCalls = chunk.toolCalls;
            finishReason = chunk.finishReason;
            reasoningChars = chunk.reasoningChars;
          }
        }
        break;
      } catch (err) {
        // Key-Rotation VOR dem normalen Retry-Pfad: 401/403/429 auf DIESEM Key sind mit einem
        // Ersatz-Key sofort loesbar (kein Backoff noetig), waehrend derselbe Key erneut zu
        // versuchen nur denselben Fehler reproduzieren wuerde. Bug, den ein echter Lauf
        // aufgedeckt hat: "continue" ueberspringt den maxRetries-Check unten KOMPLETT -- ohne
        // eigene Obergrenze lief das bei GLEICHZEITIG limitierten Keys (z.B. providerweiter
        // 429, nicht nur ein einzelner Key) endlos weiter (reportKeyFailure verlaengert bei
        // jedem Fehlschlag das Cooldown des gerade probierten Keys, getActiveKey greift dann
        // zum naechst-baldigen -- ping-pong zwischen 2 Keys, jedesmal "wechsle zu naechstem
        // Key" mit 0s Wartezeit, ohne je den regulaeren Retry-Pfad zu erreichen). Fix: pro
        // sendChat-Aufruf hoechstens einmal pro eingetragenem Key rotieren, danach faellt es
        // in den normalen Backoff-/maxRetries-Pfad (der wirft irgendwann echt).
        const isKeyError = err instanceof ModelError && (err.status === 429 || err.status === 401 || err.status === 403);
        if (isKeyError && target.keyCount > 1 && keySwapAttempts < target.keyCount) {
          reportKeyFailure(target.provider, target.apiKey, err.message);
          const next = resolveTarget(config);
          if (next.apiKey && next.apiKey !== target.apiKey) {
            keySwapAttempts++;
            trace.logEvent(runId, 'key_swap', { provider: target.provider, status: err.status, reason: err.message });
            onRetry(new Error(`Key limitiert (${target.providerLabel}) -- wechsle zu naechstem Key.`), attempt + 1, maxRetries, 0);
            target = next;
            continue;
          }
        }
        if (attempt >= maxRetries || !isRetryable(err)) throw err;
        const delayMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
        onRetry(err, attempt + 1, maxRetries, delayMs);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    if (!toolCalls.length) {
      return { provider: target.providerLabel, model: target.model, usage, finalText: assistantText, finishReason, reasoningChars };
    }

    loopMessages.push({ role: 'assistant', content: assistantText || null, tool_calls: toolCalls });
    for (const toolCall of toolCalls) {
      const result = await onToolCall(toolCall);
      loopMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
    }
  }

  throw new Error(`Zu viele Tool-Aufrufe in Folge (Limit ${maxIterations} erreicht) -- abgebrochen.`);
}

module.exports = {
  PROVIDERS,
  MODEL_PRESETS,
  DEFAULT_CONFIG,
  DEFAULT_OLLAMA_BASE_URL,
  loadConfig,
  saveConfig,
  resolveTarget,
  sendChat,
  CONFIG_PATH,
};
