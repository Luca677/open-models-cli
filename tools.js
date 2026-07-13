'use strict';

const fs = require('fs');
const path = require('path');

// Sicherheit: jeder Pfad kommt vom Modell (nicht vertrauenswuerdig). resolveSafe loest
// ".."/absolute-Pfad-Versuche zu ihrem tatsaechlichen Ziel auf und verweigert alles,
// was ausserhalb von `root` landet -- auch einen Versuch wie "C:\\Windows" (path.resolve
// mit absolutem zweiten Argument ignoriert sonst die Basis, deshalb Pruefung auf das
// AUFGELOESTE Ergebnis, nicht auf den rohen String). path.relative() statt manueller
// String-Verkettung: ein Laufwerks-Root wie "E:\\" hat auf Windows schon einen
// abschliessenden Backslash -- "root + path.sep" haengt dann einen zweiten an und der
// Praefix-Vergleich schlaegt fuer JEDEN Pfad fehl (genau das war der Bug).
function resolveSafe(root, relPath) {
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, relPath || '.');
  const rel = path.relative(rootResolved, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Pfad "${relPath}" liegt ausserhalb von ${root} -- verweigert.`);
  }
  return target;
}

// ponytail: eigener Mini-Glob statt npm-Paket oder Nodes experimentellem fs.glob (Verfuegbarkeit
// je Node-Version unsicher) -- deckt die ueblichen Muster ab: "*" (ein Segment), "**" (beliebig
// viele Segmente), "?" (ein Zeichen). Reicht fuer Datei-Suche, kein vollstaendiger Bash-Glob.
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function walkFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkFiles(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
}

const MAX_SEARCH_RESULTS = 200;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024; // ponytail: groessere/binaere Dateien ueberspringen statt zu haengen

function globSearch(root, scopeRelPath, pattern) {
  const scopeDir = resolveSafe(root, scopeRelPath || '.');
  const files = [];
  walkFiles(scopeDir, files);
  const regex = globToRegExp(pattern);
  const matches = files
    .map((f) => ({ f, rel: path.relative(root, f).split(path.sep).join('/') }))
    .filter(({ rel }) => regex.test(rel))
    .map(({ f, rel }) => ({ rel, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_SEARCH_RESULTS);
  if (!matches.length) return '(keine Treffer)';
  const suffix = matches.length === MAX_SEARCH_RESULTS ? `\n... (Limit ${MAX_SEARCH_RESULTS} erreicht, weitere ausgeblendet)` : '';
  return matches.map((m) => m.rel).join('\n') + suffix;
}

function grepSearch(root, scopeRelPath, pattern, globFilter, caseInsensitive) {
  const scopeDir = resolveSafe(root, scopeRelPath || '.');
  const files = [];
  walkFiles(scopeDir, files);
  const fileRegex = globFilter ? globToRegExp(globFilter) : null;
  const lineRegex = new RegExp(pattern, caseInsensitive ? 'i' : '');
  const results = [];
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (fileRegex && !fileRegex.test(rel)) continue;
    let stat;
    try {
      stat = fs.statSync(f);
    } catch {
      continue;
    }
    if (stat.size > MAX_GREP_FILE_BYTES) continue;
    let content;
    try {
      content = fs.readFileSync(f, 'utf-8');
    } catch {
      continue; // vermutlich binaer/nicht als UTF-8 lesbar
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lineRegex.test(lines[i])) {
        results.push(`${rel}:${i + 1}:${lines[i]}`);
        if (results.length >= MAX_SEARCH_RESULTS) break;
      }
    }
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  if (!results.length) return '(keine Treffer)';
  const suffix = results.length === MAX_SEARCH_RESULTS ? `\n... (Limit ${MAX_SEARCH_RESULTS} erreicht, weitere ausgeblendet)` : '';
  return results.join('\n') + suffix;
}

// Mehrstufiges Undo pro Datei (Ring gedeckelt bei UNDO_STACK_LIMIT -- ponytail: kein volles
// Versionsverwaltungssystem, nur genug Tiefe fuer mehrere aufeinanderfolgende KI-Fehler in
// derselben Datei). `null` als gespeicherter Inhalt bedeutet "Datei existierte vorher nicht",
// Undo loescht sie dann. Jeder /undo-Aufruf springt genau einen Schritt zurueck (letzter zuerst).
const UNDO_STACK_LIMIT = 5;
const undoHistory = new Map();

function pushUndo(absPath) {
  const previous = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf-8') : null;
  const stack = undoHistory.get(absPath) || [];
  stack.push(previous);
  if (stack.length > UNDO_STACK_LIMIT) stack.shift();
  undoHistory.set(absPath, stack);
}

function undoLastWrite(root, relPath) {
  const absPath = resolveSafe(root, relPath);
  const stack = undoHistory.get(absPath);
  if (!stack || !stack.length) {
    throw new Error(`Keine Undo-Historie fuer "${relPath}" in dieser Sitzung.`);
  }
  const previous = stack.pop();
  const remaining = stack.length;
  if (!remaining) undoHistory.delete(absPath);
  const remainingNote = remaining ? ` (noch ${remaining} weitere Undo-Schritt(e) verfuegbar)` : '';
  if (previous === null) {
    fs.unlinkSync(absPath);
    return `OK: ${relPath} rueckgaengig gemacht (Datei existierte vorher nicht, geloescht).${remainingNote}`;
  }
  fs.writeFileSync(absPath, previous, 'utf-8');
  return `OK: ${relPath} auf vorherigen Stand zurueckgesetzt.${remainingNote}`;
}

// Diff-Vorschau vor write_file/edit_file-Bestaetigungen: gemeinsamer Praefix/Suffix wird
// rausgekuerzt, nur der tatsaechlich veraenderte Mittelblock als -/+ gezeigt (kein volles
// LCS-Diff noetig -- ponytail: bei edit_file ist die Aenderung durch old_string/new_string
// ohnehin schon exakt bekannt, bei write_file reicht Praefix/Suffix-Kuerzung fuer den
// ueblichen Fall "ein Abschnitt mittendrin geaendert").
function diffPreview(oldText, newText, maxLines = 20) {
  const oldLines = (oldText || '').split('\n');
  const newLines = (newText || '').split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) {
    endOld--;
    endNew--;
  }
  const removed = oldLines.slice(start, endOld + 1);
  const added = newLines.slice(start, endNew + 1);
  if (!removed.length && !added.length) return '(keine Aenderung)';
  const lines = [...removed.slice(0, maxLines).map((l) => `- ${l}`), ...added.slice(0, maxLines).map((l) => `+ ${l}`)];
  const truncated = removed.length > maxLines || added.length > maxLines;
  return lines.join('\n') + (truncated ? '\n... (gekuerzt)' : '');
}

function previewDiff(root, name, args) {
  if (name === 'edit_file') {
    return diffPreview(args.old_string || '', args.new_string || '');
  }
  if (name === 'write_file') {
    let absPath;
    try {
      absPath = resolveSafe(root, args.path);
    } catch {
      return null;
    }
    const oldContent = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf-8') : '';
    return diffPreview(oldContent, args.content || '');
  }
  return null;
}

function buildToolDefinitions(root, { readOnly = false } = {}) {
  const readTools = [
    {
      type: 'function',
      function: {
        name: 'list_directory',
        description: `Listet Dateien und Ordner unter ${root} auf. "." fuer die Wurzel.`,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: `Pfad relativ zu ${root}` } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: `Liest den Inhalt einer Textdatei unter ${root}.`,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: `Pfad relativ zu ${root}` } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'glob_search',
        description: `Findet Dateien unter ${root} per Muster (z.B. "**/*.js", "src/*.ts"), sortiert nach Aenderungsdatum (neueste zuerst).`,
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob-Muster (* = ein Segment, ** = beliebig viele, ? = ein Zeichen)' },
            path: { type: 'string', description: `Such-Startpunkt relativ zu ${root}, Standard "."` },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'grep_search',
        description: `Durchsucht Dateiinhalte unter ${root} per Regex, gibt Treffer als Pfad:Zeile:Inhalt zurueck.`,
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regulaerer Ausdruck' },
            path: { type: 'string', description: `Such-Startpunkt relativ zu ${root}, Standard "."` },
            glob: { type: 'string', description: 'Optionaler Datei-Filter als Glob-Muster (z.B. "*.py")' },
            caseInsensitive: { type: 'boolean', description: 'Gross-/Kleinschreibung ignorieren' },
          },
          required: ['pattern'],
        },
      },
    },
  ];

  if (readOnly) return readTools;

  return [
    ...readTools,
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: `Erstellt oder ueberschreibt eine Textdatei unter ${root}. Elternordner werden automatisch angelegt. Der Nutzer muss diesen Schreibvorgang bestaetigen.`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: `Pfad relativ zu ${root}` },
            content: { type: 'string', description: 'Vollstaendiger Dateiinhalt' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: `Ersetzt einen exakten Textabschnitt in einer bestehenden Datei unter ${root} (statt die ganze Datei neu zu schreiben). old_string muss in der Datei eindeutig vorkommen, sonst Fehler -- ausser replace_all ist gesetzt. Mehrere edit_file-Aufrufe in einer Antwort sind moeglich.`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: `Pfad relativ zu ${root}` },
            old_string: { type: 'string', description: 'Exakt zu ersetzender Text (muss in der Datei vorkommen)' },
            new_string: { type: 'string', description: 'Ersatztext' },
            replace_all: { type: 'boolean', description: 'Alle Vorkommen ersetzen statt nur ein eindeutiges' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'make_directory',
        description: `Legt einen Ordner (inkl. Elternordner) unter ${root} an. Der Nutzer muss bestaetigen.`,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: `Pfad relativ zu ${root}` } },
          required: ['path'],
        },
      },
    },
  ];
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'make_directory']);

function executeTool(root, name, args) {
  if (name === 'list_directory') {
    const dir = resolveSafe(root, args.path);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(leer)';
  }
  if (name === 'read_file') {
    const file = resolveSafe(root, args.path);
    return fs.readFileSync(file, 'utf-8');
  }
  if (name === 'glob_search') {
    return globSearch(root, args.path, args.pattern);
  }
  if (name === 'grep_search') {
    return grepSearch(root, args.path, args.pattern, args.glob, args.caseInsensitive);
  }
  if (name === 'write_file') {
    const file = resolveSafe(root, args.path);
    pushUndo(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, args.content ?? '', 'utf-8');
    return `OK: ${args.path} geschrieben (${Buffer.byteLength(args.content ?? '', 'utf-8')} Bytes).`;
  }
  if (name === 'edit_file') {
    const file = resolveSafe(root, args.path);
    if (!fs.existsSync(file)) {
      throw new Error(`Datei "${args.path}" existiert nicht -- edit_file braucht eine bestehende Datei (write_file fuer neue Dateien nutzen).`);
    }
    const content = fs.readFileSync(file, 'utf-8');
    const count = content.split(args.old_string).length - 1;
    if (count === 0) {
      throw new Error(`old_string nicht in "${args.path}" gefunden -- exakten Text (inkl. Einrueckung) pruefen.`);
    }
    if (count > 1 && !args.replace_all) {
      throw new Error(`old_string kommt ${count}x in "${args.path}" vor -- nicht eindeutig. Mehr Kontext angeben oder replace_all setzen.`);
    }
    pushUndo(file);
    const updated = args.replace_all
      ? content.split(args.old_string).join(args.new_string)
      : content.replace(args.old_string, args.new_string);
    fs.writeFileSync(file, updated, 'utf-8');
    return `OK: ${args.path} bearbeitet (${count} Ersetzung${count === 1 ? '' : 'en'}).`;
  }
  if (name === 'make_directory') {
    const dir = resolveSafe(root, args.path);
    fs.mkdirSync(dir, { recursive: true });
    return `OK: Ordner ${args.path} angelegt.`;
  }
  throw new Error(`Unbekanntes Tool: ${name}`);
}

module.exports = { buildToolDefinitions, WRITE_TOOLS, executeTool, resolveSafe, undoLastWrite, previewDiff };
