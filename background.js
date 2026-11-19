// Service worker: relays analysis requests from the content script to the
// offscreen document, which hosts the Stockfish web worker.

const OFFSCREEN_URL = 'offscreen.html';
let creating = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS'],
        justification: 'Runs the Stockfish chess engine in a web worker.',
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Messages addressed to the offscreen document are not for us.
  if (!msg || msg.target || msg.type !== 'analyze') return false;

  (async () => {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
    sendResponse(res);
  })().catch((err) => sendResponse({ id: msg.id, error: String(err && err.message ? err.message : err) }));

  return true; // async response
});
