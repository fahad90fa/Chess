/*
 * standalone.js — self-contained local analyzer (no chess.com involved).
 *
 * Full board with click-to-move, FEN/PGN loading, ply navigation, and live
 * Stockfish analysis. The engine runs locally in a Web Worker via worker.js.
 */
(function () {
  'use strict';
  const C = self.ChessLib;
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  const boardEl = document.getElementById('board');
  const evalWhite = document.getElementById('evalWhite');
  const evalNum = document.getElementById('evalNum');
  const bestEl = document.getElementById('bestMove');
  const depthEl = document.getElementById('depth');
  const pvEl = document.getElementById('pv');
  const fenIn = document.getElementById('fenIn');
  const pgnIn = document.getElementById('pgnIn');
  const statusEl = document.getElementById('status');
  const movelistEl = document.getElementById('movelist');
  const depthSel = document.getElementById('depthSel');

  const ui = {
    flip: false,
    depth: 18,
    state: C.parseFEN(START),
    selected: null,       // selected from-square (0x88)
    legalFrom: [],        // legal moves from selected
    bestMove: null,       // uci
    pgn: null,            // { states, sans, ply }
    reqId: 0,
  };

  // ---- Engine ----
  const engineUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL('engine/stockfish.js')
    : '../engine/stockfish.js';

  let engine;
  try {
    engine = createStockfish(engineUrl, {
      onInfo: (e) => onEngine(e.id, e.info, false),
      onBestMove: (r) => onEngine(r.id, r.info || {}, true, r.bestMove),
      onError: (err) => setStatus('Engine error: ' + err),
    });
    setStatus('Engine loading…');
  } catch (e) {
    setStatus('Could not start engine: ' + e.message);
  }

  function onEngine(id, info, done, bestMove) {
    if (id !== ui.reqId) return; // stale
    const turn = ui.state.turn;
    // Eval from White's perspective.
    let evalStr = '—', whitePct = 50;
    if (info.mate != null) {
      const wm = turn === 'w' ? info.mate : -info.mate;
      evalStr = (wm >= 0 ? '#' : '#-') + Math.abs(wm);
      whitePct = wm >= 0 ? 100 : 0;
    } else if (info.cp != null) {
      const wc = turn === 'w' ? info.cp : -info.cp;
      evalStr = (wc >= 0 ? '+' : '') + (wc / 100).toFixed(2);
      whitePct = Math.max(2, Math.min(98, 50 + 50 * (2 / (1 + Math.exp(-wc / 400)) - 1)));
    }
    evalNum.textContent = evalStr;
    evalWhite.style.width = whitePct + '%';
    if (info.depth != null) depthEl.textContent = 'd ' + info.depth;

    const uci = bestMove || (info.pv && info.pv[0]);
    if (uci) {
      ui.bestMove = uci;
      let label = uci;
      try { const mv = C.uciToMove(ui.state, uci); if (mv) label = C.moveToSAN(ui.state, mv); } catch (e) {}
      bestEl.textContent = 'Best: ' + label;
      if (info.pv && info.pv.length) pvEl.textContent = pvToSan(ui.state, info.pv);
    } else if (done) {
      // Terminal position: no legal move to suggest.
      ui.bestMove = null;
      const hasMoves = C.generateLegalMoves(ui.state).length > 0;
      if (!hasMoves) {
        if (C.inCheck(ui.state, ui.state.turn)) {
          bestEl.textContent = 'Checkmate';
          evalNum.textContent = ui.state.turn === 'w' ? '#-0' : '#0';
          evalWhite.style.width = ui.state.turn === 'w' ? '0%' : '100%';
        } else {
          bestEl.textContent = 'Stalemate';
          evalNum.textContent = '0.00';
          evalWhite.style.width = '50%';
        }
        pvEl.textContent = '—';
      }
    }
    render();
    setStatus(done ? 'Done.' : 'Analyzing… depth ' + (info.depth || '?'));
  }

  function pvToSan(fen0, pv) {
    try {
      let st = (typeof fen0 === 'string') ? C.parseFEN(fen0) : C.clone(fen0);
      const out = []; let no = st.full; let first = true;
      for (const uci of pv.slice(0, 14)) {
        const mv = C.uciToMove(st, uci); if (!mv) break;
        const san = C.moveToSAN(st, mv);
        if (st.turn === 'w') out.push(no + '. ' + san);
        else out.push((first ? no + '... ' : '') + san);
        if (st.turn === 'b') no++;
        first = false; st = C.applyMove(st, mv);
      }
      return out.join(' ');
    } catch (e) { return pv.join(' '); }
  }

  function analyze() {
    const fen = C.toFEN(ui.state);
    fenIn.value = fen;
    ui.bestMove = null;
    ui.reqId += 1;
    if (!engine) { setStatus('Engine not available.'); return; }
    setStatus('Analyzing… depth ' + ui.depth);
    engine.analyze(fen, { id: ui.reqId, depth: ui.depth });
    render();
  }

  function setStatus(t) { statusEl.textContent = t; }

  // ---- Board rendering ----
  function buildBoard() {
    boardEl.innerHTML = '';
    ui.cells = [];
    for (let i = 0; i < 64; i++) {
      const d = document.createElement('div');
      d.className = 'sq';
      d.addEventListener('click', onSquareClick);
      boardEl.appendChild(d);
      ui.cells.push(d);
    }
  }

  // Map display index (0=top-left) to 0x88 square, honoring flip.
  function idxToSquare(idx) {
    let r = Math.floor(idx / 8), f = idx % 8;
    if (ui.flip) { r = 7 - r; f = 7 - f; }
    const rank = 7 - r;
    return rank * 16 + f;
  }
  function squareToIdx(sq) {
    const file = sq & 7, rank = sq >> 4;
    let r = 7 - rank, f = file;
    if (ui.flip) { r = 7 - r; f = 7 - f; }
    return r * 8 + f;
  }

  function render() {
    const bestSquares = ui.bestMove ? [C.fromAlgebraic(ui.bestMove.slice(0, 2)), C.fromAlgebraic(ui.bestMove.slice(2, 4))] : [];
    const targets = ui.legalFrom.map((m) => m.to);
    const capTargets = ui.legalFrom.filter((m) => m.captured || m.flags.indexOf('e') !== -1).map((m) => m.to);
    for (let idx = 0; idx < 64; idx++) {
      const sq = idxToSquare(idx);
      const cell = ui.cells[idx];
      const file = sq & 7, rank = sq >> 4;
      const light = (file + rank) % 2 === 1;
      cell.style.background = light ? 'var(--light)' : 'var(--dark)';
      const p = ui.state.board[sq];
      cell.textContent = p ? C.UNICODE[p] : '';
      cell.className = 'sq' + (p ? (p === p.toUpperCase() ? ' wpiece' : ' bpiece') : '');
      if (ui.selected === sq) cell.classList.add('sel');
      if (targets.indexOf(sq) !== -1) cell.classList.add(capTargets.indexOf(sq) !== -1 ? 'tcap' : 'target');
      if (bestSquares.indexOf(sq) !== -1) cell.classList.add('best');
    }
  }

  function onSquareClick(e) {
    const idx = ui.cells.indexOf(e.currentTarget);
    const sq = idxToSquare(idx);
    const piece = ui.state.board[sq];

    if (ui.selected == null) {
      if (piece && C.colorOf(piece) === ui.state.turn) {
        ui.selected = sq;
        ui.legalFrom = C.generateLegalMoves(ui.state, sq);
      }
      render();
      return;
    }

    // Clicking the same square deselects.
    if (sq === ui.selected) { ui.selected = null; ui.legalFrom = []; render(); return; }

    const move = ui.legalFrom.find((m) => m.to === sq);
    if (move) {
      // Auto-queen promotion for simplicity.
      let chosen = move;
      if (move.promotion) {
        chosen = ui.legalFrom.find((m) => m.to === sq && m.promotion &&
          m.promotion.toLowerCase() === 'q') || move;
      }
      ui.state = C.applyMove(ui.state, chosen);
      ui.selected = null; ui.legalFrom = [];
      ui.pgn = null; // manual move breaks PGN navigation
      movelistEl.innerHTML = '';
      analyze();
      return;
    }

    // Otherwise, re-select if another own piece was clicked.
    if (piece && C.colorOf(piece) === ui.state.turn) {
      ui.selected = sq;
      ui.legalFrom = C.generateLegalMoves(ui.state, sq);
    } else {
      ui.selected = null; ui.legalFrom = [];
    }
    render();
  }

  // ---- PGN ----
  function loadPgn(text) {
    let res;
    try { res = C.parsePGN(text); }
    catch (e) { setStatus('PGN error: ' + e.message); return; }
    if (!res.states.length) { setStatus('No moves found.'); return; }
    ui.pgn = { states: res.states, sans: res.sans, ply: res.states.length - 1 };
    renderMoveList();
    gotoPly(ui.pgn.ply);
  }

  function renderMoveList() {
    movelistEl.innerHTML = '';
    if (!ui.pgn) return;
    const sans = ui.pgn.sans;
    for (let i = 0; i < sans.length; i++) {
      if (i % 2 === 0) {
        const num = document.createElement('span');
        num.textContent = (i / 2 + 1) + '. ';
        num.style.color = 'var(--muted)';
        movelistEl.appendChild(num);
      }
      const m = document.createElement('span');
      m.className = 'm';
      m.textContent = sans[i] + ' ';
      m.dataset.ply = String(i + 1);
      m.addEventListener('click', () => gotoPly(i + 1));
      movelistEl.appendChild(m);
    }
  }

  function highlightMove() {
    movelistEl.querySelectorAll('.m').forEach((n) => {
      n.classList.toggle('cur', parseInt(n.dataset.ply, 10) === (ui.pgn && ui.pgn.ply));
    });
  }

  function gotoPly(p) {
    if (!ui.pgn) return;
    p = Math.max(0, Math.min(ui.pgn.states.length - 1, p));
    ui.pgn.ply = p;
    ui.state = C.clone(ui.pgn.states[p]);
    ui.selected = null; ui.legalFrom = [];
    highlightMove();
    analyze();
  }

  // ---- Controls ----
  document.getElementById('startBtn').addEventListener('click', () => {
    ui.state = C.parseFEN(START); ui.pgn = null; movelistEl.innerHTML = ''; ui.selected = null; ui.legalFrom = []; analyze();
  });
  document.getElementById('flipBtn').addEventListener('click', () => { ui.flip = !ui.flip; render(); });
  document.getElementById('clearBtn').addEventListener('click', analyze);
  document.getElementById('firstBtn').addEventListener('click', () => gotoPly(0));
  document.getElementById('prevBtn').addEventListener('click', () => ui.pgn && gotoPly(ui.pgn.ply - 1));
  document.getElementById('nextBtn').addEventListener('click', () => ui.pgn && gotoPly(ui.pgn.ply + 1));
  document.getElementById('lastBtn').addEventListener('click', () => ui.pgn && gotoPly(ui.pgn.states.length - 1));
  document.getElementById('loadPgnBtn').addEventListener('click', () => loadPgn(pgnIn.value));
  depthSel.addEventListener('change', () => { ui.depth = parseInt(depthSel.value, 10); analyze(); });
  fenIn.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = fenIn.value.trim();
    const val = C.validateFEN(v);
    if (!val.ok) { setStatus('Invalid FEN: ' + val.error); return; }
    ui.state = C.parseFEN(v); ui.pgn = null; movelistEl.innerHTML = ''; ui.selected = null; ui.legalFrom = []; analyze();
  });

  // ---- Boot ----
  buildBoard();
  render();
  if (engine) engine.onReady(() => { setStatus('Engine ready.'); analyze(); });
})();
