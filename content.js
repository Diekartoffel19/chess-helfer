// Content script: reads the position, asks the engine, draws arrows + panel.
// Active on the analysis board and in games (play/game/live/daily).
(() => {
  'use strict';

  const ALLOWED_PATHS = [/^\/analysis(\/|$)/, /^\/play(\/|$)/, /^\/game(\/|$)/, /^\/live(\/|$)/, /^\/daily(\/|$)/];
  const DEFAULTS = {
    enabled: true,
    autoMove: false,
    autoMoveDelay: 0,
    movetime: 1000,
    multipv: 3,
    inaccuracyRate: 0,
    maxLoss: 120,
  };
  const ANALYSIS_KEYS = new Set(['enabled', 'movetime', 'multipv', 'inaccuracyRate', 'maxLoss']);
  const ARROW_COLORS = ['rgba(46,160,67,0.85)', 'rgba(56,120,220,0.7)', 'rgba(200,120,40,0.6)', 'rgba(150,80,190,0.55)', 'rgba(120,120,120,0.5)'];
  const PIECE_DE = { k: 'K', q: 'D', r: 'T', b: 'L', n: 'S', p: '' };
  const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let settings = { ...DEFAULTS };
  let apiFen = null;
  let apiPlayingAs = null;
  let apiGameOver = false;
  let lastKey = null;
  let reqId = 0;
  let result = null; // { id, fen, source, lines, bestmove }
  let drawnKey = null;
  let panel = null;
  let svg = null;
  let timer = null;
  let autoTimer = null;
  let autoMovedFen = null;
  let moveSeq = 0;
  let pendingMove = null;

  chrome.storage.sync.get(DEFAULTS).then((s) => {
    settings = { ...DEFAULTS, ...s };
    lastKey = null;
    syncAutoButton();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    let analysisChanged = false;
    for (const k of Object.keys(changes)) {
      settings[k] = changes[k].newValue;
      if (ANALYSIS_KEYS.has(k)) analysisChanged = true;
    }
    if (analysisChanged) lastKey = null;
    if ('autoMove' in changes) {
      if (settings.autoMove) {
        autoMovedFen = null;
        maybeAutoMove();
      } else {
        cancelAutoMove();
      }
      if (result) renderPanel();
    }
    syncAutoButton();
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'chess-helfer-page') return;
    apiFen = typeof e.data.fen === 'string' ? e.data.fen : null;
    apiPlayingAs = e.data.playingAs === 'w' || e.data.playingAs === 'b' ? e.data.playingAs : null;
    apiGameOver = Boolean(e.data.gameOver);

    if (e.data.type === 'move-result' && pendingMove && e.data.moveId === pendingMove.moveId) {
      const move = pendingMove;
      clearTimeout(move.fallbackTimer);
      pendingMove = null;
      if (!e.data.moved && !e.data.stale && settings.enabled && settings.autoMove) {
        const board = findBoard();
        if (board && currentFen(board) === move.expectedFen) {
          domMakeMove(board, move.from, move.to, move.promotion, move.side);
        }
      }
    }
  });

  // ---------- position reading ----------

  const isAllowedPage = () => ALLOWED_PATHS.some((re) => re.test(location.pathname));
  const findBoard = () => document.querySelector('wc-chess-board, chess-board');

  function squareOf(el) {
    for (const c of el.classList) {
      const m = /^square-([1-8])([1-8])$/.exec(c);
      if (m) return { f: Number(m[1]) - 1, r: Number(m[2]) - 1 };
    }
    return null;
  }

  // grid[rank][file], 0-based, rank 0 = first rank; value like 'wp' or null
  function readGrid(board) {
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    for (const el of board.querySelectorAll('.piece')) {
      const sq = squareOf(el);
      const type = [...el.classList].find((c) => /^[wb][pnbrqk]$/.test(c));
      if (sq && type) grid[sq.r][sq.f] = type;
    }
    return grid;
  }

  function gridFromFen(fen) {
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    fen.split(' ')[0].split('/').forEach((row, i) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) f += Number(ch);
        else {
          grid[7 - i][f] = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toLowerCase();
          f++;
        }
      }
    });
    return grid;
  }

  function isAttacked(grid, f, r, by) {
    const at = (ff, rr) => (ff >= 0 && ff < 8 && rr >= 0 && rr < 8 ? grid[rr][ff] : undefined);
    const dir = by === 'w' ? 1 : -1;
    if (at(f - 1, r - dir) === by + 'p' || at(f + 1, r - dir) === by + 'p') return true;
    for (const [df, dr] of KNIGHT) if (at(f + df, r + dr) === by + 'n') return true;
    for (const [df, dr] of KING) if (at(f + df, r + dr) === by + 'k') return true;
    const slide = (dirs, kinds) =>
      dirs.some(([df, dr]) => {
        let ff = f + df;
        let rr = r + dr;
        while (at(ff, rr) === null) {
          ff += df;
          rr += dr;
        }
        const p = at(ff, rr);
        return !!p && p[0] === by && kinds.includes(p[1]);
      });
    return slide(ROOK_DIRS, 'rq') || slide(BISHOP_DIRS, 'bq');
  }

  // Rejects positions that would crash or confuse the engine.
  function isPlausible(grid, side) {
    const kings = { w: [], b: [] };
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = grid[r][f];
        if (!p) continue;
        if (p[1] === 'k') kings[p[0]].push([f, r]);
        if (p[1] === 'p' && (r === 0 || r === 7)) return false;
      }
    }
    if (kings.w.length !== 1 || kings.b.length !== 1) return false;
    const [kf, kr] = side === 'w' ? kings.b[0] : kings.w[0];
    return !isAttacked(grid, kf, kr, side);
  }

  // Fallback when the board API is unavailable: rebuild a FEN from the DOM.
  // Side to move is guessed from the last-move highlight.
  function domFen(board) {
    const grid = readGrid(board);
    let side = 'w';
    for (const el of board.querySelectorAll('.highlight')) {
      const sq = squareOf(el);
      const p = sq && grid[sq.r][sq.f];
      if (p) {
        side = p[0] === 'w' ? 'b' : 'w';
        break;
      }
    }
    if (!isPlausible(grid, side)) return null;

    let castle = '';
    if (grid[0][4] === 'wk') {
      if (grid[0][7] === 'wr') castle += 'K';
      if (grid[0][0] === 'wr') castle += 'Q';
    }
    if (grid[7][4] === 'bk') {
      if (grid[7][7] === 'br') castle += 'k';
      if (grid[7][0] === 'br') castle += 'q';
    }

    const rows = [];
    for (let r = 7; r >= 0; r--) {
      let row = '';
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = grid[r][f];
        if (!p) {
          empty++;
          continue;
        }
        if (empty) row += empty;
        empty = 0;
        row += p[0] === 'w' ? p[1].toUpperCase() : p[1];
      }
      rows.push(row + (empty || ''));
    }
    return `${rows.join('/')} ${side} ${castle || '-'} - 0 1`;
  }

  function isFlipped(board) {
    const b = board.getBoundingClientRect();
    if (b.width) {
      for (const el of board.querySelectorAll('.piece')) {
        if (el.classList.contains('dragging')) continue;
        const sq = squareOf(el);
        const p = el.getBoundingClientRect();
        if (!sq || !p.width) continue;
        const col = Math.floor(((p.left + p.width / 2 - b.left) / b.width) * 8);
        return col !== sq.f;
      }
    }
    return board.classList.contains('flipped');
  }

  // ---------- formatting ----------

  function formatScore(score, side) {
    const sign = side === 'w' ? 1 : -1; // engine scores are from side to move
    if ('mate' in score) {
      const m = score.mate * sign;
      return m > 0 ? `M${m}` : `-M${-m}`;
    }
    const v = (score.cp * sign) / 100;
    return (v > 0 ? '+' : '') + v.toFixed(2);
  }

  function formatMove(fen, uci) {
    const grid = gridFromFen(fen);
    const sq = (s) => ({ f: s.charCodeAt(0) - 97, r: Number(s[1]) - 1 });
    const from = sq(uci.slice(0, 2));
    const to = sq(uci.slice(2, 4));
    const piece = grid[from.r][from.f];
    if (!piece) return uci;
    if (piece[1] === 'k' && Math.abs(to.f - from.f) === 2) return to.f > from.f ? '0-0' : '0-0-0';
    const isCapture = !!grid[to.r][to.f] || (piece[1] === 'p' && from.f !== to.f);
    const promo = uci[4] ? '=' + PIECE_DE[uci[4]] : '';
    return `${PIECE_DE[piece[1]]}${uci.slice(0, 2)}${isCapture ? 'x' : '–'}${uci.slice(2, 4)}${promo}`;
  }

  // ---------- arrows ----------

  function arrowPoints(x1, y1, x2, y2, w) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;
    const head = Math.min(0.42, len * 0.5);
    const hw = w * 2.4;
    const bx = x2 - ux * head;
    const by = y2 - uy * head;
    const pts = [
      [x1 + (px * w) / 2, y1 + (py * w) / 2],
      [bx + (px * w) / 2, by + (py * w) / 2],
      [bx + (px * hw) / 2, by + (py * hw) / 2],
      [x2, y2],
      [bx - (px * hw) / 2, by - (py * hw) / 2],
      [bx - (px * w) / 2, by - (py * w) / 2],
      [x1 - (px * w) / 2, y1 - (py * w) / 2],
    ];
    return pts.map((p) => p.map((n) => n.toFixed(3)).join(',')).join(' ');
  }

  function ensureSvg(board) {
    if (!svg) {
      svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('id', 'chess-helfer-arrows');
      svg.setAttribute('viewBox', '0 0 8 8');
    }
    if (svg.parentNode !== board) {
      if (getComputedStyle(board).position === 'static') board.style.position = 'relative';
      board.appendChild(svg);
      drawnKey = null;
    }
  }

  function drawArrows(board) {
    ensureSvg(board);
    const flipped = isFlipped(board);
    const key = `${result.id}|${flipped}`;
    if (key === drawnKey) return;
    drawnKey = key;
    svg.replaceChildren();

    const center = (s) => {
      const f = s.charCodeAt(0) - 97;
      const r = Number(s[1]) - 1;
      return flipped ? [7 - f + 0.5, r + 0.5] : [f + 0.5, 7 - r + 0.5];
    };

    // draw weakest first so the best move ends up on top
    [...result.lines].reverse().forEach((line) => {
      const mv = line.pv[0];
      if (!mv) return;
      const [x1, y1] = center(mv.slice(0, 2));
      const [x2, y2] = center(mv.slice(2, 4));
      const i = line.multipv - 1;
      const poly = document.createElementNS(SVG_NS, 'polygon');
      poly.setAttribute('points', arrowPoints(x1, y1, x2, y2, i === 0 ? 0.2 : 0.13));
      poly.setAttribute('fill', ARROW_COLORS[i] || ARROW_COLORS[ARROW_COLORS.length - 1]);
      svg.appendChild(poly);
    });
  }

  function clearArrows() {
    if (svg) svg.replaceChildren();
    drawnKey = null;
  }

  // ---------- panel ----------

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function syncAutoButton() {
    if (!panel) return;
    const btn = panel.querySelector('.ch-auto');
    if (!btn) return;
    btn.classList.toggle('ch-auto-on', Boolean(settings.autoMove));
    btn.setAttribute('aria-pressed', String(Boolean(settings.autoMove)));
  }

  function ensurePanel() {
    if (panel && panel.isConnected) return;
    panel = el('div');
    panel.id = 'chess-helfer-panel';
    const head = el('div', 'ch-head');
    head.append(el('span', 'ch-title', '♞ Chess-Helfer'));
    const actions = el('div', 'ch-actions');
    const autoBtn = el('button', 'ch-auto', 'Auto');
    autoBtn.type = 'button';
    autoBtn.title = 'Auto-Zug ein-/ausschalten';
    autoBtn.addEventListener('click', () => {
      const next = !settings.autoMove;
      settings.autoMove = next;
      if (next) autoMovedFen = null;
      else cancelAutoMove();
      syncAutoButton();
      if (result) renderPanel();
      chrome.storage.sync.set({ autoMove: next });
      if (next) maybeAutoMove();
    });
    const min = el('button', 'ch-min', '–');
    min.type = 'button';
    min.title = 'Ein-/ausklappen';
    min.addEventListener('click', () => {
      panel.classList.toggle('ch-collapsed');
      min.textContent = panel.classList.contains('ch-collapsed') ? '+' : '–';
    });
    actions.append(autoBtn, min);
    head.append(actions);
    const body = el('div', 'ch-body');
    body.append(el('div', 'ch-status'), el('ol', 'ch-lines'), el('div', 'ch-foot'));
    panel.append(head, body);
    makeDraggable(panel, head);
    document.body.appendChild(panel);
    syncAutoButton();
  }

  function makeDraggable(node, handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = node.getBoundingClientRect();
      const ox = e.clientX - r.left;
      const oy = e.clientY - r.top;
      const move = (ev) => {
        node.style.left = `${Math.max(0, ev.clientX - ox)}px`;
        node.style.top = `${Math.max(0, ev.clientY - oy)}px`;
        node.style.right = 'auto';
        node.style.bottom = 'auto';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  function setStatus(text) {
    ensurePanel();
    panel.querySelector('.ch-status').textContent = text;
    panel.querySelector('.ch-lines').replaceChildren();
    panel.querySelector('.ch-foot').textContent = '';
  }

  function renderPanel() {
    ensurePanel();
    const side = result.fen.split(' ')[1];
    const status = panel.querySelector('.ch-status');
    const list = panel.querySelector('.ch-lines');
    const foot = panel.querySelector('.ch-foot');

    if (!result.lines.length) {
      setStatus(result.bestmove === '(none)' ? 'Keine legalen Züge (Matt oder Patt)' : 'Keine Engine-Ausgabe');
      return;
    }

    status.textContent = `${side === 'w' ? 'Weiß' : 'Schwarz'} am Zug · Bewertung ${formatScore(result.lines[0].score, side)}`;
    list.replaceChildren(
      ...result.lines.map((line) => {
        const li = el('li');
        const dot = el('span', 'ch-dot');
        dot.style.background = ARROW_COLORS[line.multipv - 1] || ARROW_COLORS[ARROW_COLORS.length - 1];
        li.append(dot, el('span', 'ch-move', formatMove(result.fen, line.pv[0])), el('span', 'ch-score', formatScore(line.score, side)));
        return li;
      })
    );
    const depth = Math.max(...result.lines.map((l) => l.depth));
    const parts = [`Tiefe ${depth}`];
    if (settings.autoMove) parts.push('Auto-Zug');
    if (result.inaccurate) parts.push('Ungenauigkeit');
    if (result.source === 'dom') parts.push('Zugrecht geschätzt');
    foot.textContent = parts.join(' · ');
  }

  function hideAll() {
    cancelAutoMove();
    autoMovedFen = null;
    if (panel) panel.remove();
    panel = null;
    if (svg) svg.remove();
    drawnKey = null;
    lastKey = null;
    result = null;
  }

  // ---------- auto-move ----------

  function currentFen(board) {
    return apiFen || (board ? domFen(board) : null);
  }

  function cancelAutoMove() {
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
    if (pendingMove) {
      clearTimeout(pendingMove.fallbackTimer);
      pendingMove = null;
    }
  }

  function squareCenter(board, sq, flipped) {
    const rect = board.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const f = sq.charCodeAt(0) - 97;
    const r = Number(sq[1]) - 1;
    const col = flipped ? 7 - f : f;
    const row = flipped ? r : 7 - r;
    return {
      x: rect.left + ((col + 0.5) / 8) * rect.width,
      y: rect.top + ((row + 0.5) / 8) * rect.height,
    };
  }

  function dispatchPointer(target, type, x, y, buttons) {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
        buttons,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      })
    );
  }

  function domMakeMove(board, from, to, promotion, side) {
    const flipped = isFlipped(board);
    const p1 = squareCenter(board, from, flipped);
    const p2 = squareCenter(board, to, flipped);
    if (!p1 || !p2) return;

    const fromTarget = document.elementFromPoint(p1.x, p1.y) || board;
    dispatchPointer(fromTarget, 'pointerdown', p1.x, p1.y, 1);
    dispatchPointer(document, 'pointermove', p2.x, p2.y, 1);
    const toTarget = document.elementFromPoint(p2.x, p2.y) || board;
    dispatchPointer(toTarget, 'pointerup', p2.x, p2.y, 0);

    if (promotion) {
      setTimeout(() => {
        const promoBtn = board.querySelector(`.promotion-piece.${side}${promotion}`) ||
          document.querySelector(`.promotion-window .promotion-piece.${side}${promotion}`);
        if (promoBtn) promoBtn.click();
      }, 80);
    }
  }

  function shouldAutoMove(board, fen) {
    if (!settings.enabled || !settings.autoMove || !board || !fen || apiGameOver) return false;
    if (!result || result.fen !== fen || fen === autoMovedFen) return false;
    const side = fen.split(' ')[1];
    const mySide = apiPlayingAs || (isFlipped(board) ? 'b' : 'w');
    return side === mySide;
  }

  function pickAutoUci() {
    if (!result) return null;
    const uci = (result.lines[0] && result.lines[0].pv && result.lines[0].pv[0]) || result.bestmove;
    if (!uci || uci === '(none)' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
    return uci;
  }

  function executeAutoMove(expectedFen, uci) {
    autoTimer = null;
    const board = findBoard();
    if (!shouldAutoMove(board, expectedFen)) return;
    if (currentFen(board) !== expectedFen) return;

    autoMovedFen = expectedFen;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci[4] || undefined;
    const side = expectedFen.split(' ')[1];
    const moveId = ++moveSeq;

    const fallbackTimer = setTimeout(() => {
      if (!pendingMove || pendingMove.moveId !== moveId) return;
      const move = pendingMove;
      pendingMove = null;
      const b = findBoard();
      if (b && settings.enabled && settings.autoMove && currentFen(b) === move.expectedFen) {
        domMakeMove(b, move.from, move.to, move.promotion, move.side);
      }
    }, 150);

    pendingMove = { moveId, expectedFen, from, to, promotion, side, fallbackTimer };
    window.postMessage(
      { source: 'chess-helfer-content', type: 'make-move', moveId, from, to, promotion, expectedFen },
      window.location.origin
    );
  }

  function maybeAutoMove() {
    const board = findBoard();
    if (!result || !shouldAutoMove(board, result.fen)) return;
    const uci = pickAutoUci();
    if (!uci) return;

    cancelAutoMove();
    const expectedFen = result.fen;
    const delay = Math.max(0, Number(settings.autoMoveDelay) || 0);
    if (delay === 0) {
      executeAutoMove(expectedFen, uci);
    } else {
      autoTimer = setTimeout(() => executeAutoMove(expectedFen, uci), delay);
    }
  }

  // ---------- engine ----------

  async function analyze(fen, source) {
    const id = ++reqId;
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'analyze',
        id,
        fen,
        movetime: settings.movetime,
        multipv: settings.multipv,
        inaccuracyRate: settings.inaccuracyRate,
        maxLoss: settings.maxLoss,
      });
    } catch (e) {
      if (id === reqId) setStatus(`Engine-Fehler: ${e.message}`);
      return;
    }
    if (id !== reqId || !res || res.stale) return;
    if (res.error) {
      setStatus(`Engine-Fehler: ${res.error}`);
      return;
    }
    result = { id, fen, source, lines: res.lines || [], bestmove: res.bestmove, inaccurate: !!res.inaccurate };
    renderPanel();
    maybeAutoMove();
  }

  // ---------- main loop ----------

  function tick() {
    if (!chrome.runtime || !chrome.runtime.id) {
      // extension was reloaded/removed: shut down cleanly
      clearInterval(timer);
      hideAll();
      return;
    }
    const board = findBoard();
    if (!settings.enabled || !isAllowedPage() || !board) {
      hideAll();
      return;
    }

    let fen = apiFen;
    let source = 'api';
    if (!fen) {
      fen = domFen(board);
      source = 'dom';
    }
    if (!fen) {
      if (lastKey !== 'unreadable') {
        cancelAutoMove();
        lastKey = 'unreadable';
        result = null;
        clearArrows();
        setStatus('Stellung nicht lesbar');
      }
      return;
    }

    if (fen !== autoMovedFen) autoMovedFen = null;

    const key = `${fen}|${settings.movetime}|${settings.multipv}|${settings.inaccuracyRate}|${settings.maxLoss}`;
    if (key !== lastKey) {
      cancelAutoMove();
      lastKey = key;
      result = null;
      clearArrows();
      setStatus('Rechne …');
      analyze(fen, source);
    }
    if (result) drawArrows(board);
  }

  timer = setInterval(tick, 300);
})();
