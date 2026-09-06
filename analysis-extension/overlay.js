/*
 * overlay.js — the visible analysis panel.
 *
 * A self-contained, position:fixed UI. It renders the current position, the
 * engine's best move / evaluation / principal variation, and controls for
 * manual FEN and PGN input plus ply navigation. It is intentionally VISIBLE
 * and clearly labelled — this tool has no hiding or anti-detection behaviour.
 *
 * Exposes window.ChessOverlay with a small API used by content.js and by the
 * standalone page. Rendering uses ChessLib for board/FEN/SAN.
 */
(function (root) {
  'use strict';

  const C = root.ChessLib;

  const LIGHT = '#ebecd0';
  const DARK = '#739552';
  const PANEL_BG = '#262421';
  const PANEL_FG = '#e8e6e3';
  const ACCENT = '#7fa650';

  function el(tag, style, text) {
    const n = document.createElement(tag);
    if (style) Object.assign(n.style, style);
    if (text != null) n.textContent = text;
    return n;
  }

  function ChessOverlay(opts) {
    opts = opts || {};
    this.opts = opts;
    this.hotkey = opts.hotkey || { ctrl: true, shift: true, key: 'E' };
    this.visible = true;
    this.callbacks = {};
    this.currentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    this._build();
    this._installHotkey();
  }

  ChessOverlay.prototype.on = function (event, cb) { this.callbacks[event] = cb; return this; };
  ChessOverlay.prototype._fire = function (event, arg) {
    if (this.callbacks[event]) this.callbacks[event](arg);
  };

  ChessOverlay.prototype._build = function () {
    const root = el('div', {
      position: 'fixed', top: '16px', right: '16px', width: '300px', zIndex: '2147483647',
      background: PANEL_BG, color: PANEL_FG, borderRadius: '10px',
      boxShadow: '0 6px 24px rgba(0,0,0,0.45)', font: '13px/1.4 system-ui,Segoe UI,Roboto,sans-serif',
      padding: '0', overflow: 'hidden', userSelect: 'none',
    });
    this.rootEl = root;

    // Header (draggable).
    const header = el('div', {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 10px', background: '#1e1c1a', cursor: 'move',
    });
    const title = el('div', { fontWeight: '600', fontSize: '13px' }, '♞ Stockfish Analysis');
    const closeBtn = el('div', {
      cursor: 'pointer', padding: '0 6px', fontSize: '16px', color: '#aaa',
    }, '×');
    closeBtn.title = 'Hide (toggle with hotkey)';
    closeBtn.addEventListener('click', () => this.toggle());
    header.appendChild(title);
    header.appendChild(closeBtn);
    root.appendChild(header);
    this._makeDraggable(header, root);

    const body = el('div', { padding: '10px' });
    root.appendChild(body);

    // Evaluation bar.
    const evalWrap = el('div', { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' });
    const evalBarOuter = el('div', {
      position: 'relative', flex: '1', height: '14px', background: '#111',
      borderRadius: '7px', overflow: 'hidden', border: '1px solid #000',
    });
    this.evalBarWhite = el('div', {
      position: 'absolute', left: '0', top: '0', bottom: '0', width: '50%',
      background: '#f5f5f5', transition: 'width 0.2s ease',
    });
    evalBarOuter.appendChild(this.evalBarWhite);
    this.evalText = el('div', { minWidth: '52px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: '600' }, '0.00');
    evalWrap.appendChild(evalBarOuter);
    evalWrap.appendChild(this.evalText);
    body.appendChild(evalWrap);

    // Best move + depth line.
    const bestLine = el('div', { display: 'flex', justifyContent: 'space-between', marginBottom: '6px' });
    this.bestMoveEl = el('div', { fontSize: '15px', fontWeight: '700', color: ACCENT }, 'Best: —');
    this.depthEl = el('div', { color: '#9a978f', fontVariantNumeric: 'tabular-nums' }, 'd —');
    bestLine.appendChild(this.bestMoveEl);
    bestLine.appendChild(this.depthEl);
    body.appendChild(bestLine);

    // Board grid.
    this.boardEl = el('div', {
      display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', width: '100%',
      aspectRatio: '1 / 1', border: '1px solid #000', borderRadius: '4px', overflow: 'hidden',
      marginBottom: '8px',
    });
    this.squares = [];
    for (let i = 0; i < 64; i++) {
      const sqEl = el('div', {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '20px', lineHeight: '1', aspectRatio: '1 / 1',
      });
      this.boardEl.appendChild(sqEl);
      this.squares.push(sqEl);
    }
    body.appendChild(this.boardEl);

    // Principal variation.
    this.pvEl = el('div', {
      fontSize: '12px', color: '#c9c6c0', minHeight: '32px', maxHeight: '48px', overflow: 'auto',
      background: '#1e1c1a', borderRadius: '4px', padding: '5px 7px', marginBottom: '8px',
      wordBreak: 'break-word', userSelect: 'text',
    }, 'Principal variation will appear here.');
    body.appendChild(this.pvEl);

    // Navigation (for PGN / game stepping).
    const nav = el('div', { display: 'flex', gap: '4px', marginBottom: '8px' });
    const mkNav = (label, ev) => {
      const b = el('button', navBtnStyle(), label);
      b.addEventListener('click', () => this._fire(ev));
      return b;
    };
    nav.appendChild(mkNav('⏮', 'first'));
    nav.appendChild(mkNav('◀', 'prev'));
    this.plyLabel = el('div', {
      flex: '1', textAlign: 'center', alignSelf: 'center', color: '#9a978f', fontSize: '12px',
    }, '—');
    nav.appendChild(this.plyLabel);
    nav.appendChild(mkNav('▶', 'next'));
    nav.appendChild(mkNav('⏭', 'last'));
    body.appendChild(nav);

    // Manual FEN input.
    this.fenInput = el('input', inputStyle());
    this.fenInput.type = 'text';
    this.fenInput.placeholder = 'Paste FEN and press Enter';
    this.fenInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this._fire('analyzeFen', this.fenInput.value.trim());
    });
    body.appendChild(this.fenInput);

    // PGN textarea + button.
    this.pgnInput = el('textarea', Object.assign(inputStyle(), { height: '52px', resize: 'vertical', marginTop: '6px' }));
    this.pgnInput.placeholder = 'Paste PGN, then click Load PGN';
    this.pgnInput.addEventListener('keydown', (e) => e.stopPropagation());
    body.appendChild(this.pgnInput);

    const btnRow = el('div', { display: 'flex', gap: '6px', marginTop: '6px' });
    const loadPgnBtn = el('button', primaryBtnStyle(), 'Load PGN');
    loadPgnBtn.addEventListener('click', () => this._fire('loadPgn', this.pgnInput.value));
    btnRow.appendChild(loadPgnBtn);
    body.appendChild(btnRow);

    // Options row: auto-read toggle + depth.
    const optRow = el('div', { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', flexWrap: 'wrap' });
    if (opts.showAuto !== false) {
      const autoLabel = el('label', { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '12px' });
      this.autoChk = el('input');
      this.autoChk.type = 'checkbox';
      this.autoChk.checked = !!opts.autoDefault;
      this.autoChk.addEventListener('change', () => this._fire('toggleAuto', this.autoChk.checked));
      autoLabel.appendChild(this.autoChk);
      autoLabel.appendChild(document.createTextNode('Auto-read board'));
      optRow.appendChild(autoLabel);
    }
    const depthLabel = el('label', { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', marginLeft: 'auto' });
    depthLabel.appendChild(document.createTextNode('Depth'));
    this.depthSel = el('select', { background: '#1e1c1a', color: PANEL_FG, border: '1px solid #444', borderRadius: '4px', padding: '2px' });
    [12, 15, 18, 20, 22, 25].forEach((d) => {
      const o = el('option', null, String(d));
      o.value = String(d);
      if (d === (opts.depth || 18)) o.selected = true;
      this.depthSel.appendChild(o);
    });
    this.depthSel.addEventListener('change', () => this._fire('depthChange', parseInt(this.depthSel.value, 10)));
    depthLabel.appendChild(this.depthSel);
    optRow.appendChild(depthLabel);
    body.appendChild(optRow);

    // Status line.
    this.statusEl = el('div', { marginTop: '8px', fontSize: '11px', color: '#8a877f' }, 'Loading engine…');
    body.appendChild(this.statusEl);

    // Fair-play note.
    const note = el('div', { marginTop: '6px', fontSize: '10px', color: '#6c6a63', lineHeight: '1.35' },
      'For analysis boards, study and post-game review only. Do not use during live games against opponents.');
    body.appendChild(note);

    this.setFen(this.currentFen);
  };

  ChessOverlay.prototype.mount = function (parent) {
    (parent || document.documentElement).appendChild(this.rootEl);
    return this;
  };

  ChessOverlay.prototype._makeDraggable = function (handle, target) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      const rect = target.getBoundingClientRect();
      ox = rect.left; oy = rect.top; sx = e.clientX; sy = e.clientY;
      target.style.right = 'auto';
      target.style.left = ox + 'px';
      target.style.top = oy + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      target.style.left = (ox + e.clientX - sx) + 'px';
      target.style.top = (oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  };

  ChessOverlay.prototype._installHotkey = function () {
    document.addEventListener('keydown', (e) => {
      const hk = this.hotkey;
      if ((!hk.ctrl || e.ctrlKey) && (!hk.shift || e.shiftKey) && (!hk.alt || e.altKey) &&
          e.key && e.key.toUpperCase() === hk.key.toUpperCase()) {
        // Only toggle when not typing into our own inputs.
        this.toggle();
      }
    });
  };

  ChessOverlay.prototype.setHotkey = function (hk) { if (hk) this.hotkey = hk; };

  ChessOverlay.prototype.toggle = function (force) {
    this.visible = typeof force === 'boolean' ? force : !this.visible;
    this.rootEl.style.display = this.visible ? 'block' : 'none';
  };

  ChessOverlay.prototype.setStatus = function (text, color) {
    this.statusEl.textContent = text;
    if (color) this.statusEl.style.color = color;
  };

  ChessOverlay.prototype.setPlyLabel = function (text) { this.plyLabel.textContent = text; };

  // Render a FEN onto the mini board.
  ChessOverlay.prototype.setFen = function (fen) {
    this.currentFen = fen;
    let grid;
    try { grid = C.toGrid(C.parseFEN(fen)); } catch (e) { return; }
    let idx = 0;
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const sqEl = this.squares[idx];
        const isLight = (r + f) % 2 === 0;
        sqEl.style.background = isLight ? LIGHT : DARK;
        const p = grid[r][f];
        sqEl.textContent = p ? C.UNICODE[p] : '';
        sqEl.style.color = p && p === p.toUpperCase() ? '#fff' : '#000';
        sqEl.style.textShadow = p && p === p.toUpperCase() ? '0 0 2px #000' : 'none';
        idx++;
      }
    }
    if (this.fenInput && document.activeElement !== this.fenInput) this.fenInput.value = fen;
  };

  // Update engine output. data: { bestMove, ponder, cp, mate, depth, pv, turn }
  ChessOverlay.prototype.update = function (data) {
    const fenTurn = (() => { try { return C.parseFEN(this.currentFen).turn; } catch (e) { return 'w'; } })();

    // Eval text and bar (always from White's perspective).
    let evalStr = '—', whitePct = 50;
    if (data.mate != null) {
      const mateForSide = data.mate; // + means side-to-move mates
      const whiteMate = fenTurn === 'w' ? mateForSide : -mateForSide;
      evalStr = (whiteMate >= 0 ? '#' : '#-') + Math.abs(whiteMate);
      whitePct = whiteMate >= 0 ? 100 : 0;
    } else if (data.cp != null) {
      const whiteCp = fenTurn === 'w' ? data.cp : -data.cp;
      evalStr = (whiteCp >= 0 ? '+' : '') + (whiteCp / 100).toFixed(2);
      whitePct = 50 + 50 * (2 / (1 + Math.exp(-whiteCp / 400)) - 1); // logistic squash
      whitePct = Math.max(2, Math.min(98, whitePct));
    }
    this.evalText.textContent = evalStr;
    this.evalBarWhite.style.width = whitePct + '%';

    // Best move in SAN if possible.
    if (data.bestMove) {
      let label = data.bestMove;
      try {
        const st = C.parseFEN(this.currentFen);
        const mv = C.uciToMove(st, data.bestMove);
        if (mv) label = C.moveToSAN(st, mv);
      } catch (e) { /* keep uci */ }
      this.bestMoveEl.textContent = 'Best: ' + label;
    }
    if (data.depth != null) this.depthEl.textContent = 'd ' + data.depth;

    // Principal variation → SAN sequence.
    if (data.pv && data.pv.length) {
      this.pvEl.textContent = this._pvToSan(this.currentFen, data.pv);
    }
  };

  // Show a terminal position (no best move available from the engine).
  ChessOverlay.prototype.showTerminal = function (fen) {
    let label = 'Game over';
    try {
      const st = C.parseFEN(fen);
      const hasMoves = C.generateLegalMoves(st).length > 0;
      if (!hasMoves) {
        if (C.inCheck(st, st.turn)) {
          label = 'Checkmate';
          this.evalText.textContent = st.turn === 'w' ? '#-0' : '#0';
          this.evalBarWhite.style.width = st.turn === 'w' ? '0%' : '100%';
        } else {
          label = 'Stalemate';
          this.evalText.textContent = '0.00';
          this.evalBarWhite.style.width = '50%';
        }
      }
    } catch (e) { /* ignore */ }
    this.bestMoveEl.textContent = label;
    this.pvEl.textContent = '—';
  };

  ChessOverlay.prototype._pvToSan = function (fen, pvUci) {
    try {
      let st = C.parseFEN(fen);
      const out = [];
      let moveNo = st.full;
      let first = true;
      for (const uci of pvUci.slice(0, 12)) {
        const mv = C.uciToMove(st, uci);
        if (!mv) break;
        const san = C.moveToSAN(st, mv);
        if (st.turn === 'w') out.push(moveNo + '. ' + san);
        else { out.push((first ? moveNo + '... ' : '') + san); }
        if (st.turn === 'b') moveNo++;
        first = false;
        st = C.applyMove(st, mv);
      }
      return out.join(' ');
    } catch (e) {
      return pvUci.join(' ');
    }
  };

  function navBtnStyle() {
    return {
      flex: '0 0 auto', minWidth: '30px', padding: '4px 6px', cursor: 'pointer',
      background: '#3a3835', color: '#e8e6e3', border: '1px solid #4a4844',
      borderRadius: '4px', fontSize: '12px',
    };
  }
  function primaryBtnStyle() {
    return {
      flex: '1', padding: '6px', cursor: 'pointer', background: ACCENT, color: '#12240a',
      border: 'none', borderRadius: '4px', fontWeight: '700', fontSize: '12px',
    };
  }
  function inputStyle() {
    return {
      width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: '12px',
      background: '#1e1c1a', color: '#e8e6e3', border: '1px solid #444', borderRadius: '4px',
      fontFamily: 'monospace', userSelect: 'text',
    };
  }

  root.ChessOverlay = ChessOverlay;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
