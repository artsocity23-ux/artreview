// Tracker test on synthetic footage: `node test/tracker.test.mjs`, exits 1 on failure.
// Every frame is rendered here from seeded noise (no files from disk): a textured square moving over a textured
// background, with sub-pixel positions, scale changes, sensor noise, an occluding flat block, and leaving the frame.
import { BoxTracker, buildPyramid, toGray } from '../src/tracker.js';

const W = 640;
const H = 360;
const SIDE = 60; // object side at scale 1
const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r) {
  const u = Math.max(1e-12, r());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

// Value noise: random values on a grid, bilinear in between, a few octaves; normalised to the given mean / std.
function valueNoise(seed, x0, y0, w, h, octaves, mean, std) {
  const r = rng(seed);
  const layers = octaves.map(([cell, amp]) => {
    const gw = Math.ceil(w / cell) + 2;
    const gh = Math.ceil(h / cell) + 2;
    const g = new Float32Array(gw * gh);
    for (let i = 0; i < g.length; i++) g[i] = r() * 2 - 1;
    return { cell, amp, gw, g };
  });
  const sample = (x, y) => {
    let v = 0;
    for (const { cell, amp, gw, g } of layers) {
      const gx = (x - x0) / cell;
      const gy = (y - y0) / cell;
      const ix = Math.floor(gx);
      const iy = Math.floor(gy);
      const fx = gx - ix;
      const fy = gy - iy;
      const p = iy * gw + ix;
      v += amp * ((g[p] * (1 - fx) + g[p + 1] * fx) * (1 - fy) + (g[p + gw] * (1 - fx) + g[p + gw + 1] * fx) * fy);
    }
    return v;
  };
  // Normalise on a sample grid so the contrast is what we asked for.
  let s = 0, s2 = 0, n = 0;
  for (let y = y0; y < y0 + h; y += 1.7) {
    for (let x = x0; x < x0 + w; x += 1.7) {
      const v = sample(x, y);
      s += v;
      s2 += v * v;
      n++;
    }
  }
  const m = s / n;
  const sd = Math.sqrt(Math.max(1e-9, s2 / n - m * m));
  return (x, y) => mean + ((sample(x, y) - m) / sd) * std;
}

const bgTex = valueNoise(11, -2, -2, W + 4, H + 4, [[14, 1], [5, 0.5]], 110, 28);
const background = new Float32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) background[y * W + x] = bgTex(x, y);
const objTex = valueNoise(29, -SIDE / 2 - 2, -SIDE / 2 - 2, SIDE + 4, SIDE + 4, [[9, 1], [3.5, 0.6]], 135, 45);

// One frame. st: { cx, cy, s, noise, blocks: [{ x, y, w, h, v }] }. The square is supersampled 3×3 so sub-pixel
// positions and scales show up as real partial-pixel coverage.
function render(st, seed) {
  const f = new Float32Array(background);
  const half = (SIDE / 2) * st.s;
  const xa = Math.max(0, Math.floor(st.cx - half - 1));
  const xb = Math.min(W - 1, Math.ceil(st.cx + half + 1));
  const ya = Math.max(0, Math.floor(st.cy - half - 1));
  const yb = Math.min(H - 1, Math.ceil(st.cy + half + 1));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      let acc = 0, cov = 0;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const u = (x + i / 3 - st.cx) / st.s;
          const v = (y + j / 3 - st.cy) / st.s;
          if (Math.abs(u) < SIDE / 2 && Math.abs(v) < SIDE / 2) {
            acc += objTex(u, v);
            cov++;
          }
        }
      }
      if (cov) f[y * W + x] = (acc + (9 - cov) * f[y * W + x]) / 9;
    }
  }
  for (const b of st.blocks || []) {
    for (let y = Math.max(0, Math.floor(b.y)); y < Math.min(H, b.y + b.h); y++) {
      for (let x = Math.max(0, Math.floor(b.x)); x < Math.min(W, b.x + b.w); x++) f[y * W + x] = b.v;
    }
  }
  const r = rng(seed * 7919 + 1);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) {
    const v = f[i] + (st.noise ? gauss(r) * st.noise : 0);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  return out;
}

const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)];
};
const fmt = v => (Number.isFinite(v) ? v.toFixed(2) : String(v));
const times = [];

// Runs one sequence; frames[i] = state. Returns per-frame results with the error against the truth.
// loose: the drawn box is this much bigger than the object (people draw boxes with some background in them).
function run(name, frames, seed, loose = 1) {
  const st0 = frames[0];
  const half = (SIDE / 2) * st0.s * loose;
  const tracker = new BoxTracker(render(st0, seed), W, H, { x: st0.cx - half, y: st0.cy - half, w: 2 * half, h: 2 * half });
  const res = [null];
  for (let i = 1; i < frames.length; i++) {
    const g = render(frames[i], seed + i);
    const t0 = performance.now();
    const r = tracker.update(g);
    times.push(performance.now() - t0);
    const st = frames[i];
    let err = Infinity, sizeErr = NaN;
    if (r.box) {
      err = Math.hypot(r.box.x + r.box.w / 2 - st.cx, r.box.y + r.box.h / 2 - st.cy);
      sizeErr = Math.abs(r.box.w / (SIDE * st.s * loose) - 1);
    }
    res.push({ ...r, err, sizeErr });
  }
  return res;
}

function stats(name, res, evalFrames) {
  const errs = evalFrames.map(i => res[i].err);
  const med = pct(errs, 50);
  const p95 = pct(errs, 95);
  const sizes = evalFrames.map(i => res[i].sizeErr).filter(Number.isFinite);
  const lostN = evalFrames.filter(i => res[i].lost).length;
  console.log(
    `     ${name}: ${evalFrames.length} frames, centre error median ${fmt(med)} px, p95 ${fmt(p95)} px, ` +
      `max ${fmt(Math.max(...errs))} px, size error median ${fmt(100 * pct(sizes, 50))}%, lost ${lostN}`,
  );
  check(med <= 2, `${name}: median centre error ${fmt(med)} <= 2 px`);
  check(p95 <= 4, `${name}: p95 centre error ${fmt(p95)} <= 4 px`);
  return errs;
}

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const seq = (n, fn) => Array.from({ length: n }, (_, i) => ({ s: 1, noise: 2, blocks: [], ...fn(i) }));
const allErrs = [];

// --- basics -------------------------------------------------------------------------------------------------------
{
  const rgba = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255]);
  const g = toGray(rgba, 3, 2);
  const want = [255, 0, 77, 149, 29, Math.round((77 * 10 + 150 * 20 + 29 * 30) / 256)];
  check([...g].every((v, i) => Math.abs(v - want[i]) <= 1) && g[0] === 255 && g[1] === 0, `toGray BT.601: ${[...g]}`);
  const flat = new Uint8Array(37 * 23).fill(90);
  const pyr = buildPyramid(flat, 37, 23);
  check(
    pyr.length === 3 && pyr[1].width === 19 && pyr[1].height === 12 && pyr[2].width === 10 && pyr[2].height === 6,
    `buildPyramid sizes ${pyr.map(l => `${l.width}x${l.height}`).join(' ')}`,
  );
  check(pyr.every(l => l.data instanceof Float32Array && l.data.every(v => Math.abs(v - 90) < 1e-4)), 'buildPyramid keeps a flat image flat');
}

// --- translation: smooth path, 2–5 px/frame, sub-pixel positions -----------------------------------------------------
{
  const fr = seq(120, i => ({ cx: 140 + 3 * i + 25 * Math.sin(i / 9), cy: 180 + 70 * Math.sin((2 * Math.PI * i) / 70) }));
  const res = run('translation', fr, 100);
  allErrs.push(...stats('translation', res, range(1, 119)));
}

// --- fast: up to 12 px/frame, back and forth --------------------------------------------------------------------------
{
  const A = 240;
  const w = 12 / A; // peak speed A * w = 12 px/frame
  const fr = seq(110, i => ({ cx: 320 + A * Math.sin(w * i), cy: 180 + 40 * Math.sin(i / 13) }));
  const peak = Math.max(...fr.slice(1).map((f, i) => Math.hypot(f.cx - fr[i].cx, f.cy - fr[i].cy)));
  console.log(`     fast: peak speed ${peak.toFixed(1)} px/frame`);
  const res = run('fast', fr, 200);
  allErrs.push(...stats('fast', res, range(1, 109)));
}

// --- scale 0.9 … 1.15 with slow motion -------------------------------------------------------------------------------
{
  const fr = seq(130, i => ({
    cx: 300 + 1.2 * i,
    cy: 170 + 20 * Math.sin(i / 20),
    s: 1.025 + 0.125 * Math.sin((2 * Math.PI * i) / 90),
  }));
  const res = run('scale', fr, 300);
  allErrs.push(...stats('scale', res, range(1, 129)));
}

// --- loose box: drawn 1.4× the object, so a third of the grid sits on the static background -------------------------
{
  const fr = seq(120, i => ({
    cx: 160 + 2.8 * i,
    cy: 180 + 60 * Math.sin((2 * Math.PI * i) / 80),
    s: 1 + 0.08 * Math.sin(i / 20),
  }));
  const res = run('loose box', fr, 350, 1.4);
  allErrs.push(...stats('loose box', res, range(1, 119)));
}

// --- sub-pixel creep: 0.27 px/frame, no visible jumps --------------------------------------------------------------
{
  const fr = seq(100, i => ({ cx: 250.3 + 0.27 * i, cy: 160.6 + 0.13 * i }));
  const res = run('subpixel', fr, 400);
  allErrs.push(...stats('subpixel', res, range(1, 99)));
}

// --- heavy noise (σ = 8) with motion and scale -----------------------------------------------------------------------
{
  const fr = seq(110, i => ({
    cx: 180 + 2.5 * i,
    cy: 190 + 50 * Math.sin(i / 15),
    s: 1 + 0.1 * Math.sin(i / 25),
    noise: 8,
  }));
  const res = run('noise σ8', fr, 500);
  allErrs.push(...stats('noise σ8', res, range(1, 109)));
}

// --- full occlusion: a flat block hides the object on frames 40–45, it must be lost there and found by frame 48 -----
{
  const path = i => ({ cx: 150 + 3 * i, cy: 160 + 0.8 * i });
  const occ = range(40, 45);
  const xs = occ.map(i => path(i).cx);
  const ys = occ.map(i => path(i).cy);
  const block = { x: Math.min(...xs) - 40, y: Math.min(...ys) - 40, w: Math.max(...xs) - Math.min(...xs) + 80, h: Math.max(...ys) - Math.min(...ys) + 80, v: 100 };
  const fr = seq(110, i => ({ ...path(i), blocks: occ.includes(i) ? [block] : [] }));
  const res = run('occlusion', fr, 600);
  const lostOn = occ.filter(i => res[i].lost).length;
  check(lostOn === 6, `occlusion: reported lost on ${lostOn}/6 hidden frames`);
  const back = range(46, 48).find(i => !res[i].lost && res[i].err <= 4);
  check(back !== undefined, `occlusion: re-acquired at frame ${back} (reappears at 46, must be <= 48)`);
  console.log(`     occlusion: frames 46..48 -> ${range(46, 48).map(i => (res[i].lost ? 'lost' : fmt(res[i].err))).join(', ')}`);
  allErrs.push(...stats('occlusion (visible frames)', res, [...range(1, 39), ...range(49, 109)]));
}

// --- partial occlusion: a static flat pole covers ~40% of the object for 6 frames ----------------------------------
{
  const path = i => ({ cx: 220 + 3 * i, cy: 200 - 0.5 * i });
  const p = path(40);
  const pole = { x: p.cx - 30 - 4, y: p.cy - 60, w: 28, h: 120, v: 70 };
  const occ = range(40, 45);
  const fr = seq(100, i => ({ ...path(i), blocks: occ.includes(i) ? [pole] : [] }));
  const res = run('partial occlusion', fr, 700);
  console.log(`     partial occlusion: frames 40..48 -> ${range(40, 48).map(i => (res[i].lost ? 'lost' : fmt(res[i].err))).join(', ')}`);
  const back = range(46, 48).find(i => !res[i].lost && res[i].err <= 4);
  check(back !== undefined, `partial occlusion: tracking at frame ${back} (pole gone at 46, must be <= 48)`);
  allErrs.push(...stats('partial occlusion (outside the 6 frames)', res, [...range(1, 39), ...range(49, 99)]));
}

// --- leaving the frame: must go lost, never drift onto the background ------------------------------------------------
{
  const fr = seq(70, i => ({ cx: 470 + 5.5 * i, cy: 190 + 0.7 * i }));
  const res = run('leave', fr, 800);
  const inside = range(1, 69).filter(i => fr[i].cx + SIDE / 2 < W - 1);
  const gone = range(1, 69).filter(i => fr[i].cx > W - 1 + 3);
  const partial = range(1, 69).filter(i => !inside.includes(i) && !gone.includes(i));
  const wrongGone = gone.filter(i => !res[i].lost);
  check(gone.length > 20 && wrongGone.length === 0, `leave: lost on ${gone.length - wrongGone.length}/${gone.length} frames after the centre left`);
  const partialBad = partial.filter(i => !res[i].lost && res[i].err > 6);
  console.log(`     leave: half-out frames ${partial.map(i => (res[i].lost ? 'lost' : fmt(res[i].err))).join(', ')}`);
  check(partialBad.length === 0, `leave: no drift while leaving (${partialBad.length} half-out frames off by > 6 px)`);
  allErrs.push(...stats('leave (fully inside)', res, inside));
}

// --- pooled + timing --------------------------------------------------------------------------------------------------
{
  const med = pct(allErrs, 50);
  const p95 = pct(allErrs, 95);
  console.log(`     all sequences: ${allErrs.length} frames, median ${fmt(med)} px, p95 ${fmt(p95)} px`);
  check(med <= 2 && p95 <= 4, `all sequences: median ${fmt(med)} <= 2, p95 ${fmt(p95)} <= 4`);
  // A clean timing pass after everything above warmed up the JIT.
  const fr = seq(80, i => ({ cx: 160 + 4 * i, cy: 180 + 40 * Math.sin(i / 10) }));
  const grays = fr.map((st, i) => render(st, 900 + i));
  const t = new BoxTracker(grays[0], W, H, { x: fr[0].cx - 30, y: fr[0].cy - 30, w: 60, h: 60 });
  const tt = [];
  for (let i = 1; i < grays.length; i++) {
    const t0 = performance.now();
    t.update(grays[i]);
    tt.push(performance.now() - t0);
  }
  const lostTimes = [];
  const tl = new BoxTracker(grays[0], W, H, { x: 20, y: 20, w: 60, h: 60 });
  for (let i = 1; i < 30; i++) {
    const t0 = performance.now();
    tl.update(new Uint8Array(W * H).fill(100)); // flat frames: lost, searching every frame
    lostTimes.push(performance.now() - t0);
  }
  console.log(
    `     time per frame at ${W}x${H}: tracking median ${fmt(pct(tt, 50))} ms, p95 ${fmt(pct(tt, 95))} ms; ` +
      `lost+searching median ${fmt(pct(lostTimes, 50))} ms; over all test frames median ${fmt(pct(times, 50))} ms`,
  );
  check(pct(tt, 50) <= 8, `time per frame median ${fmt(pct(tt, 50))} ms <= 8 ms`);
}

// --- worker protocol (module worker shimmed with a fake `self`) ------------------------------------------------------
{
  const sent = [];
  globalThis.self = { postMessage: m => sent.push(m) };
  await import('../src/track-worker.js');
  const fr = seq(6, i => ({ cx: 300 + 4 * i, cy: 180 }));
  const g0 = render(fr[0], 1000);
  self.onmessage({ data: { type: 'start', id: 'a', gray: g0.buffer, width: W, height: H, box: { x: 270, y: 150, w: 60, h: 60 } } });
  for (let i = 1; i < 6; i++) self.onmessage({ data: { type: 'frame', id: 'a', gray: render(fr[i], 1000 + i) } });
  const last = sent[sent.length - 1];
  check(
    sent.length === 5 && sent.every(m => m.type === 'result' && m.id === 'a' && !m.lost && m.box && m.quality > 0.5) &&
      Math.abs(last.box.x + last.box.w / 2 - fr[5].cx) < 1,
    `worker: 5 results for 5 frames, last centre x ${last && last.box ? fmt(last.box.x + last.box.w / 2) : '-'} (true ${fr[5].cx})`,
  );
  self.onmessage({ data: { type: 'stop', id: 'a' } });
  self.onmessage({ data: { type: 'frame', id: 'a', gray: g0 } });
  const after = sent[sent.length - 1];
  check(sent.length === 6 && after.lost && after.box === null, 'worker: a frame after stop answers lost, never hangs');
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
