'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.claude-nemotron-cli');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const PROVIDERS = {
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  nim: { label: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1' },
  ollama: { label: 'Ollama (lokal)', baseUrl: 'http://localhost:11434/v1' },
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
};

const DEFAULT_CONFIG = {
  keys: { openrouter: '', nim: '', ollama: 'ollama' },
  customBaseUrl: '',
  activeModel: 'nemotron-super',
  activeProvider: 'openrouter',
  projectRoot: 'E:\\',
  style: 'off',
  effort: 'high',
  fallbackModel: '',
  toolPermissions: {},
  planMode: false,
  autoApprove: false,
  swarmAutonomy: true,
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
  const baseUrl = provider === 'custom' ? config.customBaseUrl : PROVIDERS[provider]?.baseUrl;
  const apiKey = config.keys[provider] || '';
  return { provider, providerLabel: PROVIDERS[provider]?.label || provider, model, baseUrl, apiKey };
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
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) yield { type: 'text', text: delta.content };
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
  yield { type: 'done', usage, toolCalls: toolCalls.filter(Boolean) };
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

async function sendChat({ config, messages, tools, onChunk, onToolCall, onRetry = () => {}, maxTokens = 8192 }) {
  const target = resolveTarget(config);
  if (!target.baseUrl) {
    throw new Error(`Kein Base-URL fuer Anbieter "${target.provider}" gesetzt (/baseurl <url>).`);
  }
  if (!target.apiKey) {
    throw new Error(`Kein API-Key fuer ${target.providerLabel} gesetzt (/setkey ${target.provider} <key>).`);
  }

  const loopMessages = [...messages];
  let usage = null;
  const maxIterations = 50;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let assistantText = '';
    let toolCalls = [];

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
          }
        }
        break;
      } catch (err) {
        if (attempt >= MAX_RETRIES || !isRetryable(err)) throw err;
        const delayMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
        onRetry(err, attempt + 1, MAX_RETRIES, delayMs);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    if (!toolCalls.length) {
      return { provider: target.providerLabel, model: target.model, usage, finalText: assistantText };
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
  loadConfig,
  saveConfig,
  resolveTarget,
  sendChat,
  CONFIG_PATH,
};
