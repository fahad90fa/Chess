/*
 * injected.js — runs in the PAGE's main world (declared with "world":"MAIN"
 * in the manifest), so it can read chess.com's own board component when the
 * DOM alone is not enough (side to move, castling rights, en passant).
 *
 * It never modifies the page. It only reads a FEN and hands it to the content
 * script via window.postMessage. If chess.com's internals are not reachable
 * (their private API changes over time), it stays silent and the content
 * script falls back to reading the DOM or to manual FEN/PGN entry.
 *
 * This is used only on the analysis board, where engine assistance is allowed.
 */
(function () {
  'use strict';

  const TAG_OUT = 'sf-analysis-fen';
  const TAG_IN = 'sf-analysis-request';

  function tryGetFen() {
    // Strategy 1: the <wc-chess-board> custom element often exposes a game object.
    try {
      const boards = document.querySelectorAll('wc-chess-board, chess-board');
      for (const b of boards) {
        const g = b.game || (b.state && b.state.game) || null;
        if (g) {
          if (typeof g.getFEN === 'function') { const f = g.getFEN(); if (f) return f; }
          if (typeof g.getFen === 'function') { const f = g.getFen(); if (f) return f; }
          if (g.fen) return g.fen;
        }
      }
    } catch (e) { /* ignore */ }

    // Strategy 2: some builds keep a global game controller.
    try {
      const cands = [
        window.gameClient && window.gameClient.getSelectedGame && window.gameClient.getSelectedGame(),
        window.game,
        window.ChessComGame,
      ].filter(Boolean);
      for (const g of cands) {
        if (g && typeof g.getFEN === 'function') { const f = g.getFEN(); if (f) return f; }
        if (g && g.fen) return g.fen;
      }
    } catch (e) { /* ignore */ }

    return null;
  }

  let last = null;
  function report(reason) {
    let fen = null;
    try { fen = tryGetFen(); } catch (e) { fen = null; }
    if (fen && fen !== last) {
      last = fen;
      window.postMessage({ source: TAG_OUT, fen, reason: reason || 'change' }, '*');
    } else if (fen && reason === 'request') {
      // Answer explicit requests even if unchanged.
      window.postMessage({ source: TAG_OUT, fen, reason: 'request' }, '*');
    }
  }

  // Respond to explicit requests from the content script.
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== TAG_IN) return;
    report('request');
  });

  // Best-effort passive polling (light) to catch board changes the observer misses.
  let ticks = 0;
  const timer = setInterval(() => {
    report('poll');
    if (++ticks > 6000) clearInterval(timer); // stop after ~30 min idle safety
  }, 300);

  // Initial attempt shortly after load.
  setTimeout(() => report('init'), 500);
})();
