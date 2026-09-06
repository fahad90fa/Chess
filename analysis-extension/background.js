/*
 * background.js — MV3 service worker.
 *
 * Bridges the chess.com content script and the Stockfish engine. The engine
 * cannot run in a content script (the page's CSP blocks extension Workers) and
 * cannot run in a service worker (no Worker/DOM). So it runs in an OFFSCREEN
 * DOCUMENT (extension origin, extension CSP), and this worker relays messages:
 *
 *   content.js  --(ANALYZE/STOP)-->  background  --(to-offscreen)-->  offscreen.js
 *   content.js  <--(engine-result)-- background  <--(from-offscreen)-- offscreen.js
 *
 * Channels keep the shared runtime message bus unambiguous:
 *   'engine'         : content -> background (requests)
 *   'to-offscreen'   : background -> offscreen (requests)
 *   'from-offscreen' : offscreen -> background (results)
 *   'engine-result'  : background -> content tab (results)
 */

const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreen = null;

async function hasOffscreenDocument() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    try { return await chrome.offscreen.hasDocument(); } catch (e) { /* fall through */ }
  }
  // Fallback: inspect existing clients.
  const matched = await clients.matchAll();
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  return matched.some((c) => c.url === url);
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS'],
    justification: 'Run the Stockfish chess engine (a WebAssembly Web Worker) locally to analyze positions.',
  }).catch((err) => {
    // If it already exists (race), ignore; otherwise rethrow.
    if (!String(err && err.message).includes('Only a single offscreen')) throw err;
  });
  await creatingOffscreen;
  creatingOffscreen = null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  // Requests from a content script.
  if (msg.channel === 'engine') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    (async () => {
      try {
        await ensureOffscreen();
        chrome.runtime.sendMessage({
          channel: 'to-offscreen',
          type: msg.type,          // 'ANALYZE' | 'STOP'
          fen: msg.fen,
          options: msg.options || {},
          requestId: msg.requestId,
          tabId,
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
    })();
    return true; // async response
  }

  // Results coming back from the offscreen engine host.
  if (msg.channel === 'from-offscreen') {
    if (msg.tabId != null) {
      chrome.tabs.sendMessage(msg.tabId, {
        channel: 'engine-result',
        type: msg.type,            // 'INFO' | 'BESTMOVE' | 'ERROR' | 'READY'
        requestId: msg.requestId,
        payload: msg.payload,
      }).catch(() => { /* tab may have closed */ });
    }
    return;
  }

  // Popup asks to open the standalone analyzer.
  if (msg.channel === 'ui' && msg.type === 'OPEN_STANDALONE') {
    chrome.tabs.create({ url: chrome.runtime.getURL('standalone/index.html') });
    return;
  }
});
