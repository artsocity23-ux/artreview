// Renderer side of tracking: decodes small gray frames with mediabunny and feeds them to a BoxTracker running in a
// module worker. Two passes away from the key frame (forward to the end, backward to frame 0), each with its own
// tracker. If module workers cannot start (file:// rules), the same tracker runs here in small async batches.
import { CanvasSink } from '../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs';

const LONG_SIDE = 640;
const CHUNK = 48; // backward pass: decode this many frames forward, then feed them in reverse
const WORKER_TIMEOUT = 15000;

const abortError = () => new DOMException('Трекінг зупинено', 'AbortError');
const yieldNow = () => new Promise(r => setTimeout(r, 0));

// BT.601 integer luma, the same formula as tracker.js toGray (kept here so the worker path never loads the maths twice).
function gray(rgba, n) {
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2] + 128) >> 8;
  return g;
}

// ---------- engines: the worker, or the main thread as a fallback ----------

let workerEngine = null; // Promise of an engine, shared by all tracks
let fallbackOnly = false;
let seq = 0;

function makeWorkerEngine() {
  const worker = new Worker(new URL('./track-worker.js', import.meta.url), { type: 'module' });
  const waiting = new Map(); // id -> { resolve, reject }
  let broken = null;
  const fail = err => {
    broken = err;
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
  };
  worker.onmessage = e => {
    const m = e.data || {};
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    w.resolve(m);
  };
  worker.onerror = e => {
    e.preventDefault?.();
    fail(new Error(`tracking worker failed: ${e.message || 'load error'}`));
  };
  worker.onmessageerror = () => fail(new Error('tracking worker message error'));
  return {
    kind: 'worker',
    get broken() { return broken; },
    start(id, g, width, height, box) {
      if (broken) throw broken;
      worker.postMessage({ type: 'start', id, gray: g, width, height, box }, [g.buffer]);
    },
    frame(id, g) {
      if (broken) return Promise.reject(broken);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!waiting.has(id)) return;
          // A worker that never answers is as good as dead (e.g. the module never loaded): fall back for good.
          fail(new Error('tracking worker timeout'));
        }, WORKER_TIMEOUT);
        waiting.set(id, {
          resolve: m => { clearTimeout(timer); resolve(m); },
          reject: err => { clearTimeout(timer); reject(err); },
        });
        worker.postMessage({ type: 'frame', id, gray: g }, [g.buffer]);
      });
    },
    stop(id) {
      if (!broken) worker.postMessage({ type: 'stop', id });
    },
  };
}

async function makeMainEngine() {
  const { BoxTracker } = await import('./tracker.js');
  const trackers = new Map();
  let count = 0;
  return {
    kind: 'main',
    start(id, g, width, height, box) {
      trackers.set(id, new BoxTracker(g, width, height, box));
    },
    async frame(id, g) {
      if (++count % 4 === 0) await yieldNow(); // small batches keep the UI breathing
      const t = trackers.get(id);
      return t ? { id, ...t.update(g) } : { id, box: null, quality: 0, lost: true };
    },
    stop(id) {
      trackers.delete(id);
    },
  };
}

async function engine() {
  if (fallbackOnly) return makeMainEngine();
  if (!workerEngine) {
    try {
      workerEngine = Promise.resolve(makeWorkerEngine());
    } catch (err) {
      window.ar?.log('tracking worker unavailable, using the main thread:', err.message);
      fallbackOnly = true;
      return makeMainEngine();
    }
  }
  const e = await workerEngine;
  if (e.broken) {
    fallbackOnly = true;
    return makeMainEngine();
  }
  return e;
}

// ---------- one direction ----------

// Runs a tracker from the key frame over `frames` (an async iterable of gray frames in feed order).
async function pass(eng, dir, keyGray, size, box, frames, fps, signal, step) {
  const id = `t${++seq}${dir}`;
  eng.start(id, keyGray.slice(), size.w, size.h, box);
  const out = [];
  const maxLost = Math.max(1, Math.round(2 * fps));
  let lostRun = 0;
  try {
    for await (const g of frames) {
      if (signal?.aborted) throw abortError();
      const r = await eng.frame(id, g);
      if (signal?.aborted) throw abortError();
      const b = !r.lost && r.box ? r.box : null;
      out.push(b ? [b.x / size.w, b.y / size.h, b.w / size.w, b.h / size.h, Math.round((r.quality ?? 0) * 1000) / 1000] : null);
      step();
      lostRun = b ? 0 : lostRun + 1;
      if (lostRun >= maxLost) break; // two seconds without the object: stop this direction
    }
  } finally {
    eng.stop(id);
  }
  return out;
}

/**
 * Tracks note.box from note.key forward to the last frame and backward to frame 0.
 * -> { from, to, boxes: [[x, y, w, h, q] | null, …] } (normalized), or throws AbortError.
 */
export async function trackNote(video, note, { onProgress, signal } = {}) {
  if (!note.box) throw new Error('У нотатки немає рамки для трекінгу');
  if (signal?.aborted) throw abortError();
  const s = Math.min(1, LONG_SIDE / Math.max(video.width, video.height));
  const size = { w: Math.max(16, Math.round(video.width * s)), h: Math.max(16, Math.round(video.height * s)) };
  const n = size.w * size.h;
  const sink = new CanvasSink(video.track, { width: size.w, height: size.h, fit: 'fill' });
  const canvas = Object.assign(document.createElement('canvas'), { width: size.w, height: size.h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const toGray = c => {
    ctx.drawImage(c, 0, 0, size.w, size.h);
    return gray(ctx.getImageData(0, 0, size.w, size.h).data, n);
  };
  const last = video.frameCount - 1;
  const key = Math.max(0, Math.min(last, note.key));
  const total = Math.max(1, last);
  let done = 0;
  const step = () => onProgress?.(Math.min(1, ++done / total));
  const box = { x: note.box.x * size.w, y: note.box.y * size.h, w: note.box.w * size.w, h: note.box.h * size.h };

  const keyCanvas = (await sink.getCanvas(video.time(key)))?.canvas;
  if (!keyCanvas) throw new Error('Не вдалося декодувати кадр');
  const keyGray = toGray(keyCanvas);
  const eng = await engine();

  async function* forwardFrames() {
    if (key >= last) return;
    const times = [];
    for (let f = key + 1; f <= last; f++) times.push(video.time(f));
    for await (const wc of sink.canvasesAtTimestamps(times)) {
      if (signal?.aborted) throw abortError();
      if (wc) yield toGray(wc.canvas);
    }
  }

  async function* backwardFrames() {
    for (let end = key - 1; end >= 0; end -= CHUNK) {
      const start = Math.max(0, end - CHUNK + 1);
      const times = [];
      for (let f = start; f <= end; f++) times.push(video.time(f));
      const chunk = [];
      for await (const wc of sink.canvasesAtTimestamps(times)) {
        if (signal?.aborted) throw abortError();
        if (wc) chunk.push(toGray(wc.canvas));
      }
      for (let i = chunk.length - 1; i >= 0; i--) yield chunk[i];
    }
  }

  let fwd;
  let bwd;
  try {
    fwd = await pass(eng, 'f', keyGray, size, box, forwardFrames(), video.fps, signal, step);
    bwd = await pass(eng, 'b', keyGray, size, box, backwardFrames(), video.fps, signal, step);
  } catch (err) {
    if (err?.name === 'AbortError' || eng.kind !== 'worker' || !eng.broken) throw err;
    // The worker died mid-track: do the whole note again on the main thread.
    fallbackOnly = true;
    window.ar?.log('tracking worker broke, retrying on the main thread:', err.message);
    return trackNote(video, note, { onProgress, signal });
  }
  onProgress?.(1);
  const k = note.box;
  const boxes = [...bwd.reverse(), [k.x, k.y, k.w, k.h, 1], ...fwd];
  return { from: key - bwd.length, to: key + fwd.length, boxes };
}

// Which engine tracking uses ('worker' or 'main'), for the self-test report.
export async function trackingEngine() {
  return (await engine()).kind;
}
