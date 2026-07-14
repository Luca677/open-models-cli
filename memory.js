'use strict';

const fs = require('fs');
const path = require('path');

// Getrennt von NEMOTRON.md (das schreibt der NUTZER selbst, wird nur gelesen) -- diese Datei
// schreibt das TOOL SELBST nach jedem erfolgreichen Agent-Lauf. Zweck: ein Modellwechsel
// (/model x) im selben Fenster sieht danach sofort, was der letzte Swarm/Hive/Agent-Lauf
// gebaut hat, statt bei null anzufangen (bisher ging dieser Kontext beim Lauf-Ende verloren).
const PROJECT_MEMORY_FILENAME = 'AGENTS_MEMORY.md';
const MAX_MEMORY_CHARS = 20000;
const ENTRY_SEPARATOR = '\n---\n';

function memoryPath(root) {
  return path.join(root, PROJECT_MEMORY_FILENAME);
}

function loadProjectMemory(root) {
  try {
    return fs.readFileSync(memoryPath(root), 'utf-8');
  } catch {
    return null;
  }
}

// entry: { task: string, files: string[], summary: string, lessons?: string[] }
// lessons: auf Nutzerwunsch ("Modelle machen haeufig dieselben Fehler, sprechen sich wenig
// ab") -- was in DIESEM Lauf schiefging (leere Zuege, Fehler), damit ein KUENFTIGER Lauf
// (auch in einer neuen Session/einem neuen Loop-Durchlauf) es nicht blind wiederholt.
// Kommt aus swarm.js' mistakeLog (siehe dort), nicht aus einer separaten Selbstkritik-Anfrage
// -- kostet also keinen zusaetzlichen API-Aufruf.
function appendProjectMemory(root, entry) {
  const timestamp = new Date().toISOString();
  const filesLine = entry.files && entry.files.length ? entry.files.join(', ') : '(keine erkannten Datei-Aenderungen)';
  const lessonsBlock = entry.lessons && entry.lessons.length
    ? `**Lektionen:**\n${entry.lessons.map((l) => `- ${l}`).join('\n')}\n`
    : '';
  const block =
    `## ${timestamp}\n` +
    `**Aufgabe:** ${entry.task}\n` +
    `**Dateien:** ${filesLine}\n` +
    `**Ergebnis:** ${entry.summary}\n` +
    lessonsBlock;

  const existing = loadProjectMemory(root) || '';
  let combined = existing ? existing.trimEnd() + ENTRY_SEPARATOR + block : block;

  // Aelteste Eintraege zuerst droppen, wenn die Datei zu gross wird -- gleiches Prinzip wie
  // die Kontext-Kompaktierung in index.js (die neuesten Eintraege sind am relevantesten).
  if (combined.length > MAX_MEMORY_CHARS) {
    const parts = combined.split(ENTRY_SEPARATOR);
    while (parts.length > 1 && parts.join(ENTRY_SEPARATOR).length > MAX_MEMORY_CHARS) {
      parts.shift();
    }
    combined = parts.join(ENTRY_SEPARATOR);
  }

  try {
    fs.writeFileSync(memoryPath(root), combined, 'utf-8');
  } catch {
    /* Projekt-Gedaechtnis ist ein Komfortfeature, kein Fehlerfall wert */
  }
}

function parseEntries(root) {
  const raw = loadProjectMemory(root);
  if (!raw) return [];
  return raw.split(ENTRY_SEPARATOR).map((s) => s.trim()).filter(Boolean);
}

function tokenize(text) {
  return (text || '').toLowerCase().match(/[a-z0-9äöüß]{3,}/g) || [];
}

// Ruflo-Vorbild (agentdb/ruvector: HNSW-Vektorsuche), hier ohne echte Embeddings nachgebaut --
// ein Embedding-Call pro Suche waere ein zusaetzlicher, kostenpflichtiger API-Aufruf VOR jedem
// eigentlichen Agent-Zug, was dem Kosten-/Geschwindigkeitsziel dieser Session widerspricht.
// Klassisches TF-IDF-Scoring (reines JS, keine Abhaengigkeit, keine Netzwerk-Kosten) reicht, um
// bei wachsender Projekt-Historie nur die paar Eintraege in den Kontext zu geben, die zur
// AKTUELLEN Aufgabe passen -- statt bisher immer den kompletten Speicher bis zur Zeichen-Grenze.
function searchProjectMemory(root, queryText, topN = 5) {
  const entries = parseEntries(root);
  if (!entries.length) return null;
  const queryTokens = tokenize(queryText);
  if (!queryTokens.length) return entries.slice(-topN).join(ENTRY_SEPARATOR);

  const entryTokens = entries.map(tokenize);
  const df = new Map();
  for (const tokens of entryTokens) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = entries.length;
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;

  const scored = entries.map((entry, i) => {
    const tf = new Map();
    for (const t of entryTokens[i]) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const qt of queryTokens) {
      if (tf.has(qt)) score += tf.get(qt) * idf(qt);
    }
    return { entry, score, index: i };
  });

  const top = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, topN);
  if (!top.length) return entries.slice(-topN).join(ENTRY_SEPARATOR); // keine Ueberschneidung -> neuste als Fallback
  top.sort((a, b) => a.index - b.index); // chronologisch fuer die Ausgabe
  return top.map((s) => s.entry).join(ENTRY_SEPARATOR);
}

module.exports = { PROJECT_MEMORY_FILENAME, loadProjectMemory, appendProjectMemory, searchProjectMemory };
