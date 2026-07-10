'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG_PATH } = require('./providers');
const { isQuotaMessage } = require('./errorClassify');

// Selbstdiagnose: sammelt pro Modell-Preset, wie oft es Retries braucht, wie oft es am Ende
// trotzdem fehlschlaegt und wie lange es im Schnitt dauert. Ziel: Rollen, deren zugewiesenes
// Modell sich als unzuverlaessig/langsam erweist, automatisch auf ein anderes Modell
// umleiten, statt bei jedem Zug erneut lange Retry-Ketten zu produzieren. Persistiert nach
// jedem Aufruf (~/.claude-nemotron-cli/model-health.json) -- ohne das wuerde jeder Neustart
// wieder bei null anfangen und die ersten (langsamen) Lern-Aufrufe pro Modell wiederholen.
const MIN_SAMPLES = 2;
const UNHEALTHY_ERROR_RATE = 0.5;
const UNHEALTHY_RETRY_RATIO = 1.5;
const SLOW_MS_THRESHOLD = 45000;

const HEALTH_PATH = path.join(path.dirname(CONFIG_PATH), 'model-health.json');
// Alte Diagnosedaten (z.B. von einem laengst behobenen Anbieter-Ausfall vor Tagen) sollen
// ein Modell nicht auf ewig blockieren -- nach STALE_MS wird ein Eintrag beim Laden
// verworfen, das Modell bekommt beim naechsten Start wieder eine neutrale Chance.
const STALE_MS = 6 * 60 * 60 * 1000;

const stats = new Map();

// Mehrere CLI-Instanzen koennen gleichzeitig laufen (eigene Prozesse, kein gemeinsamer
// Speicher) -- ohne das hier wuerde jede Instanz beim Speichern blind ihren EIGENEN,
// moeglicherweise veralteten Stand ueberschreiben und damit alles verwerfen, was eine
// ANDERE Instanz inzwischen gelernt hat (z.B. "Modell X ist gerade limitiert"). Deshalb:
// vor jedem Lesen UND vor jedem Schreiben frisch von der Platte einlesen, statt sich auf
// einen einmal beim Start geladenen In-Memory-Stand zu verlassen -- macht die Selbstdiagnose
// instanzuebergreifend konsistent (kein Lock noetig, die Datei ist klein, ein Re-Read kostet
// Mikrosekunden gegenueber Modell-Aufrufen, die Sekunden bis Minuten dauern).
function reloadFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(HEALTH_PATH, 'utf-8'));
    const now = Date.now();
    stats.clear();
    for (const [key, entry] of Object.entries(raw)) {
      if (entry && typeof entry.updatedAt === 'number' && now - entry.updatedAt < STALE_MS) {
        stats.set(key, entry);
      }
    }
  } catch {
    /* Datei fehlt/kaputt -- mit dem bisherigen In-Memory-Stand weitermachen */
  }
}

function saveStats() {
  try {
    fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify(Object.fromEntries(stats), null, 2), 'utf-8');
  } catch {
    /* Persistenz ist ein Komfortfeature, kein Fehlerfall wert */
  }
}

function getStats(modelKey) {
  if (!stats.has(modelKey)) stats.set(modelKey, { calls: 0, retries: 0, errors: 0, totalMs: 0, permanent: false, updatedAt: Date.now() });
  return stats.get(modelKey);
}

// Manche Fehler sind kein "voruebergehendes Ausreisser-Muster", sondern ein hartes,
// deterministisches Limit (z.B. OpenRouters taegliches Freikontingent pro Modell) --
// ein Retry oder ein zweiter Versuch aendert daran nichts. Solche Modelle SOFORT als
// unhealthy markieren (nicht erst nach MIN_SAMPLES), sonst verschwendet jeder weitere
// Loop-Durchlauf erneut einen kompletten Versuch auf ein bekannt totes Modell.
function recordAttempt(modelKey, { retries = 0, errored = false, durationMs = 0, errorMessage = '' } = {}) {
  reloadFromDisk(); // erst den aktuellen (evtl. von anderen Instanzen aktualisierten) Stand holen
  const s = getStats(modelKey);
  s.calls += 1;
  s.retries += retries;
  s.errors += errored ? 1 : 0;
  s.totalMs += durationMs;
  if (errored && isQuotaMessage(errorMessage)) s.permanent = true;
  s.updatedAt = Date.now();
  saveStats();
}

// Erst ab MIN_SAMPLES Aufrufen urteilen -- ein einzelner Ausreisser (z.B. ein transienter
// 503) soll nicht sofort zum Modell-Wechsel fuehren, ein wiederkehrendes Muster schon.
// Ausnahme: s.permanent (siehe isPermanentError) gilt sofort, unabhaengig von MIN_SAMPLES.
// Liest ebenfalls frisch von der Platte -- eine Entscheidung soll den neuesten Stand sehen,
// auch wenn eine ANDERE Instanz seit dem letzten eigenen Aufruf etwas dazugelernt hat.
function diagnose(modelKey) {
  reloadFromDisk();
  const s = stats.get(modelKey);
  if (!s) return { unhealthy: false, reason: null };
  if (s.permanent) {
    return { unhealthy: true, reason: 'Anbieter-Limit erreicht (z.B. Tageskontingent) -- vermutlich erst nach einiger Zeit wieder nutzbar' };
  }
  if (s.calls < MIN_SAMPLES) return { unhealthy: false, reason: null };
  const errorRate = s.errors / s.calls;
  const avgRetries = s.retries / s.calls;
  const avgMs = s.totalMs / s.calls;
  if (errorRate >= UNHEALTHY_ERROR_RATE) {
    return { unhealthy: true, reason: `${Math.round(errorRate * 100)}% der Aufrufe fehlgeschlagen` };
  }
  if (avgRetries >= UNHEALTHY_RETRY_RATIO) {
    return { unhealthy: true, reason: `im Schnitt ${avgRetries.toFixed(1)} Retries pro Aufruf` };
  }
  if (avgMs >= SLOW_MS_THRESHOLD) {
    return { unhealthy: true, reason: `im Schnitt ${Math.round(avgMs / 1000)}s Antwortzeit` };
  }
  return { unhealthy: false, reason: null };
}

// ponytail: 2. Bug, den ein echter Langzeit-Lauf aufgedeckt hat -- der LETZTE Fallback-Zweig
// (wenn weder ein getrackt-gesundes Modell noch der hart codierte FALLBACK_POOL uebrig war)
// pickte bisher blind candidateKeys.find(k => k !== currentModelKey) -- ignoriert dabei
// KOMPLETT, ob dieses Modell selbst schon als unhealthy bekannt ist. Da Object.keys(MODEL_PRESETS)
// mit 'deepseek-v4' beginnt, landete in einem Lauf mit vielen gleichzeitig limitierten Modellen
// (mehrere Provider-Ausfaelle/Rate-Limits) am Ende IMMER 'deepseek-v4' -- selbst wenn genau DAS
// Modell Sekunden zuvor selbst als zu langsam/unhealthy diagnostiziert und ersetzt wurde. Fix:
// EIN einziger Kandidaten-Pool (alle candidateKeys statt eines separaten 4er-Hardcode-Pools) --
// zuerst bevorzugt getestet+gesund (schnellstes zuerst), sonst irgendein noch NIE getestetes
// (unbekannt ist besser als bekannt kaputt), und NUR wenn wirklich ALLES bekannt unhealthy ist,
// das mit der niedrigsten Fehlerquote -- nie mehr blinde Array-Reihenfolge.
function pickReplacement(currentModelKey, candidateKeys) {
  const isUsable = (k) => k !== currentModelKey && !diagnose(k).unhealthy;
  const usable = candidateKeys.filter(isUsable);
  if (usable.length) {
    const tested = usable
      .filter((k) => stats.has(k))
      .sort((a, b) => stats.get(a).totalMs / stats.get(a).calls - stats.get(b).totalMs / stats.get(b).calls);
    return tested[0] || usable[0];
  }
  const others = candidateKeys.filter((k) => k !== currentModelKey);
  if (!others.length) return currentModelKey;
  reloadFromDisk();
  // Alle drei Diagnose-Dimensionen normiert auf ihre eigene Unhealthy-Schwelle summieren (nicht
  // nur Fehlerquote allein) -- sonst wuerde z.B. ein Modell mit 0 Fehlern aber 300s Antwortzeit
  // faelschlich als "bestes" gelten. permanent (Kontingent/Tageslimit) wird ganz gemieden, so
  // lange noch ein anderer, nur transient schlechter Kandidat uebrig ist.
  const score = (s) => (s.errors / s.calls) / UNHEALTHY_ERROR_RATE
    + (s.retries / s.calls) / UNHEALTHY_RETRY_RATIO
    + (s.totalMs / s.calls) / SLOW_MS_THRESHOLD;
  let best = others[0];
  let bestScore = Infinity;
  for (const k of others) {
    const s = stats.get(k);
    if (s?.permanent) continue;
    const candidateScore = s ? score(s) : 0; // ungetestet = neutral, nicht "unendlich schlecht"
    if (candidateScore < bestScore) {
      bestScore = candidateScore;
      best = k;
    }
  }
  return best;
}

module.exports = { recordAttempt, diagnose, pickReplacement };
