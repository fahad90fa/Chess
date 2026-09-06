/*
 * chesslib.js — a small, self-contained chess model.
 *
 * No dependencies, no network. Provides just enough of a chess engine to:
 *   - parse and serialize FEN
 *   - generate fully legal moves (castling, en passant, promotion, check rules)
 *   - parse and generate SAN (Standard Algebraic Notation)
 *   - apply UCI-style moves ("e2e4", "e7e8q")
 *   - read a PGN movetext into a sequence of positions
 *   - render a position as plain text for the overlay / standalone page
 *
 * It is intentionally compact rather than fast. Correctness is verified with
 * perft (see test/perft.test.cjs).
 *
 * Board representation: 0x88. Squares 0..127; a square is "on board" when
 * (sq & 0x88) === 0. File = sq & 7, rank = sq >> 4 (rank 0 = rank "1").
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node (tests)
  if (root) root.ChessLib = api; // browser (self/window)
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const WHITE = 'w';
  const BLACK = 'b';

  // Piece codes are single letters, upper = white, lower = black.
  const EMPTY = null;

  // Offsets in 0x88.
  const OFFSETS = {
    n: [-18, -33, -31, -14, 18, 33, 31, 14],
    b: [-17, -15, 17, 15],
    r: [-16, 16, -1, 1],
    q: [-17, -16, -15, -1, 1, 15, 16, 17],
    k: [-17, -16, -15, -1, 1, 15, 16, 17],
  };

  function sq(file, rank) { return rank * 16 + file; }
  function fileOf(s) { return s & 7; }
  function rankOf(s) { return s >> 4; }
  function onBoard(s) { return (s & 0x88) === 0; }

  function algebraic(s) {
    return 'abcdefgh'[fileOf(s)] + (rankOf(s) + 1);
  }
  function fromAlgebraic(str) {
    const f = str.charCodeAt(0) - 97; // 'a'
    const r = str.charCodeAt(1) - 49; // '1'
    return sq(f, r);
  }

  function isWhitePiece(p) { return p && p === p.toUpperCase(); }
  function colorOf(p) { return isWhitePiece(p) ? WHITE : BLACK; }
  function typeOf(p) { return p ? p.toLowerCase() : null; }
  function swap(c) { return c === WHITE ? BLACK : WHITE; }

  // ---- FEN ----------------------------------------------------------------

  function parseFEN(fen) {
    const parts = String(fen).trim().split(/\s+/);
    if (parts.length < 4) throw new Error('Invalid FEN: not enough fields');
    const [placement, turn, castling, ep] = parts;
    const half = parts[4] !== undefined ? parseInt(parts[4], 10) : 0;
    const full = parts[5] !== undefined ? parseInt(parts[5], 10) : 1;

    const board = new Array(128).fill(EMPTY);
    const rows = placement.split('/');
    if (rows.length !== 8) throw new Error('Invalid FEN: need 8 ranks');
    for (let r = 0; r < 8; r++) {
      const row = rows[r];
      const rank = 7 - r; // FEN starts from rank 8
      let file = 0;
      for (const ch of row) {
        if (/[1-8]/.test(ch)) {
          file += parseInt(ch, 10);
        } else if (/[prnbqkPRNBQK]/.test(ch)) {
          if (file > 7) throw new Error('Invalid FEN: rank too wide');
          board[sq(file, rank)] = ch;
          file++;
        } else {
          throw new Error('Invalid FEN: bad char "' + ch + '"');
        }
      }
      if (file !== 8) throw new Error('Invalid FEN: rank width != 8');
    }
    if (turn !== WHITE && turn !== BLACK) throw new Error('Invalid FEN: side to move');

    return {
      board,
      turn,
      castling: castling === '-' ? '' : castling,
      ep: ep === '-' ? -1 : fromAlgebraic(ep),
      half: Number.isFinite(half) ? half : 0,
      full: Number.isFinite(full) ? full : 1,
    };
  }

  function toFEN(state) {
    let placement = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = state.board[sq(f, r)];
        if (!p) { empty++; continue; }
        if (empty) { placement += empty; empty = 0; }
        placement += p;
      }
      if (empty) placement += empty;
      if (r > 0) placement += '/';
    }
    const castling = state.castling && state.castling.length ? state.castling : '-';
    const ep = state.ep >= 0 ? algebraic(state.ep) : '-';
    return [placement, state.turn, castling, ep, state.half, state.full].join(' ');
  }

  function clone(state) {
    return {
      board: state.board.slice(),
      turn: state.turn,
      castling: state.castling,
      ep: state.ep,
      half: state.half,
      full: state.full,
    };
  }

  // ---- Attack / check detection ------------------------------------------

  // Is square `s` attacked by side `by`?
  function isAttacked(board, s, by) {
    // Pawn attacks: a white pawn on x attacks x+15 and x+17.
    const pawnDir = by === WHITE ? 1 : -1;
    for (const d of [15, 17]) {
      const from = s - pawnDir * d;
      if (onBoard(from)) {
        const p = board[from];
        if (p && colorOf(p) === by && typeOf(p) === 'p') return true;
      }
    }
    // Knight.
    for (const off of OFFSETS.n) {
      const from = s + off;
      if (onBoard(from)) {
        const p = board[from];
        if (p && colorOf(p) === by && typeOf(p) === 'n') return true;
      }
    }
    // King (adjacent).
    for (const off of OFFSETS.k) {
      const from = s + off;
      if (onBoard(from)) {
        const p = board[from];
        if (p && colorOf(p) === by && typeOf(p) === 'k') return true;
      }
    }
    // Sliding: bishop/queen (diagonals) and rook/queen (orthogonals).
    for (const off of OFFSETS.b) {
      let from = s + off;
      while (onBoard(from)) {
        const p = board[from];
        if (p) {
          if (colorOf(p) === by && (typeOf(p) === 'b' || typeOf(p) === 'q')) return true;
          break;
        }
        from += off;
      }
    }
    for (const off of OFFSETS.r) {
      let from = s + off;
      while (onBoard(from)) {
        const p = board[from];
        if (p) {
          if (colorOf(p) === by && (typeOf(p) === 'r' || typeOf(p) === 'q')) return true;
          break;
        }
        from += off;
      }
    }
    return false;
  }

  function findKing(board, color) {
    const k = color === WHITE ? 'K' : 'k';
    for (let s = 0; s < 128; s++) {
      if ((s & 0x88) === 0 && board[s] === k) return s;
    }
    return -1;
  }

  function inCheck(state, color) {
    const ks = findKing(state.board, color);
    if (ks < 0) return false;
    return isAttacked(state.board, ks, swap(color));
  }

  // ---- Move generation ----------------------------------------------------

  // A move: { from, to, piece, captured, promotion, flags }
  // flags: 'n' normal, 'c' capture, 'b' big pawn (double push), 'e' ep,
  //        'k' kingside castle, 'q' queenside castle, 'p' promotion
  function makeMove(from, to, piece, captured, flags, promotion) {
    return { from, to, piece, captured: captured || null, promotion: promotion || null, flags };
  }

  function generatePseudoMoves(state, onlyFrom) {
    const board = state.board;
    const us = state.turn;
    const them = swap(us);
    const moves = [];
    const secondRank = us === WHITE ? 1 : 6;
    const promoRank = us === WHITE ? 7 : 0;
    const pawnPush = us === WHITE ? 16 : -16;
    const pawnCaps = us === WHITE ? [15, 17] : [-15, -17];

    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; } // skip off-board columns fast
      const p = board[s];
      if (!p || colorOf(p) !== us) continue;
      if (onlyFrom !== undefined && s !== onlyFrom) continue;
      const t = typeOf(p);

      if (t === 'p') {
        // Single push.
        const one = s + pawnPush;
        if (onBoard(one) && !board[one]) {
          if (rankOf(one) === promoRank) {
            for (const promo of ['q', 'r', 'b', 'n']) {
              moves.push(makeMove(s, one, p, null, 'p', us === WHITE ? promo.toUpperCase() : promo));
            }
          } else {
            moves.push(makeMove(s, one, p, null, 'n'));
            // Double push.
            if (rankOf(s) === secondRank) {
              const two = s + pawnPush * 2;
              if (!board[two]) moves.push(makeMove(s, two, p, null, 'b'));
            }
          }
        }
        // Captures + en passant.
        for (const dc of pawnCaps) {
          const to = s + dc;
          if (!onBoard(to)) continue;
          const target = board[to];
          if (target && colorOf(target) === them) {
            if (rankOf(to) === promoRank) {
              for (const promo of ['q', 'r', 'b', 'n']) {
                moves.push(makeMove(s, to, p, target, 'pc', us === WHITE ? promo.toUpperCase() : promo));
              }
            } else {
              moves.push(makeMove(s, to, p, target, 'c'));
            }
          } else if (to === state.ep) {
            const capSq = us === WHITE ? to - 16 : to + 16;
            moves.push(makeMove(s, to, p, board[capSq], 'e'));
          }
        }
      } else if (t === 'n' || t === 'k') {
        for (const off of OFFSETS[t]) {
          const to = s + off;
          if (!onBoard(to)) continue;
          const target = board[to];
          if (!target) moves.push(makeMove(s, to, p, null, 'n'));
          else if (colorOf(target) === them) moves.push(makeMove(s, to, p, target, 'c'));
        }
      } else {
        // Sliding pieces.
        for (const off of OFFSETS[t]) {
          let to = s + off;
          while (onBoard(to)) {
            const target = board[to];
            if (!target) {
              moves.push(makeMove(s, to, p, null, 'n'));
            } else {
              if (colorOf(target) === them) moves.push(makeMove(s, to, p, target, 'c'));
              break;
            }
            to += off;
          }
        }
      }
    }

    // Castling (only when generating all moves for the king's side to move).
    if (onlyFrom === undefined) {
      const rights = state.castling;
      const kFrom = us === WHITE ? sq(4, 0) : sq(4, 7);
      if (board[kFrom] === (us === WHITE ? 'K' : 'k') && !isAttacked(board, kFrom, them)) {
        const kSide = us === WHITE ? 'K' : 'k';
        const qSide = us === WHITE ? 'Q' : 'q';
        if (rights.indexOf(kSide) !== -1) {
          const f1 = kFrom + 1, f2 = kFrom + 2;
          const rookSq = us === WHITE ? sq(7, 0) : sq(7, 7);
          if (!board[f1] && !board[f2] && board[rookSq] === (us === WHITE ? 'R' : 'r') &&
              !isAttacked(board, f1, them) && !isAttacked(board, f2, them)) {
            moves.push(makeMove(kFrom, f2, board[kFrom], null, 'k'));
          }
        }
        if (rights.indexOf(qSide) !== -1) {
          const d1 = kFrom - 1, d2 = kFrom - 2, b1 = kFrom - 3;
          const rookSq = us === WHITE ? sq(0, 0) : sq(0, 7);
          if (!board[d1] && !board[d2] && !board[b1] && board[rookSq] === (us === WHITE ? 'R' : 'r') &&
              !isAttacked(board, d1, them) && !isAttacked(board, d2, them)) {
            moves.push(makeMove(kFrom, d2, board[kFrom], null, 'q'));
          }
        }
      }
    }

    return moves;
  }

  // Apply a move to a *copy* and return the new state (no legality check).
  function applyMove(state, move) {
    const ns = clone(state);
    const board = ns.board;
    const us = state.turn;
    const them = swap(us);
    const p = board[move.from];

    board[move.to] = move.promotion ? move.promotion : p;
    board[move.from] = EMPTY;

    // En passant capture removes the pawn behind the target square.
    if (move.flags.indexOf('e') !== -1) {
      const capSq = us === WHITE ? move.to - 16 : move.to + 16;
      board[capSq] = EMPTY;
    }

    // Castling moves the rook too.
    if (move.flags.indexOf('k') !== -1) {
      const rank = us === WHITE ? 0 : 7;
      board[sq(5, rank)] = board[sq(7, rank)];
      board[sq(7, rank)] = EMPTY;
    } else if (move.flags.indexOf('q') !== -1) {
      const rank = us === WHITE ? 0 : 7;
      board[sq(3, rank)] = board[sq(0, rank)];
      board[sq(0, rank)] = EMPTY;
    }

    // Update castling rights.
    let rights = ns.castling;
    const stripAll = (color) => {
      const chars = color === WHITE ? ['K', 'Q'] : ['k', 'q'];
      for (const c of chars) rights = rights.replace(c, '');
    };
    if (typeOf(p) === 'k') stripAll(us);
    // Moving or capturing a rook on its home square strips that right.
    const homeRookRights = {
      [sq(0, 0)]: 'Q', [sq(7, 0)]: 'K', [sq(0, 7)]: 'q', [sq(7, 7)]: 'k',
    };
    if (homeRookRights[move.from]) rights = rights.replace(homeRookRights[move.from], '');
    if (homeRookRights[move.to]) rights = rights.replace(homeRookRights[move.to], '');
    ns.castling = rights;

    // En passant target square.
    ns.ep = move.flags.indexOf('b') !== -1 ? (us === WHITE ? move.from + 16 : move.from - 16) : -1;

    // Halfmove clock.
    if (typeOf(p) === 'p' || move.captured) ns.half = 0; else ns.half = state.half + 1;
    // Fullmove number.
    ns.full = us === WHITE ? state.full : state.full + 1;
    ns.turn = them;
    return ns;
  }

  function generateLegalMoves(state, onlyFrom) {
    const pseudo = generatePseudoMoves(state, onlyFrom);
    const legal = [];
    const us = state.turn;
    for (const m of pseudo) {
      const ns = applyMove(state, m);
      if (!isAttacked(ns.board, findKing(ns.board, us), swap(us))) legal.push(m);
    }
    return legal;
  }

  // ---- SAN ----------------------------------------------------------------

  function moveToSAN(state, move) {
    // Castling.
    if (move.flags.indexOf('k') !== -1) return decorate('O-O', state, move);
    if (move.flags.indexOf('q') !== -1) return decorate('O-O-O', state, move);

    const piece = typeOf(move.piece);
    const isCapture = move.flags.indexOf('c') !== -1 || move.flags.indexOf('e') !== -1;
    let san = '';

    if (piece === 'p') {
      if (isCapture) san += 'abcdefgh'[fileOf(move.from)] + 'x';
      san += algebraic(move.to);
      if (move.promotion) san += '=' + move.promotion.toUpperCase();
    } else {
      san += piece.toUpperCase();
      san += disambiguation(state, move);
      if (isCapture) san += 'x';
      san += algebraic(move.to);
    }
    return decorate(san, state, move);
  }

  function decorate(san, state, move) {
    const ns = applyMove(state, move);
    const opp = ns.turn;
    if (inCheck(ns, opp)) {
      const hasMoves = generateLegalMoves(ns).length > 0;
      san += hasMoves ? '+' : '#';
    }
    return san;
  }

  function disambiguation(state, move) {
    const piece = typeOf(move.piece);
    const others = generateLegalMoves(state).filter(
      (m) => m.to === move.to && typeOf(m.piece) === piece && m.from !== move.from
    );
    if (others.length === 0) return '';
    const sameFile = others.some((m) => fileOf(m.from) === fileOf(move.from));
    const sameRank = others.some((m) => rankOf(m.from) === rankOf(move.from));
    if (!sameFile) return 'abcdefgh'[fileOf(move.from)];
    if (!sameRank) return String(rankOf(move.from) + 1);
    return algebraic(move.from);
  }

  // Parse one SAN token into a legal move for the given state.
  function sanToMove(state, sanRaw) {
    const san = String(sanRaw).replace(/[+#!?]+$/, '').replace(/e\.p\.?$/i, '').trim();
    const legal = generateLegalMoves(state);

    if (san === 'O-O' || san === '0-0') return legal.find((m) => m.flags.indexOf('k') !== -1) || null;
    if (san === 'O-O-O' || san === '0-0-0') return legal.find((m) => m.flags.indexOf('q') !== -1) || null;

    // Structure: [piece]?[fromFile]?[fromRank]?[x]?dest[=Promo]?
    const m = san.match(/^([KQRBN])?([a-h])?([1-8])?x?([a-h][1-8])(?:=?([QRBN]))?$/);
    if (!m) return null;
    const [, pieceLetter, fromFile, fromRank, dest, promo] = m;
    const pieceType = pieceLetter ? pieceLetter.toLowerCase() : 'p';
    const destSq = fromAlgebraic(dest);

    const candidates = legal.filter((mv) => {
      if (mv.to !== destSq) return false;
      if (typeOf(mv.piece) !== pieceType) return false;
      if (fromFile && fileOf(mv.from) !== fromFile.charCodeAt(0) - 97) return false;
      if (fromRank && rankOf(mv.from) !== fromRank.charCodeAt(0) - 49) return false;
      if (promo) {
        if (!mv.promotion || mv.promotion.toLowerCase() !== promo.toLowerCase()) return false;
      } else if (mv.promotion) {
        return false; // promotion required in SAN but none specified => not this move
      }
      return true;
    });
    return candidates.length ? candidates[0] : null;
  }

  // ---- UCI ----------------------------------------------------------------

  function uciToMove(state, uci) {
    const from = fromAlgebraic(uci.slice(0, 2));
    const to = fromAlgebraic(uci.slice(2, 4));
    const promo = uci.length > 4 ? uci[4] : null;
    const legal = generateLegalMoves(state);
    return legal.find((m) => {
      if (m.from !== from || m.to !== to) return false;
      if (promo) return m.promotion && m.promotion.toLowerCase() === promo.toLowerCase();
      return !m.promotion;
    }) || null;
  }

  function moveToUCI(move) {
    let u = algebraic(move.from) + algebraic(move.to);
    if (move.promotion) u += move.promotion.toLowerCase();
    return u;
  }

  // ---- PGN ----------------------------------------------------------------

  // Returns { headers, sans: [...], states: [state0, state1, ...], fensAfter: [...] }.
  // states[i] is the position BEFORE move i; the final state is states[states.length-1].
  function parsePGN(pgnText) {
    const headers = {};
    let text = String(pgnText);
    const headerRe = /\[(\w+)\s+"([^"]*)"\]/g;
    let hm;
    while ((hm = headerRe.exec(text)) !== null) headers[hm[1]] = hm[2];

    // Strip headers, comments {...}, variations (...), NAGs $n, and result.
    let movetext = text.replace(/\[[^\]]*\]/g, ' ');
    movetext = movetext.replace(/\{[^}]*\}/g, ' ');
    movetext = stripParens(movetext);
    movetext = movetext.replace(/\$\d+/g, ' ');
    movetext = movetext.replace(/\b(1-0|0-1|1\/2-1\/2|\*)\s*$/g, ' ');
    // Remove move numbers like "12." or "12..."
    movetext = movetext.replace(/\d+\.(\.\.)?/g, ' ');

    const tokens = movetext.split(/\s+/).filter(Boolean);
    const startFEN = headers.FEN || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    let state = parseFEN(startFEN);
    const states = [clone(state)];
    const sans = [];
    const fensAfter = [];
    for (const tok of tokens) {
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) continue;
      const move = sanToMove(state, tok);
      if (!move) throw new Error('PGN: illegal or unparsable move "' + tok + '" at ply ' + sans.length);
      state = applyMove(state, move);
      sans.push(tok);
      states.push(clone(state));
      fensAfter.push(toFEN(state));
    }
    return { headers, sans, states, fensAfter, startFEN };
  }

  function stripParens(s) {
    // Remove nested (...) variation blocks.
    let out = '';
    let depth = 0;
    for (const ch of s) {
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth > 0) depth--; }
      else if (depth === 0) out += ch;
    }
    return out;
  }

  // ---- Rendering ----------------------------------------------------------

  const UNICODE = {
    K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
    k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
  };

  function toUnicodeBoard(state, flip) {
    const rows = [];
    const rankOrder = flip ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
    const fileOrder = flip ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
    for (const r of rankOrder) {
      let line = (r + 1) + ' ';
      for (const f of fileOrder) {
        const p = state.board[sq(f, r)];
        line += (p ? UNICODE[p] : '·') + ' ';
      }
      rows.push(line);
    }
    rows.push('  ' + fileOrder.map((f) => 'abcdefgh'[f]).join(' '));
    return rows.join('\n');
  }

  // Return a plain 8x8 array (rank 8 first) of piece letters or null, for UI grids.
  function toGrid(state) {
    const grid = [];
    for (let r = 7; r >= 0; r--) {
      const row = [];
      for (let f = 0; f < 8; f++) row.push(state.board[sq(f, r)]);
      grid.push(row);
    }
    return grid;
  }

  function validateFEN(fen) {
    try { parseFEN(fen); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  // Perft for correctness testing.
  function perft(state, depth) {
    if (depth === 0) return 1;
    const moves = generateLegalMoves(state);
    if (depth === 1) return moves.length;
    let nodes = 0;
    for (const m of moves) nodes += perft(applyMove(state, m), depth - 1);
    return nodes;
  }

  return {
    WHITE, BLACK,
    parseFEN, toFEN, clone, validateFEN,
    generateLegalMoves, generatePseudoMoves, applyMove,
    isAttacked, inCheck, findKing,
    moveToSAN, sanToMove, uciToMove, moveToUCI,
    parsePGN,
    toUnicodeBoard, toGrid, algebraic, fromAlgebraic, fileOf, rankOf, colorOf, typeOf,
    perft,
    UNICODE,
  };
});
