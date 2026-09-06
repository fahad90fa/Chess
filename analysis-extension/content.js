/*
 * content.js — orchestrator on the chess.com analysis board.
 *
 * Runs only on /analysis pages (engine use is permitted there). It:
 *   - mounts the visible overlay (overlay.js)
 *   - obtains the current position via, in order of preference:
 *       1) the page-context reader (injected.js) — full, correct FEN
 *       2) reconstruction from the board DOM (.piece square-XY classes)
 *       3) manual FEN / PGN typed into the overlay
 *   - watches the board container with a MutationObserver and, in auto mode,
 *     re-analyses when the position changes (debounced)
 *   - sends positions to the local engine via background.js and shows results
 *
 * It never sends keyboard/mouse events to the page and never modifies the
 * chess.com board. Reading only.
 */
(function () {
  'use strict';

  if (!/^\/analysis(\/|$|\?)/.test(location.pathname + location.search) &&
      !/^\/analysis/.test(location.pathname)) {
    return; // safety: only the analysis board
  }

  const C = self.ChessLib;
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  const state = {
    depth: 18,
    auto: false,
    mode: 'manual',        // 'auto' | 'manual' | 'pgn'
    fen: START_FEN,
    injectedFen: null,
    pgn: null,             // { states, sans, ply }
    requestId: 0,
    lastAnalyzed: null,
  };

  const overlay = new self.ChessOverlay({ depth: state.depth, autoDefault: false, showAuto: true });
  overlay.mount(document.documentElement);
  overlay.setStatus('Starting engine…');

  // ---- Load saved settings ----
  try {
    chrome.storage && chrome.storage.local.get(['depth', 'hotkey'], (v) => {
      if (v && v.depth) { state.depth = v.depth; }
      if (v && v.hotkey) overlay.setHotkey(v.hotkey);
    });
  } catch (e) { /* ignore */ }

  // ---- Engine messaging ----
  function requestAnalyze(fen) {
    const val = C.validateFEN(fen);
    if (!val.ok) { overlay.setStatus('Invalid FEN: ' + val.error, '#e0a0a0'); return; }
    state.fen = fen;
    overlay.setFen(fen);
    state.requestId += 1;
    const id = state.requestId;
    state.lastAnalyzed = fen;
    overlay.setStatus('Analyzing… (depth ' + state.depth + ')');
    try {
      chrome.runtime.sendMessage({
        channel: 'engine', type: 'ANALYZE', fen, requestId: id,
        options: { depth: state.depth },
      }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) overlay.setStatus('Engine bridge error: ' + err.message, '#e0a0a0');
        else if (resp && !resp.ok) overlay.setStatus('Engine error: ' + resp.error, '#e0a0a0');
      });
    } catch (e) {
      overlay.setStatus('Cannot reach engine: ' + e.message, '#e0a0a0');
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.channel !== 'engine-result') return;
    if (msg.requestId !== state.requestId) return; // ignore stale
    if (msg.type === 'INFO') {
      overlay.update(msg.payload);
      overlay.setStatus('Analyzing… depth ' + (msg.payload.depth || '?'));
    } else if (msg.type === 'BESTMOVE') {
      if (!msg.payload || !msg.payload.bestMove) {
        overlay.showTerminal(state.fen);
        overlay.setStatus('No moves — game over in this position.', '#9a978f');
      } else {
        overlay.update(msg.payload);
        overlay.setStatus('Done. Best move ready.', '#9a978f');
      }
    } else if (msg.type === 'ERROR') {
      overlay.setStatus('Engine error: ' + (msg.payload && msg.payload.error), '#e0a0a0');
    }
  });

  // ---- Position from the page (injected.js, MAIN world) ----
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'sf-analysis-fen') return;
    state.injectedFen = e.data.fen;
    if (state.mode === 'auto') maybeAutoAnalyze();
  });

  function requestInjectedFen() {
    window.postMessage({ source: 'sf-analysis-request' }, '*');
  }

  // ---- Position from the board DOM (fallback) ----
  function readBoardFromDom() {
    const pieces = document.querySelectorAll('[class*="piece"]');
    if (!pieces.length) return null;
    const board = {};
    let count = 0;
    pieces.forEach((node) => {
      const cls = node.className && node.className.baseVal != null ? node.className.baseVal : String(node.className || '');
      const pieceM = cls.match(/\b([wb])([prnbqk])\b/);
      const sqM = cls.match(/\bsquare-(\d)(\d)\b/);
      if (!pieceM || !sqM) return;
      const color = pieceM[1], type = pieceM[2];
      const file = parseInt(sqM[1], 10) - 1; // 1..8 -> 0..7
      const rank = parseInt(sqM[2], 10) - 1;
      if (file < 0 || file > 7 || rank < 0 || rank > 7) return;
      const letter = color === 'w' ? type.toUpperCase() : type;
      board[rank * 8 + file] = letter;
      count++;
    });
    if (count < 2) return null;
    // Build placement (rank 8 down to 1).
    let placement = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = board[r * 8 + f];
        if (!p) { empty++; continue; }
        if (empty) { placement += empty; empty = 0; }
        placement += p;
      }
      if (empty) placement += empty;
      if (r > 0) placement += '/';
    }
    const turn = inferTurnFromMoveList();
    // Castling/en passant are not recoverable from the board DOM alone.
    return placement + ' ' + turn + ' - - 0 1';
  }

  function inferTurnFromMoveList() {
    // Try to find the currently highlighted ply.
    const sel = document.querySelector(
      '.selected[data-ply], [data-ply].selected, .main-line-row .selected, .node.selected'
    );
    let ply = null;
    if (sel && sel.getAttribute) {
      const p = sel.getAttribute('data-ply');
      if (p != null) ply = parseInt(p, 10);
    }
    if (ply == null) {
      const nodes = document.querySelectorAll('[data-ply]');
      if (nodes.length) {
        const last = nodes[nodes.length - 1];
        ply = parseInt(last.getAttribute('data-ply'), 10);
      }
    }
    if (ply == null || isNaN(ply)) return 'w';
    return ply % 2 === 0 ? 'w' : 'b';
  }

  function currentAutoFen() {
    if (state.injectedFen) return state.injectedFen;
    return readBoardFromDom();
  }

  // ---- Auto-analysis with debounce ----
  let debounceTimer = null;
  function maybeAutoAnalyze() {
    if (state.mode !== 'auto') return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const fen = currentAutoFen();
      if (!fen) { overlay.setStatus('Could not read the board. Paste a FEN instead.', '#e0c080'); return; }
      if (fen === state.lastAnalyzed) return;
      requestAnalyze(fen);
    }, 350);
  }

  // MutationObserver on a safe container (board / move list), never modifying it.
  function installObserver() {
    const target =
      document.querySelector('wc-chess-board') ||
      document.querySelector('chess-board') ||
      document.querySelector('[class*="board"]') ||
      document.body;
    const obs = new MutationObserver(() => {
      if (state.mode !== 'auto') return;
      requestInjectedFen();
      maybeAutoAnalyze();
    });
    obs.observe(target, { attributes: true, childList: true, subtree: true });
  }
  installObserver();

  // ---- Overlay callbacks ----
  overlay
    .on('analyzeFen', (fen) => {
      if (!fen) return;
      state.mode = 'manual';
      state.pgn = null;
      overlay.setPlyLabel('manual');
      requestAnalyze(fen);
    })
    .on('loadPgn', (text) => {
      if (!text || !text.trim()) return;
      let res;
      try { res = C.parsePGN(text); }
      catch (e) { overlay.setStatus('PGN error: ' + e.message, '#e0a0a0'); return; }
      if (!res.states.length) { overlay.setStatus('No moves found in PGN.', '#e0c080'); return; }
      state.mode = 'pgn';
      state.pgn = { states: res.states, sans: res.sans, ply: res.states.length - 1 };
      gotoPly(state.pgn.ply);
    })
    .on('first', () => navPgn('first'))
    .on('prev', () => navPgn('prev'))
    .on('next', () => navPgn('next'))
    .on('last', () => navPgn('last'))
    .on('toggleAuto', (on) => {
      state.mode = on ? 'auto' : 'manual';
      overlay.setStatus(on ? 'Auto-read on. Move on the board to analyze.' : 'Auto-read off.');
      if (on) { requestInjectedFen(); maybeAutoAnalyze(); }
    })
    .on('depthChange', (d) => {
      state.depth = d;
      try { chrome.storage && chrome.storage.local.set({ depth: d }); } catch (e) { /* ignore */ }
      // Re-run current position at the new depth.
      if (state.fen) requestAnalyze(state.fen);
    });

  function navPgn(where) {
    if (state.mode !== 'pgn' || !state.pgn) return;
    const maxPly = state.pgn.states.length - 1;
    let p = state.pgn.ply;
    if (where === 'first') p = 0;
    else if (where === 'last') p = maxPly;
    else if (where === 'prev') p = Math.max(0, p - 1);
    else if (where === 'next') p = Math.min(maxPly, p + 1);
    gotoPly(p);
  }

  function gotoPly(p) {
    const st = state.pgn.states[p];
    state.pgn.ply = p;
    const fen = C.toFEN(st);
    overlay.setPlyLabel(p === 0 ? 'start' : (Math.ceil(p / 2) + (p % 2 ? '.' : '…') + ' ' + (state.pgn.sans[p - 1] || '')));
    requestAnalyze(fen);
  }

  // Kick off: request an injected FEN so the overlay can offer to analyze it.
  setTimeout(requestInjectedFen, 700);
  overlay.setStatus('Ready. Paste a FEN/PGN, or enable Auto-read.', '#9a978f');
})();
