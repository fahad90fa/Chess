# Local Stockfish Analysis (Educational)

A Manifest V3 Chrome extension that analyzes chess positions with a **local
Stockfish 17.1 engine (WebAssembly)**. Everything runs on your machine — the
engine makes **no network calls**.

It works in two places:

1. **The chess.com analysis board** (`https://www.chess.com/analysis`), where
   engine assistance is explicitly allowed, and
2. **A built-in standalone page** you open from the toolbar — a full board with
   click-to-move, FEN/PGN loading, and live evaluation.

The analysis appears in a **plainly visible overlay**. This extension has **no
hiding, obfuscation, or anti-detection behavior of any kind** — that is a
deliberate design choice.

> **Fair play.** Use this on the analysis board, on positions you are studying,
> and on your own finished games. Do **not** use it to get help during a live
> game against another person. Most sites, chess.com included, forbid engine
> help in live play; this tool is for learning and review.

---

## What's in here (no build step required)

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest. Minimal permissions: `storage`, `activeTab`, `offscreen`. |
| `content.js` | Runs on the analysis board: mounts the overlay, reads the position, requests analysis. |
| `overlay.js` | The visible panel: board, best move, eval bar, principal variation, FEN/PGN input, hotkey toggle. |
| `injected.js` | Page-context reader (`world: MAIN`) that pulls a full FEN from chess.com's own board object when possible. |
| `worker.js` | Stockfish wrapper. Owns the engine Web Worker and turns UCI output into clean results. |
| `background.js` | Service worker. Bridges the content script and the engine. |
| `offscreen.html` / `offscreen.js` | Host document that runs the engine Worker (see "Why an offscreen document"). |
| `chesslib.js` | Self-contained chess model: FEN, legal moves, SAN, PGN, board rendering. Perft-verified. |
| `standalone/` | The standalone analyzer page (`index.html` + `standalone.js`). |
| `popup.html` / `popup.js` | Toolbar popup: open the standalone page, set depth and the overlay hotkey. |
| `engine/` | `stockfish.js` + `stockfish.wasm` (Stockfish 17.1, GPLv3). The engine binary. |
| `icons/` | Toolbar icons. |
| `test/perft.test.cjs` | Correctness tests for `chesslib.js`. |

### Architecture at a glance

```
chess.com/analysis
  injected.js (MAIN world) ──postMessage──► content.js ──┐
                                     ▲                    │ chrome.runtime
                                     │ overlay.js         ▼
                                (visible UI)          background.js (service worker)
                                                          │  ensures + relays
                                                          ▼
                                                   offscreen.html
                                                     worker.js ──► Web Worker: engine/stockfish.js (WASM)
```

**Why an offscreen document?** A content script can't spawn the engine Worker
(the chess.com page's Content-Security-Policy blocks it) and a service worker
can't run a DOM Worker or WASM engine. An **offscreen document** runs in the
extension's own origin under the extension's CSP, so it can host the engine.
The standalone page and popup are already extension pages, so they run the
engine directly without the offscreen hop.

---

## Install (Load Unpacked)

1. Open Chrome and go to `chrome://extensions/`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select this `analysis-extension/` folder.
5. The ♞ icon appears in the toolbar. That's it — **no build, no npm install**.

The engine files are already included, so there is nothing to download.

---

## Use it

### On the chess.com analysis board
1. Go to `https://www.chess.com/analysis` (open it fresh or reload the page so
   the content script loads).
2. The **Stockfish Analysis** panel appears in the top-right corner.
3. Two ways to feed it a position:
   - **Paste a FEN** into the FEN box and press Enter, or **paste a PGN** and
     click *Load PGN* (then step through with the ◀ ▶ ⏮ ⏭ buttons). This path
     is fully reliable.
   - Tick **Auto-read board** to have it read the position from the page and
     re-analyze when the board changes.
4. Press the hotkey (default **Ctrl+Shift+E**, configurable in the popup) to
   show/hide the panel. The **×** in the header hides it too.

> **Note on auto-read.** Reading chess.com's board automatically is
> best-effort: it first asks the page's own board object for a FEN, and falls
> back to reconstructing the position from the board's DOM. chess.com changes
> its internals over time, so if auto-read ever misses, use the FEN/PGN box —
> that always works.

### Standalone analyzer (no chess.com needed)
1. Click the ♞ toolbar icon → **Open standalone analyzer**.
2. Play moves by clicking a piece then its destination (legal targets are
   highlighted; promotions auto-queen). Or paste a FEN / load a PGN.
3. The best move (highlighted on the board), evaluation, and principal
   variation update live. Use **Flip** to switch sides, **Depth** to trade
   speed for strength.

---

## Settings

Open the popup (toolbar icon):
- **Default analysis depth** — higher is stronger but slower.
- **Overlay toggle hotkey** — pick Ctrl / Shift / Alt plus a key.

Settings are stored with `chrome.storage.local`.

---

## Run the tests

The chess logic is verified with [perft](https://www.chessprogramming.org/Perft)
against standard reference positions (start position, "Kiwipete", and others),
plus SAN/PGN round-trip checks.

```bash
cd analysis-extension
node test/perft.test.cjs
```

Expected: `ALL TESTS PASSED`.

---

## Notes & limitations

- **Single-threaded engine.** The engine runs single-threaded, which avoids
  needing cross-origin isolation (COOP/COEP). It's plenty strong for analysis;
  depth 18–20 is near-instant on the start position.
- **Auto-read is best-effort** on chess.com (see the note above). Manual
  FEN/PGN entry is the dependable path and works everywhere.
- **No moves are ever made for you.** The extension only *shows* suggestions.
- **No keyboard/mouse events** are sent to the chess.com page, and the board
  DOM is only read, never modified.

## License

The Stockfish engine in `engine/` is distributed under the **GPLv3** (see the
header of `engine/stockfish.js`). The rest of this extension is provided for
educational use under the repository's license.
