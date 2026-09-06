/*
 * offscreen.js — hosts the Stockfish engine Web Worker.
 *
 * Receives 'to-offscreen' requests relayed by background.js, drives the engine
 * via the worker.js wrapper, and streams results back as 'from-offscreen'
 * messages tagged with the originating tabId so background can route them.
 */
(function () {
  'use strict';

  const engineUrl = chrome.runtime.getURL('engine/stockfish.js');

  // requestId -> tabId, so streamed info/bestmove reaches the right tab.
  const reqTab = new Map();

  function emit(type, id, payload) {
    const tabId = reqTab.get(id);
    if (tabId == null) return;
    chrome.runtime.sendMessage({
      channel: 'from-offscreen',
      type,
      requestId: id,
      tabId,
      payload,
    });
  }

  const engine = createStockfish(engineUrl, {
    onInfo: ({ id, info }) => {
      emit('INFO', id, {
        depth: info.depth,
        seldepth: info.seldepth,
        cp: info.cp,
        mate: info.mate,
        nps: info.nps,
        nodes: info.nodes,
        pv: info.pv || [],
      });
    },
    onBestMove: (res) => {
      emit('BESTMOVE', res.id, {
        bestMove: res.bestMove,
        ponder: res.ponder,
        cp: res.info && res.info.cp,
        mate: res.info && res.info.mate,
        depth: res.info && res.info.depth,
        pv: (res.info && res.info.pv) || [],
      });
      reqTab.delete(res.id);
    },
    onError: (err) => {
      // Broadcast error to every waiting tab.
      for (const [id] of reqTab) emit('ERROR', id, { error: String(err) });
    },
    onCancel: (id) => {
      // An interrupted search will never produce a result; drop its mapping.
      reqTab.delete(id);
    },
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.channel !== 'to-offscreen') return;
    if (msg.type === 'ANALYZE') {
      reqTab.set(msg.requestId, msg.tabId);
      engine.analyze(msg.fen, {
        id: msg.requestId,
        depth: msg.options && msg.options.depth,
        movetime: msg.options && msg.options.movetime,
      });
    } else if (msg.type === 'STOP') {
      engine.stop();
    }
  });
})();
