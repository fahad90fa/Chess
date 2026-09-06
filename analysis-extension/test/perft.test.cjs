const C = require('../chesslib.js');
let fails = 0;
function eq(actual, expected, label) {
  const ok = actual === expected;
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + ' => got ' + actual + (ok ? '' : ' expected ' + expected));
}

// --- Perft: start position (known values) ---
const start = C.parseFEN('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
eq(C.perft(start, 1), 20, 'perft(start,1)');
eq(C.perft(start, 2), 400, 'perft(start,2)');
eq(C.perft(start, 3), 8902, 'perft(start,3)');
eq(C.perft(start, 4), 197281, 'perft(start,4)');

// --- Perft: Kiwipete (castling, ep, promotions, checks) ---
const kiwi = C.parseFEN('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
eq(C.perft(kiwi, 1), 48, 'perft(kiwi,1)');
eq(C.perft(kiwi, 2), 2039, 'perft(kiwi,2)');
eq(C.perft(kiwi, 3), 97862, 'perft(kiwi,3)');

// --- Perft: position 3 (en passant discovered checks) ---
const p3 = C.parseFEN('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
eq(C.perft(p3, 1), 14, 'perft(pos3,1)');
eq(C.perft(p3, 2), 191, 'perft(pos3,2)');
eq(C.perft(p3, 3), 2812, 'perft(pos3,3)');
eq(C.perft(p3, 4), 43238, 'perft(pos3,4)');

// --- Perft: position 5 (promotions, tricky) ---
const p5 = C.parseFEN('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8');
eq(C.perft(p5, 1), 44, 'perft(pos5,1)');
eq(C.perft(p5, 2), 1486, 'perft(pos5,2)');
eq(C.perft(p5, 3), 62379, 'perft(pos5,3)');

// --- SAN: Ruy Lopez opening ---
let s = C.parseFEN('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']) {
  const mv = C.sanToMove(s, san);
  if (!mv) { console.log('FAIL SAN parse ' + san); fails++; break; }
  s = C.applyMove(s, mv);
}
eq(C.toFEN(s), 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4', 'Ruy Lopez FEN');

// --- SAN round-trip: every legal move parses back to itself ---
(() => {
  const pos = C.parseFEN('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  let rt = 0, bad = 0;
  for (const mv of C.generateLegalMoves(pos)) {
    const san = C.moveToSAN(pos, mv);
    const back = C.sanToMove(pos, san);
    if (!back || back.from !== mv.from || back.to !== mv.to ||
        (mv.promotion || null) !== (back.promotion || null)) bad++;
    rt++;
  }
  eq(bad, 0, 'SAN round-trip on Kiwipete (' + rt + ' moves)');
})();

// --- PGN parse: short game to a known final FEN (Scholar's Mate) ---
(() => {
  const pgn = '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6?? 4. Qxf7# 1-0';
  const res = C.parsePGN(pgn);
  eq(res.fensAfter[res.fensAfter.length - 1],
     'r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4',
     'Scholar mate final FEN');
  // Last move should be mate (#).
  eq(res.sans.length, 7, 'Scholar mate ply count');
})();

// --- Castling + promotion + en passant application sanity ---
(() => {
  // White castles kingside.
  let st = C.parseFEN('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 1');
  const castle = C.sanToMove(st, 'O-O');
  eq(!!castle, true, 'kingside castle parsed');
  st = C.applyMove(st, castle);
  eq(C.toFEN(st).split(' ')[0].endsWith('R1BQ1RK1'), true, 'kingside castle rook+king placement');

  // En passant.
  let ep = C.parseFEN('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
  const epMove = C.sanToMove(ep, 'exf6');
  eq(!!epMove && epMove.flags.indexOf('e') !== -1, true, 'en passant parsed as ep');
  ep = C.applyMove(ep, epMove);
  eq(C.toFEN(ep).split(' ')[0], 'rnbqkbnr/ppp1p1pp/5P2/3p4/8/8/PPPP1PPP/RNBQKBNR', 'en passant capture removes pawn');

  // Promotion to queen with check.
  let pr = C.parseFEN('8/P7/8/8/8/8/8/k6K w - - 0 1');
  const promo = C.sanToMove(pr, 'a8=Q');
  eq(!!promo && promo.promotion === 'Q', true, 'promotion parsed');
})();

console.log(fails === 0 ? '\nALL TESTS PASSED' : '\n' + fails + ' TEST(S) FAILED');
process.exit(fails === 0 ? 0 : 1);
