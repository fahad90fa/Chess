/*
 * worker.js — Stockfish wrapper.
 *
 * This does NOT run inside a Web Worker itself; it is a small controller that
 * OWNS a Web Worker. The actual engine is engine/stockfish.js (Stockfish 17.1
 * WASM, nmrugg build), which is purpose-built to run as a Worker and locates
 * its own engine/stockfish.wasm sibling. We must spawn that file directly:
 * importScripts()-ing it into a differently named worker breaks the .wasm path
 * lookup, so this wrapper is the correct, robust way to drive it.
 *
 * Used by:
 *   - offscreen.js (the chess.com content-script path routes through here)
 *   - standalone/standalone.js and popup.js (extension pages spawn it directly)
 *
 * Exposes a global `createStockfish(engineUrl, handlers)` returning an engine
 * controller with analyze()/stop()/quit(). All analysis is local; no network.
 */
(function (root) {
  'use strict';

  function createStockfish(engineUrl, handlers) {
    handlers = handlers || {};
    const worker = new Worker(engineUrl);

    let ready = false;
    let uciOk = false;
    const readyWaiters = [];

    // Current search bookkeeping.
    let current = null;   // { id, fen, resolve, best, ponder, lastInfo }
    let pending = null;   // queued request while a search is stopping
    let stopping = false; // we've sent "stop" and are waiting for its bestmove

    function send(cmd) { worker.postMessage(cmd); }

    function onReady(cb) {
      if (ready) cb();
      else readyWaiters.push(cb);
    }

    function parseInfo(line) {
      // Example: info depth 20 seldepth 30 multipv 1 score cp 34 nodes ... pv e2e4 ...
      const info = { raw: line };
      const depthM = line.match(/\bdepth (\d+)/);
      if (depthM) info.depth = parseInt(depthM[1], 10);
      const selM = line.match(/\bseldepth (\d+)/);
      if (selM) info.seldepth = parseInt(selM[1], 10);
      const mpvM = line.match(/\bmultipv (\d+)/);
      if (mpvM) info.multipv = parseInt(mpvM[1], 10);
      const npsM = line.match(/\bnps (\d+)/);
      if (npsM) info.nps = parseInt(npsM[1], 10);
      const nodesM = line.match(/\bnodes (\d+)/);
      if (nodesM) info.nodes = parseInt(nodesM[1], 10);
      const cpM = line.match(/score cp (-?\d+)/);
      const mateM = line.match(/score mate (-?\d+)/);
      if (mateM) { info.mate = parseInt(mateM[1], 10); }
      else if (cpM) { info.cp = parseInt(cpM[1], 10); }
      const pvM = line.match(/ pv (.+)$/);
      if (pvM) info.pv = pvM[1].trim().split(/\s+/);
      return info;
    }

    worker.onmessage = function (e) {
      const line = typeof e.data === 'string' ? e.data : (e.data && e.data.data) || '';
      if (!line) return;

      if (line === 'uciok') {
        uciOk = true;
        send('setoption name Threads value 1'); // single-threaded: no COOP/COEP needed
        send('setoption name Hash value 32');
        send('setoption name MultiPV value 1');
        send('isready');
        return;
      }
      if (line === 'readyok') {
        if (!ready) {
          ready = true;
          readyWaiters.splice(0).forEach((cb) => cb());
        }
        return;
      }

      if (line.startsWith('info ')) {
        if (current && line.includes(' pv ')) {
          const info = parseInfo(line);
          // Only report multipv 1 (or unspecified) as the main line.
          if (!info.multipv || info.multipv === 1) {
            current.lastInfo = info;
            if (info.pv && info.pv.length) current.best = info.pv[0];
            if (handlers.onInfo) handlers.onInfo({ id: current.id, fen: current.fen, info });
          }
        }
        return;
      }

      if (line.startsWith('bestmove')) {
        const m = line.match(/^bestmove (\S+)(?:\s+ponder (\S+))?/);
        const best = m ? m[1] : null;
        const ponder = m && m[2] ? m[2] : null;

        if (stopping) {
          // This bestmove belongs to the search we interrupted; discard it and
          // launch whatever was queued.
          stopping = false;
          const cancelledId = current ? current.id : null;
          const next = pending;
          pending = null;
          current = null;
          if (cancelledId != null && handlers.onCancel) handlers.onCancel(cancelledId);
          if (next) startSearch(next);
          return;
        }

        if (current) {
          const done = current;
          current = null;
          const result = {
            id: done.id,
            fen: done.fen,
            bestMove: best === '(none)' ? null : best,
            ponder,
            info: done.lastInfo || null,
          };
          if (handlers.onBestMove) handlers.onBestMove(result);
          if (done.resolve) done.resolve(result);
        }
        return;
      }
    };

    worker.onerror = function (err) {
      if (handlers.onError) handlers.onError(err && (err.message || String(err)) || 'worker error');
    };

    function startSearch(req) {
      current = {
        id: req.id, fen: req.fen, resolve: req.resolve,
        best: null, ponder: null, lastInfo: null,
      };
      onReady(() => {
        if (!current || current.id !== req.id) return; // superseded
        send('position fen ' + req.fen);
        if (req.movetime) send('go movetime ' + req.movetime);
        else send('go depth ' + (req.depth || 18));
      });
    }

    /**
     * Analyze a FEN. Options: { depth, movetime, id }. Returns a Promise that
     * resolves with { bestMove, ponder, info, fen, id } when the search ends.
     * A new analyze() cancels any in-flight search.
     */
    function analyze(fen, options) {
      options = options || {};
      const req = {
        id: options.id != null ? options.id : (analyze._n = (analyze._n || 0) + 1),
        fen,
        depth: options.depth,
        movetime: options.movetime,
        resolve: null,
      };
      const promise = new Promise((resolve) => { req.resolve = resolve; });

      if (current || stopping) {
        // Interrupt the running search; queue this one (keep only the latest).
        pending = req;
        if (current && !stopping) { stopping = true; send('stop'); }
      } else {
        startSearch(req);
      }
      return promise;
    }

    function stop() {
      pending = null;
      if (current && !stopping) { stopping = true; send('stop'); }
    }

    function quit() {
      try { send('quit'); } catch (e) { /* ignore */ }
      try { worker.terminate(); } catch (e) { /* ignore */ }
    }

    function setOption(name, value) { send('setoption name ' + name + ' value ' + value); }

    // Kick off UCI handshake.
    send('uci');

    return { analyze, stop, quit, setOption, onReady, isReady: () => ready, _worker: worker };
  }

  root.createStockfish = createStockfish;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createStockfish };
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
