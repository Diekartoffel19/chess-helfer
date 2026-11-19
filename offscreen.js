// Offscreen document: owns the Stockfish worker and answers one analysis
// request at a time. A newer request stops the running search; superseded
// requests are answered with { stale: true }.

const ENGINE_URL = 'engine/stockfish-19-lite-single.js';
const FEN_RE = /^[pnbrqkPNBRQK1-8/]+ [wb] (?:[KQkq]{1,4}|-) (?:[a-h][36]|-)(?: \d+ \d+)?$/;

let worker = null;
let ready = false;
let current = null; // { req, sendResponse, lines: Map, stale }
let pending = null; // { req, sendResponse }

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || lo));

function startEngine() {
  ready = false;
  worker = new Worker(ENGINE_URL);
  worker.onmessage = (e) => onLine(String(e.data));
  worker.onerror = (e) => {
    console.error('Stockfish error', e);
    if (current) {
      current.sendResponse({ id: current.req.id, error: 'Engine abgestürzt – starte neu' });
      current = null;
    }
    try {
      worker.terminate();
    } catch (_) {}
    startEngine();
  };
  worker.postMessage('uci');
}

function pump() {
  if (!ready || current || !pending) return;
  const req = pending.req;
  const requestedMultipv = clamp(req.multipv, 1, 5);
  const inaccuracyRate = clamp(req.inaccuracyRate, 0, 100);
  const maxLoss = clamp(req.maxLoss ?? 120, 10, 500);
  const rollInaccurate = inaccuracyRate > 0 && Math.random() * 100 < inaccuracyRate;
  const engineMultipv = rollInaccurate ? Math.max(requestedMultipv, 5) : requestedMultipv;

  current = {
    ...pending,
    requestedMultipv,
    rollInaccurate,
    maxLoss,
    lines: new Map(),
    stale: false,
  };
  pending = null;
  const { fen, movetime } = req;
  worker.postMessage(`setoption name MultiPV value ${engineMultipv}`);
  worker.postMessage(`position fen ${fen}`);
  worker.postMessage(`go movetime ${clamp(movetime, 100, 10000)}`);
}

function dedupeLines(rawLines) {
  const seen = new Set();
  const out = [];
  for (const line of rawLines) {
    const mv = line.pv && line.pv[0];
    if (!mv || seen.has(mv)) continue;
    seen.add(mv);
    out.push(line);
  }
  return out;
}

function moveLoss(bestScore, candScore) {
  if ('mate' in bestScore) {
    if (bestScore.mate > 0) {
      if ('mate' in candScore) {
        return candScore.mate > 0 ? Math.max(0, (candScore.mate - bestScore.mate) * 15) : Infinity;
      }
      return bestScore.mate > 1 && candScore.cp >= 300 ? 120 : Infinity;
    }
    return Infinity;
  }
  if ('mate' in candScore) {
    return candScore.mate > 0 ? 0 : Infinity;
  }
  return Math.max(0, bestScore.cp - candScore.cp);
}

function pickWeighted(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item.line;
  }
  return items[items.length - 1].line;
}

function applyInaccuracy(rawLines, requestedMultipv, rollInaccurate, maxLoss) {
  const unique = dedupeLines(rawLines);
  const renumber = (arr) => arr.slice(0, requestedMultipv).map((l, i) => ({ ...l, multipv: i + 1 }));
  if (!rollInaccurate || unique.length < 2) {
    return { lines: renumber(unique), inaccurate: false };
  }

  const best = unique[0];
  const candidates = unique
    .slice(1)
    .map((line, idx) => ({ line, loss: moveLoss(best.score, line.score), weight: Math.max(1, 4 - idx) }))
    .filter((c) => Number.isFinite(c.loss) && c.loss <= maxLoss);

  if (!candidates.length) {
    return { lines: renumber(unique), inaccurate: false };
  }

  const strictlyWorse = candidates.filter((c) => c.loss > 0);
  const chosen = pickWeighted(strictlyWorse.length ? strictlyWorse : candidates);
  const ordered = [chosen, ...unique.filter((l) => l !== chosen)];
  return { lines: renumber(ordered), inaccurate: true };
}

function parseInfo(line) {
  const t = line.split(/\s+/);
  const pvAt = t.indexOf('pv');
  const scoreAt = t.indexOf('score');
  if (pvAt < 0 || scoreAt < 0) return null;
  if (t.includes('lowerbound') || t.includes('upperbound')) return null;
  const get = (k) => {
    const i = t.indexOf(k);
    return i >= 0 ? t[i + 1] : undefined;
  };
  const kind = t[scoreAt + 1];
  const val = Number(t[scoreAt + 2]);
  return {
    multipv: Number(get('multipv') || 1),
    depth: Number(get('depth') || 0),
    score: kind === 'mate' ? { mate: val } : { cp: val },
    pv: t.slice(pvAt + 1),
  };
}

function onLine(line) {
  if (line === 'uciok') {
    worker.postMessage('isready');
    return;
  }
  if (line === 'readyok') {
    if (!ready) {
      ready = true;
      pump();
    }
    return;
  }
  if (!current) return;

  if (line.startsWith('info ')) {
    const info = parseInfo(line);
    if (info) current.lines.set(info.multipv, info);
  } else if (line.startsWith('bestmove')) {
    let bestmove = line.split(/\s+/)[1];
    const rawLines = [...current.lines.values()].sort((a, b) => a.multipv - b.multipv);
    const { lines, inaccurate } = applyInaccuracy(
      rawLines,
      current.requestedMultipv,
      current.rollInaccurate,
      current.maxLoss
    );
    if (inaccurate && lines[0]?.pv?.[0]) bestmove = lines[0].pv[0];
    current.sendResponse({ id: current.req.id, bestmove, lines, inaccurate, stale: current.stale });
    current = null;
    pump();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'analyze') return false;

  if (typeof msg.fen !== 'string' || !FEN_RE.test(msg.fen)) {
    sendResponse({ id: msg.id, error: 'Ungültige FEN' });
    return false;
  }

  if (pending) pending.sendResponse({ id: pending.req.id, stale: true });
  pending = { req: msg, sendResponse };

  if (current) {
    current.stale = true;
    worker.postMessage('stop');
  } else {
    pump();
  }
  return true;
});

startEngine();
