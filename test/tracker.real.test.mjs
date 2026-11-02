// Deterministic degraded SYNTHETIC footage, not a real-video benchmark. No asset/file reads.
import { BoxTracker } from '../src/tracker.js';

const W = 640, H = 360, SIDE = 64, N = 120;
const failures = [];
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.ceil(a.length * p) - 1];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
function rng(seed) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
// Independent band-limited textures, with no symmetry or repeating tile inside the box.
function texture(seed, mean, contrast) {
  const r = rng(seed);
  const waves = Array.from({ length: 18 }, () => {
    const angle = r() * Math.PI * 2, freq = 0.06 + r() * 0.65;
    return [Math.cos(angle) * freq, Math.sin(angle) * freq, r() * Math.PI * 2];
  });
  return (x, y) => mean + contrast * waves.reduce((v, [a, b, c]) => v + Math.sin(x * a + y * b + c), 0) / 3;
}
const obj = texture(729, 135, 32), bg = texture(331, 100, 19), occ = texture(892, 125, 38);
const background = Float32Array.from({ length: W * H }, (_, i) => bg(i % W, Math.floor(i / W)));
const truth = t => [145 + 2.7 * t, 175 + 22 * Math.sin(t / 19)];
const hidden = i => i >= 48 && i < 56;
function render(i, mode) {
  const all = mode === 'combined';
  const blur = all || mode === 'blur', light = all || mode === 'exposure';
  const rotate = all || mode === 'rotation', blocks = all || mode === 'blocks';
  const cover = (all || mode === 'occluder') && hidden(i);
  const f = new Float32Array(background);
  const [cx, cy] = truth(i);
  const samples = blur ? 9 : 1;
  // Average sub-frame object positions across a 1.5-frame shutter, centred on ground truth.
  for (let y = Math.floor(cy - 50); y <= cy + 50; y++) for (let x = Math.floor(cx - 50); x <= cx + 50; x++) {
    let sum = 0;
    for (let k = 0; k < samples; k++) {
      const t = i + (samples === 1 ? 0 : (k / (samples - 1) - 0.5) * 1.5);
      const [tx, ty] = truth(t);
      const angle = rotate ? 25 * Math.sin(t / 65) * Math.PI / 180 : 0;
      const dx = x - tx, dy = y - ty;
      const u = Math.cos(angle) * dx + Math.sin(angle) * dy;
      const v = -Math.sin(angle) * dx + Math.cos(angle) * dy;
      sum += Math.abs(u) < SIDE / 2 && Math.abs(v) < SIDE / 2 ? obj(u, v) : background[y * W + x];
    }
    f[y * W + x] = sum / samples;
  }
  // An independently textured foreground panel moves 7 px/frame while fully covering the target for 8 frames.
  if (cover) {
    const left = cx - 65 + (i - 51.5) * 4.3;
    for (let y = 110; y < 245; y++) for (let x = Math.floor(left); x < left + 130; x++) f[y * W + x] = occ(x - left, y - 110);
  }
  const gain = light ? 0.65 + 0.7 * i / (N - 1) : 1;
  const offset = light && i >= 75 ? 38 : 0;
  const r = rng(4000 + i);
  const out = new Uint8Array(W * H);
  if (blocks) {
    // Strong block DC contamination, 24-level quantisation and independent +/-5 luma noise.
    for (let by = 0; by < H; by += 8) for (let bx = 0; bx < W; bx += 8) {
      let mean = 0;
      for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) mean += f[y * W + x] / 64;
      for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) {
        const p = y * W + x;
        out[p] = clamp(Math.round(((0.65 * f[p] + 0.35 * mean) * gain + offset) / 24) * 24 + (r() - 0.5) * 10);
      }
    }
  } else for (let p = 0; p < out.length; p++) out[p] = clamp(f[p] * gain + offset);
  return out;
}

// Error percentiles include every returned box (even during occlusion); nulls are counted separately.
// Coverage gates prevent a tracker that always returns null from passing accuracy checks.
for (const mode of ['blur', 'exposure', 'rotation', 'occluder', 'blocks', 'combined']) {
  const frames = Array.from({ length: N }, (_, i) => render(i, mode));
  const [cx, cy] = truth(0);
  const t = new BoxTracker(frames[0], W, H, { x: cx - SIDE / 2, y: cy - SIDE / 2, w: SIDE, h: SIDE });
  const errors = [], times = [];
  let lost = 0, visibleLost = 0, falseReacquisitions = 0, wasLost = false, hiddenTracked = 0, recovery = null;
  const hasOcclusion = mode === 'occluder' || mode === 'combined';
  for (let i = 1; i < N; i++) {
    const start = performance.now();
    const result = t.update(frames[i]);
    times.push(performance.now() - start);
    const missing = result.lost || !result.box;
    if (missing) { lost++; if (!(hasOcclusion && hidden(i))) visibleLost++; }
    else {
      const b = result.box, [x, y] = truth(i);
      const e = Math.hypot(b.x + b.w / 2 - x, b.y + b.h / 2 - y);
      errors.push(e);
      if (wasLost && e > SIDE) falseReacquisitions++;
      if (hasOcclusion && hidden(i)) hiddenTracked++;
      if (hasOcclusion && i >= 56 && recovery === null && e <= 6) recovery = i;
    }
    wasLost = missing;
  }
  const median = pct(errors, 0.5) ?? Infinity, p95 = pct(errors, 0.95) ?? Infinity;
  const ms = pct(times.slice(10), 0.5);
  console.log(JSON.stringify({ sequence: mode, medianPx: +median.toFixed(3), p95Px: +p95.toFixed(3), lost, visibleLost,
    falseReacquisitions, hiddenTracked, recovery, medianMs: +ms.toFixed(3) }));
  const medianLimit = mode === 'combined' ? 3 : 1;
  const p95Limit = mode === 'combined' ? 8 : 2;
  check(median <= medianLimit && p95 <= p95Limit, `${mode}: centre median <=${medianLimit} / p95 <=${p95Limit} px`);
  check(visibleLost <= (hasOcclusion ? 4 : 2), `${mode}: visible loss budget`);
  check(falseReacquisitions === 0, `${mode}: no false re-acquisitions`);
  if (hasOcclusion) {
    check(hiddenTracked === 0, `${mode}: all 8 hidden frames must be lost`);
    check(recovery !== null && recovery <= 60, `${mode}: recovery by frame 60`);
  }
  check(ms <= 8, `${mode}: median update <=8 ms at 640x360`);
}
for (const f of failures) console.error(`FAIL ${f}`);
console.log(failures.length ? `${failures.length} FAILED` : 'all passed');
process.exitCode = failures.length ? 1 : 0;

