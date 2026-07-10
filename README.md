# Open-Source Terminal Chat

Terminal-Chat fuer Open-Source-Modelle (kein Claude) ueber drei Anbieter: OpenRouter, NVIDIA NIM,
lokal Ollama -- je nach Modell automatisch der richtige.

## Setup

**Voraussetzung:** Node.js >= 18 (natives `fetch`, keine weitere HTTP-Dependency noetig). Pruefen mit
`node --version`. Keine `npm install`-Abhaengigkeiten ausser den bereits eingecheckten (Zero-Dependency-
Prinzip -- kein externes Paket, das Angriffsflaeche/Supply-Chain-Risiko bringt).

```bash
git clone <repo-url> claude-nemotron-cli
cd claude-nemotron-cli
npm start
```

Keys setzen, je nachdem welche Presets genutzt werden sollen:

```
/setkey openrouter <key>   -- https://openrouter.ai -> Account -> Keys
/setkey nim <key>          -- https://build.nvidia.com -> API Key generieren (kein Kreditkarte noetig)
```

Ollama braucht i. d. R. keinen echten Key (lokaler Server) -- einfach `ollama serve` laufen lassen.

Config liegt (Klartext-JSON) in `~/.claude-nemotron-cli/config.json`. Chat-Verlauf wird
zusaetzlich in `session.json` im selben Ordner gespeichert und beim naechsten Start automatisch
geladen (`/new` loescht ihn wieder explizit).

Projekt-Ordner fuer die Datei-Tools (`read_file`/`write_file`/`run_command`/...) ist standardmaessig
`~/nemotron-projects` (wird automatisch angelegt, falls noch nicht vorhanden) -- mit
`/projectroot <pfad>` jederzeit auf einen anderen Ordner wechseln.

### Optional: eigenes Windows-Terminal-Profil

Fuer einen Start direkt aus Windows Terminal statt `npm start` im Ordner:

1. Windows Terminal oeffnen -> Einstellungen (Strg+,) -> "JSON-Datei oeffnen" (unten links) --
   oeffnet `settings.json` im Editor.
2. In der `"profiles"."list"`-Liste einen neuen Eintrag ergaenzen:
   ```json
   {
     "guid": "{<neue-uuid-z.B.-per-powershell-new-guid>}",
     "name": "Open Models",
     "commandline": "node \"<PFAD-ZU-DIESEM-ORDNER>\\index.js\"",
     "startingDirectory": "<PFAD-ZU-DIESEM-ORDNER>",
     "icon": "🤖"
   }
   ```
3. Speichern -- Windows Terminal laedt die Datei automatisch neu (kein Neustart noetig), das neue
   Profil erscheint im "+"-Dropdown.
4. `defaultProfile` muss dafuer NICHT geaendert werden -- das neue Profil kommt nur zusaetzlich dazu.

## Claude-Code-Parity (Phase 1-7)

Ergebnis eines strukturierten Vergleichs mit Claude Code ("100 Features, die dort und nicht
hier existieren", in 7 Phasen umgesetzt). Jede Phase live oder per freiem Logik-Test verifiziert.

**Phase 1 (Fundament):** `edit_file` (old_string/new_string-Ersatz statt Full-Rewrite, Fehler
bei Mehrdeutigkeit), `glob_search`/`grep_search` (eigener Mini-Glob, kein npm-Paket),
`run_command` (Shell mit getrackter `cd`, Timeout, `run_in_background` + `read_background_output`,
Gefahren-Erkennung fuer git push --force/rm -rf/etc.), Rolle `explorer` mit `readOnly:true`.
`/codemap`, `/undo <pfad>`, automatische Kontext-Kompaktierung (Zeichenlaengen-Heuristik, da
OpenAI-kompatible Endpunkte kein `count_tokens` haben).

**Phase 2 (Modell & Reasoning):** `/usage` + echte Token-Anzeige (`stream_options:
{include_usage:true}` -- ohne das bleibt `usage` bei den meisten Providern `null`),
`/effort <low|medium|high|xhigh>` (Antwortlaenge + Gruendlichkeits-Nudge, kein echtes
Thinking-Budget moeglich), `/fallback <modell>` (zweiter Versuch mit anderem Modell nach
ausgeschoepften Retries), `/recommend <aufgabe>` (Keyword-Heuristik), Sitzungs-Wiederaufnahme
(`session.json`, automatisch beim Start geladen).

**Phase 3 (Erweiterbarkeit):** `/mcp connect <name> <kommando> [args...]` -- minimaler
MCP-Client (nur stdio-Transport, JSON-RPC ueber Newline-getrennte stdin/stdout, nur Tools,
kein SSE/HTTP/Resources/Prompts). Tools erscheinen als `mcp__<server>__<tool>`, brauchen wie
Schreib-Tools eine Bestaetigung. `/mcp list`/`disconnect`. Eigene Slash-Commands:
`commands/<name>.md` mit `$ARGUMENTS` (deckt zugleich "Skills" ab, `commands/explain.md` als
Beispiel). Uebersprungen: Plugin-Marketplaces, Hooks-System, Statusline, Workflow-Skripte
(bereits durch `/swarm`+`/hive` abgedeckt), Cron/Remote-Agents (Architektur-Mismatch fuer ein
terminalgebundenes Tool ohne Hintergrundprozess).

**Phase 4 (Multi-Agent):** `/panel <aufgabe>` -- Judge-Panel + Adversarial-Verify kombiniert:
3 Modell-Presets bearbeiten dieselbe Aufgabe unabhaengig parallel, ein 4. Modell (bewusst
nicht im Panel, gegen Selbst-Bevorzugung) waehlt/synthetisiert die beste Antwort. `/swarm` und
`/hive` zeigen jetzt eine Abschluss-Zusammenfassung (Zuege/Worker, Fehler, Retries).
Uebersprungen: Hintergrund-Agents/Resume-by-RunId (Architektur ist ein synchrones REPL, kein
Hintergrundprozess), Git-Worktrees fuer Parallelitaet (Projekt oft kein Git-Repo), verschachtelte
Sub-Agent-Tiefe (bereits in Phase-0 bewusst ausgeschlossen), Token-Budget-Cap (kein akuter Bedarf).

**Phase 5 (Sicherheit):** `/permission <tool> <allow|ask|deny>` (Ausnahmen von der normalen
Bestaetigungspflicht pro Tool), `/plan <on|off>` (Schreib-/Shell-/MCP-Tools werden nur noch
beschrieben, nicht ausgefuehrt), `/autoapprove <on|off>` (globaler Bypass, explizites Opt-in).
Einfache Prompt-Injection-Heuristik auf Tool-Ergebnisse (Warnung, kein Block). Audit-Log
(JSON-Lines, `audit.log`) aller Tool-Aufrufe. Uebersprungen: echtes Sandboxing/Containerisierung,
verschluesselte Credentials (dokumentierte bewusste Vereinfachung), Ordner-granulare Permissions.

**Phase 6 (Speicher):** `NEMOTRON.md` im Projekt-Ordner wird automatisch geladen und als
System-Kontext injiziert (CLAUDE.md-Aequivalent, nur Einzel-Chat). `/todo add|done|list`
(JSON-Datei-backed). `/new` archiviert die Sitzung jetzt (`sessions/<zeitstempel>.json`) statt
sie zu loeschen, `/history search <begriff>` durchsucht das Archiv. Uebersprungen: volles
typisiertes Memory-System, gleichzeitige benannte Sessions (Architektur-Mismatch), Wissensgraph.

## "LEERE" Zuege diagnostizierbar machen (finish_reason/reasoningChars)

Auf Nutzerwunsch nach dem Bug-Report "Worker scheitern extrem haeufig": haeufigste Ursache war
`finish_reason: "length"` -- das Token-Budget (`SWARM_MAX_TOKENS`, war auf 'medium'/4096 gesenkt)
reichte bei den eingesetzten Reasoning-Modellen (deepseek-v4/qwen-397b/kimi-k2.6/glm-5) oft nicht
mehr fuer sichtbaren Text/Tool-Aufruf, weil die interne Gedankenkette (`delta.reasoning_content`)
einen Teil davon vorher aufbraucht -- providers.js hat dieses Feld bisher stillschweigend
ignoriert. Jetzt: `streamOpenAICompatible`/`sendChat` erfassen `finish_reason` und die Anzahl
verbrauchter Reasoning-Zeichen, `[Warnung]`-Meldungen bei leeren Zuegen zeigen das direkt an
(z.B. "finish_reason: length, 1200 Zeichen interne Gedankenkette verbraucht" statt nur
"moeglicher Modell-Aussetzer"). `SWARM_MAX_TOKENS` wieder auf 'high'/8192 angehoben -- ein
leerer Zug kostet durch Retry/Modell-Wechsel am Ende mehr Zeit als das hoehere Budget spart.

## Selbstdiagnose + automatischer Modell-Wechsel (modelHealth.js)

Auf Nutzerwunsch: manche Modelle brauchen sehr lange oder werfen haeufig Fehler, was zu vielen
Retries und viel verlorener Zeit fuehrt. `modelHealth.js` sammelt pro Modell-Preset
Retries/Fehler/Antwortzeit -- persistiert in `model-health.json` (cross-instance, Eintraege
verfallen nach 6h automatisch, `/modelhealth` zeigt/reset den Stand). Ab dem 2.
Aufruf eines Modells wird geurteilt: >=50% Fehlerquote, >=1.5 Retries im Schnitt pro Aufruf,
oder >=45s Antwortzeit im Schnitt gilt als unzuverlaessig/langsam. Betrifft das die naechste
Rolle, die dieses Modell nutzen wuerde (Einzel-Agent, Swarm-Rolle, Hive-Coordinator/Worker auf
jeder Verschachtelungstiefe), wird automatisch auf ein anderes Preset ausgewichen -- bevorzugt
ein bereits getestetes, gesundes Modell (schnellstes zuerst), sonst ein noch nie getestetes
(unbekannt gilt als besser als bekannt kaputt), und nur wenn WIRKLICH alle Presets aktuell
unhealthy sind, ein normierter Score aus Fehlerquote/Retries/Latenz unter Meidung permanent
gesperrter (Kontingent/Tageslimit) Modelle -- sichtbar per `[Modell-Wechsel]`-Hinweis. Zusaetzlich
werfen einzelne Coordinator-/Rollen-Fehlschlaege jetzt nicht mehr den GESAMTEN Swarm/Hive-Lauf
um, sondern werden wie ein leerer Zug behandelt und fliessen in die Diagnose ein.

## Mehrere API-Keys pro Anbieter (keyPool.js)

Auf Nutzerwunsch: bei mehreren parallel laufenden Projekten/CLI-Instanzen stoesst ein einzelner
kostenloser Account irgendwann an sein Limit. `config.keys[provider]` ist jetzt eine LISTE statt
eines einzelnen Strings -- `/addkey <provider> <key>` fuegt einen weiteren Account hinzu (ohne
die bestehenden zu ersetzen, dafuer `/setkey`), `/keys` zeigt Anzahl + Cooldown-Status,
`/removekey <provider> <nummer>` entfernt einen. Schlaegt ein Request mit 401/403/429 fehl UND
es gibt einen weiteren Key, wechselt `sendChat` (providers.js) sofort zum naechsten -- ohne
Backoff-Wartezeit, sichtbar per `[Retry] Key limitiert (...) -- wechsle zu naechstem Key`. Der
limitierte Key bekommt einen Cooldown (kurz bei einfachem 429, laenger bei erkennbarer
Kontingent-/Tageslimit-Meldung, siehe `errorClassify.js`) und wird danach automatisch wieder
probiert. Zustand liegt in `key-health.json` (Key nur als Hash, nie im Klartext) und wird -- wie
`model-health.json` -- bei jedem Lesen/Schreiben frisch von der Platte gemergt, damit mehrere
gleichzeitig laufende CLI-Instanzen sich denselben Key-Pool teilen, ohne sich gegenseitig zu
ueberschreiben.

## Tracing, semantische Projekt-Suche, konfigurierbare Hive-Tiefe (3. Ruflo-Runde)

Auf Nutzerwunsch nach einem konkreten Bug-Report (ein Modell wurde durch ein Sekunden zuvor
selbst als unhealthy diagnostiziertes ersetzt -- siehe modelHealth.js-Fix oben) und dem
allgemeinen Wunsch nach mehr Ruflo-Anleihen:

**Observability (trace.js):** jeder Swarm/Hive-Lauf bekommt eine Lauf-ID, unter der Modell-
Wechsel, Key-Wechsel, Worker-Start/-Ende/-Fehler, Coordinator-Dispatch und Konsens-Stimmen
strukturiert in `trace.jsonl` protokolliert werden (JSON Lines, cross-instance, rotiert ab 2MB).
Nach jedem Swarm/Hive-Abschluss wird die Lauf-ID angezeigt, `/trace <lauf-id>` zeigt die
komplette Ereigniskette dieses Laufs, `/trace` ohne Argument die letzten 30 Ereignisse global.

**Semantische Projekt-Suche (memory.js):** `searchProjectMemory` ersetzt bei Swarm/Hive/Einzel-
Chat-Aufrufen mit bekannter Aufgabe den kompletten `AGENTS_MEMORY.md`-Dump durch die Top-5 dazu
passenden Eintraege (TF-IDF-artiges Scoring, reines JS, kein Embedding-Modell/API-Call noetig --
Ruflo-Vorbild AgentDB/RuVector, hier ohne echte Vektoren nachgebaut, um keine zusaetzlichen
Kosten pro Suche zu verursachen). Relevanter Kontext bei wachsender Historie UND kuerzere
Prompts (weniger Tokens pro Zug).

**Konfigurierbare Hive-Tiefe:** `/hivedepth <1-5>` setzt sie fest, `/hivedepth auto` (Standard)
leitet sie aus der Anzahl eingetragener API-Keys ab (`swarm.js:recommendHiveDepth`) -- mehr Keys
bedeuten weniger Rate-Limit-Risiko bei mehr gleichzeitigen Requests, also ist mehr Tiefe eher
vertretbar: 1-2 Keys -> 2 (bisheriger fester Wert), 3-5 Keys -> 3, 6+ Keys -> 4. Hart gedeckelt
bei 5 (Ruflos eigenes Maximum) -- Tiefe wirkt multiplikativ auf Kosten/Laufzeit, `/hivedepth`
ohne Argument zeigt aktuellen Wert + Begruendung.

## Fable-Layer, Gedaechtnis, Nested-Hives, Konsens, Loops (Phasen A-E, 2. Runde)

Auf Nutzerwunsch nach echtem Praxiseinsatz (Kontext-Verlust zwischen Modellwechseln, kein
wiederkehrender Modus, mehr Ruflo-Anleihen):

**Phase A (Fable-Qualitaet):** `fable.js` -- Ton-/Formatierungs-/Fehlerumgangs-Richtlinien aus
dem lokalen `fable`-Skill uebernommen, aber NUR der qualitaetsrelevante Teil, NICHT die
Claude-Fable-5-Identitaet (waere bei DeepSeek/Kimi/GLM/Nemotron schlicht falsch). Gilt
IMMER, fuer jedes Modell und jede Rolle, kein Toggle wie `/style`.

**Phase B (Projekt-Gedaechtnis):** `memory.js` -- `AGENTS_MEMORY.md` wird nach jedem
erfolgreichen `/agent`/`/swarm`/`/hive` automatisch geschrieben (Aufgabe, veraenderte Dateien,
Kurzfassung) und von JEDER folgenden Konversation (auch nach `/model`-Wechsel) automatisch
mitgelesen. Loest: eine andere KI im selben Fenster wusste vorher nichts vom letzten Lauf.

**Phase C (2-stufige Nested-Hives):** ein von `/hive` dispatchter Worker bekommt selbst das
`dispatch_agents`-Tool und kann seine Teilaufgabe weiter zerlegen (Ruflo-Vorbild, hier bewusst
auf Tiefe 2 begrenzt statt Ruflos Tiefe 5).

**Phase D (Hive-Mind-Konsens):** nach einem Hive-Lauf bewerten 3 unabhaengige, read-only
Modell-Aufrufe die veraenderten Dateien (FERTIG/NACHBESSERUNG), Mehrheit entscheidet; bei
Ablehnung EIN zusaetzlicher Coordinator-Durchlauf mit dem Feedback, danach Abschluss.

**Phase E (Loop-Modus):** `/swarm loop [n] <aufgabe>`, `/hive loop [n] <aufgabe>`, `/team loop
[n] <aufgabe>` (Default 3 Durchlaeufe) -- nutzt die Projekt-Gedaechtnis-Datei, um auf dem
vorherigen Durchlauf aufzubauen, bricht frueher ab bei `mark_task_complete`.

Bewusst NICHT uebernommen aus Ruflo (zu grosser Umbau fuer diese Runde, evtl. spaeter):
AgentDB/Vektor-Suche (HNSW/RaBitQ), Knowledge-Graph, SPARC-Methodik, Cost-Tracker mit
Detailaufschluesselung pro Rolle. Der harte Gefahren-Block fuer destruktive Shell-Befehle
bleibt unveraendert bestehen -- Content-Sicherheitsbewusstsein (Fable) ersetzt nicht den
technischen Schutz vor `rm -rf`/`format`/`git push --force`.

## Claude Code CLI vs. Terminal-Profil -- Nutzerkomfort (Stand nach Phase 1-8)

Zweite Vergleichsrunde, diesmal NICHT nach rohen Faehigkeiten sortiert, sondern nach dem, was
den Alltag beim Tippen/Lesen angenehmer macht. Nichts davon ist umgesetzt -- reine Liste fuer
eine spaetere Entscheidung, was sich lohnt.

1. **Markdown-Rendering** -- fett/kursiv/Listen/Code-Bloecke mit Syntax-Highlighting im Ausgabe-
   Stream. Hier: reiner Text-Stream, Sternchen/Backticks bleiben sichtbare Zeichen.
2. **Diff-Ansicht bei Edits** -- farbige +/- Zeilen wie `git diff`. Hier: nur die gekuerzte
   old_string/new_string-Anzeige aus Phase-9-Kuerzung, kein echtes Zeilen-Diff.
3. **Interaktive Bestaetigungs-UI** -- Pfeiltasten-Menue (Allow once/Always/Reject) pro Tool-Aufruf.
   Hier: reine y/N-Texteingabe (und im Swarm/Hive jetzt oft gar keine Nachfrage mehr, siehe Phase 9).
4. **Tastenkuerzel** -- Doppel-Esc fuer Verlauf zurueckspulen, Shift+Tab fuer Modus-Wechsel,
   Strg+R fuer Bash-History-Suche. Hier: nur Enter zum Absenden + Tab-Completion (Phase 7).
5. **Spinner mit rotierendem Zeichen** waehrend des Wartens. Hier: Sekunden-Heartbeat-Text
   (Phase 9), kein animiertes Symbol -- funktional aehnlich, optisch schlichter.
6. **Bilder/Screenshots direkt einfuegen** (Copy-Paste in den Prompt). Hier: reines Text-Tool,
   kein Bild-Input moeglich.
7. **@-Datei-Erwaehnung mit Live-Vorschau-Popup** waehrend des Tippens. Hier: Tab-Completion
   vervollstaendigt Pfade, zeigt aber keine Vorschau-Liste waehrend des Tippens an.
8. **Strukturierte Fehlermeldungen** (z.B. mit Link zur Doku, eingeordneter Statuscode-Text).
   Hier: rohe `err.message`-Ausgabe des jeweiligen Anbieters.
9. **Mehrere Undo-/Checkpoint-Stufen** pro Datei. Hier: `/undo` kennt nur EINEN Schritt zurueck.
10. **Erststart-Assistent** (fragt Projekt-Typ/Berechtigungen ab). Hier: direkter Rohstart,
    Banner zeigt nur den erkannten Projekt-Typ an, fragt aber nichts ab.
11. **Live-Statusleiste** (Branch, Modell, Kontext-Auslastung staendig sichtbar). Hier: Infos
    nur einmalig im Start-Banner, danach muessen `/usage`/`/settings` explizit aufgerufen werden.
12. **Verlaufssuche mit Vorschau/Sprung zur Stelle**. Hier: `/history search` gibt nur einen
    Text-Dump der Treffer aus, kein Sprung in die Original-Session.
13. **Mehrere parallele Sessions/Tabs** im selben Fenster. Hier: ein einzelner Prozess, eine
    Sitzung gleichzeitig.

Einordnung: Punkte 1-2 (Rendering/Diff) waeren die groessten Umbauten (Streaming-Architektur
muesste puffern statt Token-fuer-Token auszugeben) -- siehe bereits in Phase 7 zurueckgestelltes
Item. Punkte 4/6/7/13 haetten TTY-Raw-Mode bzw. Multi-Prozess-Architektur zur Voraussetzung.
Punkte 3/9/11 waeren mit vertretbarem Aufwand nachruestbar, falls gewuenscht.

**Redundanz-Audit (auf Nutzerwunsch):** geprueft, ob Befehle sich ueberfluessig ueberschneiden.
Ergebnis: keiner ist rein redundant, alle drei potenziellen Kandidaten haben einen echten,
eigenen Zweck -- `/agent` (genau eine Rolle, ein Zug, kein Pipeline-Overhead) vs. `/swarm`
(feste mehrstufige Pipeline), `/provider` (Anbieter fuer eigene Modell-IDs) vs. `/baseurl`
(setzt zusaetzlich `/provider custom`), `/team` (reine Rueckfrage-Huelle) vs. `/swarm`+`/hive`
direkt. Kein Befehl geloescht -- stattdessen macht `/help <befehl>` den Unterschied jetzt explizit.

**Phase 7 (Terminal-UX):** Tab-Vervollstaendigung fuer Slash-Commands + Dateipfade
(readline-`completer`). Uebersprungen: Live-Markdown-Rendering (unser Streaming druckt
Token-fuer-Token, Rendering braeuchte Buffering -- groesserer Architektur-Umbau),
Bild-Eingabe/Widgets/Browser-Preview (nicht anwendbar fuer ein Text-only-Tool),
Tastenkuerzel-Modi (brauchen Raw-Mode-Keypress-Handling statt readline-Zeilen).

## Modelle

`/models` zeigt die aktuelle Liste. "Die 5 Staerksten" + die bereits verifizierten
kleineren/schnelleren Optionen -- alle IDs live gegen die jeweilige API geprueft (200 OK):

| Preset            | Modell                          | Anbieter    |
| ------------------ | -------------------------------- | ----------- |
| `deepseek-v4`      | DeepSeek V4 Flash                 | NVIDIA NIM  |
| `qwen-397b`        | Qwen 3.5 397B                     | NVIDIA NIM  |
| `kimi-k2.6`        | Kimi K2.6 (Moonshot AI)           | NVIDIA NIM  |
| `glm-5`            | GLM-5.2 (Z.ai)                    | NVIDIA NIM  |
| `nemotron-super`   | NVIDIA Nemotron 3 Super 120B      | OpenRouter  |
| `nemotron-nano`    | NVIDIA Nemotron 3 Nano 30B        | OpenRouter  |
| `nemotron-nano9b`  | NVIDIA Nemotron Nano 9B v2        | OpenRouter  |
| `gpt-oss-120b`     | OpenAI gpt-oss-120b               | OpenRouter  |
| `gpt-oss-20b`      | OpenAI gpt-oss-20b                | OpenRouter  |
| `gemma`            | Google Gemma 4 31B                | OpenRouter  |

> Bei "Modell-Fehler 404" auf NIM: `GET https://integrate.api.nvidia.com/v1/models` mit dem
> eigenen NIM-Key liefert den echten Katalog (keine Kosten, reines Listing) -- exakte ID dort
> nachschlagen und in `providers.js` unter `MODEL_PRESETS` korrigieren.

`/model <beliebige-modell-id>` + `/provider <openrouter|nim|ollama|custom>` funktioniert mit jeder
anderen Modell-ID des gewaehlten Anbieters (z. B. Llama-/Mistral-Varianten auf OpenRouter, auch
kostenpflichtige).

## Befehle

- `/models` -- verfuegbare Presets anzeigen
- `/model <name>` -- Modell wechseln (Preset-Name oder rohe Modell-ID)
- `/provider <openrouter|nim|ollama|custom>` -- Anbieter fuer rohe Modell-IDs waehlen
- `/setkey <openrouter|nim|ollama> <key>` -- Key fuer einen Anbieter setzen (ersetzt ALLE bisherigen)
- `/addkey <openrouter|nim|ollama> <key>` -- weiteren Key hinzufuegen (mehrere Accounts, Auto-Wechsel bei Limit)
- `/removekey <provider> <nummer>` -- Key wieder entfernen (Nummer aus `/keys`)
- `/keys` -- alle Keys je Anbieter auflisten (Anzahl + Cooldown-Status)
- `/hivedepth <1-5|auto>` -- Verschachtelungstiefe von `/hive` einstellen oder automatisch empfehlen lassen
- `/trace [lauf-id]` -- strukturiertes Ereignis-Log eines Swarm/Hive-Laufs ansehen
- `/modelhealth [preset|reset]` -- Diagnose-Status aller Presets anzeigen, einzeln oder komplett zuruecksetzen
- `/baseurl <url>` -- eigene/custom Base-URL setzen (aktiviert Anbieter "custom")
- `/settings` -- aktuelle Konfiguration anzeigen
- `/agents` -- geladene Agent-Rollen anzeigen
- `/agent <rolle> <aufgabe>` -- eine einzelne Rolle direkt aufrufen (ohne volle Pipeline)
- `/team <aufgabe>` -- fragt "swarm oder hive?" und startet den gewaehlten Modus (siehe unten)
- `/swarm <aufgabe>` -- feste Team-Pipeline direkt starten (siehe unten)
- `/hive <aufgabe>` -- Coordinator-gefuehrter Schwarm direkt starten, parallele Verteilung an >5 Worker (siehe unten)
- `/style <caveman|ponytail|off>` -- Antwortstil umschalten (siehe unten)
- `/new` -- Unterhaltung zuruecksetzen
- `/exit` -- beenden

## Agent-Swarm & Plugin-Ordner

Agent-Rollen liegen als JSON-Dateien in `agents/` (ein "Plugin" = eine Datei):

```json
{ "name": "coder", "label": "Coder", "model": "deepseek-v4", "systemPrompt": "..." }
```

`model` ist ein Preset-Name aus der Modell-Tabelle oben oder eine rohe Modell-ID. Reihenfolge
der Pipeline steht in `agents/pipeline.json` (`{"order": ["planner", "coder", "reviewer"]}`).
Standardmaessig dabei: Planner (Kimi K2.6) -> Coder (DeepSeek V4) -> Reviewer (GLM-5) -- je eine
andere Staerke fuer eine andere Aufgabe im Team.

`/swarm <Aufgabe>` startet mit der konfigurierten Reihenfolge, aber laeuft NICHT stur linear ab:
jede Rolle sieht ein gemeinsames Transkript der bisherigen Beitraege, hat Zugriff auf die
gleichen E:\-Datei-Tools (inkl. Bestaetigung fuer Schreibvorgaenge), und kann per
`send_message`-Tool eine gezielte Nachricht an eine andere Rolle schicken. **Ruecksprache:**
bekommt eine Rolle, die schon dran war, eine neue Nachricht (z.B. der Reviewer schickt dem Coder
Feedback zurueck), wird sie erneut in die Warteschlange eingereiht und darf nochmal ziehen --
die Nachricht verpufft nicht einfach, weil die Pipeline "vorbei" ist. Gedeckelt auf das 3-fache
der Rollenzahl an Gesamt-Zuegen, damit sich zwei Rollen nicht endlos gegenseitig anschreiben.

Liefert eine Rolle einen leeren Zug (kein Text, kein Tool-Aufruf -- z.B. ein Modell-Aussetzer),
wird das als deutliche `[Warnung]`-Zeile angezeigt statt kommentarlos zu verschwinden.

Eigene Rollen/Pipelines: einfach weitere JSON-Dateien in `agents/` ablegen bzw. `pipeline.json`
anpassen -- kein Neustart-Build noetig, wird bei jedem `/swarm`-Aufruf neu eingelesen.

ponytail: kein freies Selbst-Spawning neuer Rollen -- nur bereits bekannte Rollen koennen
erneut ans Ruder, keine neuen Rollen "erfinden".

### Vorinstallierte Rollen aus ecc/ruflo

Zusaetzlich zu Planner/Coder/Reviewer liegen 4 kuratierte Rollen nach dem Vorbild bekannter
Claude-Code-Plugins bereit (ueber `/agent <rolle> <aufgabe>` einzeln aufrufbar, oder in
`agents/pipeline.json` mit in die Reihenfolge aufnehmen):

| Rolle              | Vorbild                     | Modell       |
| ------------------- | ---------------------------- | ------------ |
| `ecc-reviewer`      | ecc:code-reviewer            | GLM-5        |
| `ecc-security`      | ecc:security-reviewer        | DeepSeek V4  |
| `ruflo-architect`   | ruflo-swarm:architect        | Qwen 3.5     |
| `ruflo-researcher`  | ruflo-core:researcher        | Kimi K2.6    |

ponytail: ecc/ruflo bringen in Claude Code 100+ Rollen inkl. Hooks/Statuslines mit -- das ist
Claude-Code-spezifisch und nicht 1:1 uebertragbar. Portiert ist das Uebertragbare: die
System-Prompts einzelner Rollen als eigene Plugin-Dateien. Weitere Rollen nach demselben Muster
selbst als JSON in `agents/` anlegen.

## Hive: echter Multi-Agent-Schwarm (Coordinator + parallele Worker)

`/hive <aufgabe>` -- anders als `/swarm` (feste Reihenfolge, jede Rolle genau einmal dran) fuehrt
ein `coordinator`-Modell (`agents/coordinator.json`, DeepSeek V4) selbst Regie: es zerlegt die
Aufgabe in Teilaufgaben und verteilt sie ueber das Tool `dispatch_agents` PARALLEL (echtes
`Promise.all`, gleichzeitige HTTP-Requests) an beliebige der uebrigen Rollen (Standard: 7 Worker
-- coder, planner, reviewer, ecc-reviewer, ecc-security, ruflo-architect, ruflo-researcher).
Jeder Worker bekommt seine eigene, vom Coordinator formulierte Teilaufgabe + die Datei-Tools,
laeuft unabhaengig, und sein Endergebnis geht als Tool-Antwort zurueck an den Coordinator. Der
kann `dispatch_agents` mehrfach aufrufen (z.B. weitere Runde nach ersten Ergebnissen) und fasst
am Ende alles zu einer finalen Antwort zusammen.

Live getestet: 7 Worker parallel dispatcht (Architektur, Planung, 3x Code-Teile, Review,
Security), reale Dateien via `write_file` angelegt und vom Reviewer per `list_directory`/
`read_file` tatsaechlich gegengeprueft. Ein echter 503 ("All workers are busy") mitten im Lauf
wurde automatisch per Retry aufgefangen, kein Abbruch.

Coordinator-Prompt verlangt explizit >=5 parallele Worker bei groesseren Aufgaben UND
formuliert Datei-Teilaufgaben so, dass Worker write_file benutzen MUESSEN (nicht "nur Code
ausgeben" -- das haette Worker faelschlich dazu gebracht, Code nur als Text auszugeben statt ihn
zu speichern; war der urspruengliche Grund, warum Projekte scheinbar nichts anlegten).

ponytail: absichtlich EINE Verschachtelungsebene (Coordinator -> Worker, keine rekursiven
Sub-Spawns wie ruflo-agent:nested-* mit depth=5) und max. 10 Assignments pro `dispatch_agents`-
Aufruf (Kappung gegen Kosten-Explosion, mehr Worker = mehrere Runden). Kein Hive-Mind/Consensus,
keine Vektor-DB/Embeddings-Speicher wie in den echten ruflo-Agents -- das haengt an einer
eigenen MCP-Infrastruktur (claude-flow), die es fuer ein reines Node-CLI+Fremd-API-Setup nicht
gibt. Bei Bedarf (mehr Ebenen, Konsens zwischen Workern) einfach sagen -- ist gezielt erweiterbar.

## /team: Swarm oder Hive auswaehlen

`/team <Aufgabe>` fragt einmal "Swarm (feste Pipeline) oder Hive (Coordinator, parallel,
>=5 Worker)?" und startet danach denselben Code wie `/swarm`/`/hive` -- fuer alle, die nicht
selbst entscheiden wollen, welcher Modus zur Aufgabe passt. `/swarm`/`/hive` bleiben als direkte
Abkuerzung bestehen, wenn der Modus schon feststeht.

## Robustheit (Retries, parallele Bestaetigungen)

- **Retry mit Backoff:** 5xx/429-Fehler (z.B. NIMs "ResourceExhausted: All workers are busy")
  werden bis zu 3x automatisch mit steigender Wartezeit (1s/2s/4s) wiederholt, sichtbar als
  `[Retry n/3] ...` -- 4xx-Fehler (falsches Modell/Auth) werden NICHT wiederholt, da ein Retry
  denselben Fehler nur reproduzieren wuerde.
- **Parallele Bestaetigungen:** `/hive` laesst mehrere Worker gleichzeitig `write_file`/
  `make_directory` aufrufen -- eine Warteschlange fragt sie nacheinander ab (statt einer
  einzelnen Variable, die sich bei Gleichzeitigkeit selbst ueberschreiben und einen Worker fuer
  immer haengen lassen wuerde).

## Antwortstil (ponytail/caveman)

`/style caveman` -- knapp, technisch, keine Fuellwoerter/Floskeln (Nachbau des Claude-Code-Plugins
`caveman`). `/style ponytail` -- faul/minimal: vor jeder Loesung die Lazy-Ladder durchgehen und bei
der ersten tragfaehigen Stufe stoppen (Nachbau des Plugins `ponytail`). `/style off` schaltet es
wieder aus. Wirkt als zusaetzliche System-Nachricht bei jeder Chat-Nachricht und in jeder
Swarm-/Agent-Rolle -- persistiert in der Config, gilt also auch nach `/new` und Neustart weiter.

## Datei-Zugriff (E:\)

Jedes Modell hat Zugriff auf 4 Tools, strikt auf `config.projectRoot` (Standard `E:\`) beschraenkt:
`list_directory`, `read_file`, `write_file`, `make_directory`. Lesen/Auflisten laeuft ohne
Nachfrage, `write_file`/`make_directory` verlangen erst eine Bestaetigung (y/N) im Terminal --
Modelle von Drittanbietern haben nicht die gleichen Garantien wie Claude, deshalb kein
automatisches Schreiben ohne Blick auf die Platte. Pfad-Traversal (`..`, andere Laufwerke) wird
serverseitig (im Tool selbst) verweigert, nicht nur durch das Modellverhalten.

Projekt-Ordner aendern: `projectRoot` in `~/.claude-nemotron-cli/config.json` anpassen.

## Windows-Terminal-Profil

Ueber ein eigenes Windows-Terminal-Profil "Open Models" direkt startbar (Icon 🧠, eigenes
Farbschema).
