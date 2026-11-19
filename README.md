# Chess-Helfer

Chrome/Edge/Brave-Erweiterung, die auf chess.com mit Stockfish 19 die besten Züge anzeigt:
farbige Pfeile auf dem Brett und ein kleines Panel mit Zügen und Bewertung.
Die Engine läuft lokal im Browser (WASM). Es werden keine Daten an fremde Server geschickt.

## Wo sie läuft

- Analysebrett: `https://www.chess.com/analysis` (auch „Partie analysieren" nach einer Partie)
- Partien (Computer, Live, Daily): `https://www.chess.com/play/...`, `https://www.chess.com/game/...`, `https://www.chess.com/live`, `https://www.chess.com/daily`

Hinweis: Engine-Hilfe in Partien gegen Menschen verstößt gegen die Fair-Play-Regeln von chess.com und kann zur Kontosperre führen.

## Installation

1. `chrome://extensions` (Edge: `edge://extensions`) öffnen.
2. Oben rechts **Entwicklermodus** einschalten.
3. **Entpackte Erweiterung laden** und diesen Ordner (`chess-helfer`) wählen.
4. chess.com neu laden.

Nach Code-Änderungen auf der Erweiterungsseite auf das Neu-laden-Symbol klicken und den Tab neu laden.

## Bedienung

- Grüner Pfeil = bester Zug, blau/orange = Alternativen.
- Panel lässt sich am Kopf verschieben und mit `–` einklappen.
- Klick auf das Erweiterungs-Icon: an/aus, Auto-Zug, Auto-Verzögerung, Rechenzeit, Anzahl Vorschläge, gelegentliche schlechtere Züge (`Schlechtere Züge` & `Max. Abweichung`).
- Im Panel-Kopf lässt sich **Auto** (Auto-Zug) ebenfalls direkt ein- und ausschalten.
- Bewertung aus Sicht von Weiß (`+` = Weiß besser, `M3` = Matt in 3).
- Notation deutsch: K König, D Dame, T Turm, L Läufer, S Springer.

## Aufbau

| Datei | Aufgabe |
| --- | --- |
| `page.js` | Läuft im Seitenkontext, liest die FEN über die Brett-API von chess.com |
| `content.js` | Fallback-Auslesen aus dem DOM, Pfeile, Panel, Seitenprüfung |
| `background.js` | Leitet Anfragen an das Offscreen-Dokument weiter |
| `offscreen.js` | Startet Stockfish als Web Worker, MultiPV-Suche |
| `engine/` | Stockfish 19 lite (single-threaded) aus dem npm-Paket `stockfish` |

Falls chess.com die Brett-API ändert, liest `content.js` die Figuren aus dem DOM.
Das Zugrecht wird dann aus der Zugmarkierung geschätzt (Panel zeigt „Zugrecht geschätzt").

## Lizenz

Stockfish steht unter GPLv3, siehe `engine/COPYING-Stockfish.txt`.
