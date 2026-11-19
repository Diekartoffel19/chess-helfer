// Runs in the page's own JS world so it can read chess.com's board API
// and execute moves when requested by content.js.
(() => {
  const SOURCE = 'chess-helfer-page';
  const CONTENT_SOURCE = 'chess-helfer-content';

  function findGame() {
    const board = document.querySelector('wc-chess-board, chess-board');
    return board && board.game ? board.game : null;
  }

  function normalizeColor(v) {
    if (v === 1 || v === 'w' || v === 'white') return 'w';
    if (v === 2 || v === 'b' || v === 'black') return 'b';
    return null;
  }

  function readState() {
    try {
      const game = findGame();
      if (!game) return { fen: null, playingAs: null, gameOver: false };
      const fen = typeof game.getFEN === 'function' ? game.getFEN() : null;
      const playingAs = typeof game.getPlayingAs === 'function' ? normalizeColor(game.getPlayingAs()) : null;
      const gameOver = Boolean(
        (typeof game.isGameOver === 'function' && game.isGameOver()) ||
          (typeof game.getPositionInfo === 'function' && game.getPositionInfo()?.gameOver)
      );
      return {
        fen: typeof fen === 'string' ? fen : null,
        playingAs,
        gameOver,
      };
    } catch (_) {}
    return { fen: null, playingAs: null, gameOver: false };
  }

  function postState() {
    window.postMessage({ source: SOURCE, type: 'state', ...readState() }, window.location.origin);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== CONTENT_SOURCE || e.data.type !== 'make-move') return;
    const { moveId, from, to, promotion, expectedFen } = e.data;
    if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) return;
    if (promotion && !/^[qrbn]$/.test(promotion)) return;

    let moved = false;
    let stale = false;
    try {
      const game = findGame();
      const beforeFen = game && typeof game.getFEN === 'function' ? game.getFEN() : null;
      if (expectedFen && beforeFen && beforeFen !== expectedFen) {
        stale = true;
      } else if (game && typeof game.move === 'function') {
        const move = { from, to, animate: false, userGenerated: true };
        if (promotion) move.promotion = promotion;
        game.move(move);
        const afterFen = typeof game.getFEN === 'function' ? game.getFEN() : null;
        moved = Boolean(afterFen && afterFen !== beforeFen);
      }
    } catch (_) {}

    const state = readState();
    window.postMessage(
      { source: SOURCE, type: 'move-result', moveId, expectedFen, moved, stale, ...state },
      window.location.origin
    );
  });

  setInterval(postState, 250);
})();
