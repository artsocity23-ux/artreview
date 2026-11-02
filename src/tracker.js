// Object tracking for ArtReview: pyramidal Lucas–Kanade "median flow" with a forward–backward check, plus an NCC
// template search that finds the object again after it was hidden. Pure math on gray frames (no DOM, no imports), so
// the same code runs in the tracking worker and in plain node for the tests.
//
// Coordinates: pixel centres sit on integers. Pyramid level L samples level 0 at even pixels, so a point (x, y) on
// level 0 is exactly (x / 2^L, y / 2^L) on level L.

const DEFAULTS = {
  levels: 3, // pyramid levels for LK
  grid: 10, // grid × grid points inside the box
  inset: 0.1, // grid inset from the box edge (fraction of the box)
  half: 7, // LK window half-size (15×15)
  iters: 20, // LK iterations per level
  eps: 0.03, // LK stop when the step is shorter than this (pixels of the level)
  minEig: 0.05, // LK: smallest eigenvalue of the gradient matrix per window pixel; below = flat, untrackable
  nccHalf: 5, // 11×11 patches for the point check
  minPointNcc: 0.3, // a point whose patch no longer looks like itself is not a candidate at all
  minPoints: 8, // fewer kept points than this = lost
  maxFB: 8, // median forward–backward error above this = lost
  scaleMin: 0.8, // per-frame scale clamp
  scaleMax: 1.25,
  minVisible: 0.5, // box more than half outside the frame = lost
  goodQuality: 0.6, // frames at least this good refresh the "last good" template
  searchSize: 20, // coarse search: template long side in pixels
  refineSize: 48, // fine search: template long side in pixels
  searchSpan: 1.5, // search the centre within ±1.5 box sizes of the last good position (a window 3× the box)
  reacquire: 0.65, // coarse NCC needed to consider a place at all
  reacquireFine: 0.8, // NCC at the fine size needed to take the object back
  ambiguity: 0.1, // the best coarse place must beat the best place elsewhere by this much
  confirm: 2, // consecutive frames that must agree on the place before the object counts as found again
  appSize: 24, // appearance check: samples along the box's long side
  minAppearance: 0.5, // a followed box that looks less like the object than this is not the object (lost)
  goodAppearance: 0.7, // and the "last good" template is refreshed only from boxes that look at least this alike
  minBox: 4,
};

// BT.601 luma in integers: 77 + 150 + 29 = 256, so white stays 255.
export function toGray(rgba, width, height) {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2] + 128) >> 8;
  return out;
}

export function buildPyramid(gray, width, height, levels = 3) {
  const pyr = allocPyramid(width, height, levels);
  fillPyramid(gray, pyr);
  return pyr;
}

function allocPyramid(width, height, levels) {
  const pyr = [];
  for (let l = 0, w = width, h = height; l < levels; l++, w = (w + 1) >> 1, h = (h + 1) >> 1) {
    pyr.push({ data: new Float32Array(w * h), width: w, height: h });
  }
  return pyr;
}

function fillPyramid(gray, pyr) {
  const base = pyr[0].data;
  base.set(gray.length === base.length ? gray : gray.subarray(0, base.length));
  for (let l = 1; l < pyr.length; l++) halve(pyr[l - 1], pyr[l]);
}

// [1 2 1]² / 16 blur sampled at even pixels: cheap, and keeps the "x / 2" coordinate rule exact. Interior pixels go
// through a branch-free loop; the border rows and columns clamp.
function halve({ data: a, width: w, height: h }, { data: out, width: w2, height: h2 }) {
  const at = (x, y) => a[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)];
  const slow = (i, j) => {
    const x = 2 * i;
    const y = 2 * j;
    const row = yy => at(x - 1, yy) + 2 * at(x, yy) + at(x + 1, yy);
    out[j * w2 + i] = (row(y - 1) + 2 * row(y) + row(y + 1)) * 0.0625;
  };
  const iEnd = (w - 2) >> 1; // last i with 2i + 1 <= w - 1
  const jEnd = (h - 2) >> 1;
  for (let j = 0; j < h2; j++) {
    if (j < 1 || j > jEnd) {
      for (let i = 0; i < w2; i++) slow(i, j);
      continue;
    }
    slow(0, j);
    const o = j * w2;
    let c = 2 * j * w + 2;
    for (let i = 1; i <= iEnd; i++, c += 2) {
      const u = c - w;
      const d = c + w;
      out[o + i] =
        (a[u - 1] + 2 * a[u] + a[u + 1] + 2 * (a[c - 1] + 2 * a[c] + a[c + 1]) + a[d - 1] + 2 * a[d] + a[d + 1]) * 0.0625;
    }
    for (let i = iEnd + 1; i < w2; i++) slow(i, j);
  }
}

// A copy of the pyramid around a box (+ a small margin), so a template does not keep a whole frame alive.
function cropPyramid(pyr, box) {
  return pyr.map((lv, L) => {
    const k = 1 / (1 << L);
    const x0 = Math.min(lv.width - 1, Math.max(0, Math.floor(box.x * k) - 2));
    const y0 = Math.min(lv.height - 1, Math.max(0, Math.floor(box.y * k) - 2));
    const x1 = Math.max(x0, Math.min(lv.width - 1, Math.ceil((box.x + box.w) * k) + 2));
    const y1 = Math.max(y0, Math.min(lv.height - 1, Math.ceil((box.y + box.h) * k) + 2));
    const cw = x1 - x0 + 1;
    const ch = y1 - y0 + 1;
    const data = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) data.set(lv.data.subarray((y0 + y) * lv.width + x0, (y0 + y) * lv.width + x0 + cw), y * cw);
    return { data, width: cw, height: ch, ox: x0, oy: y0 };
  });
}

// nw × nh bilinear samples with their top-left at (x0, y0). All samples share one sub-pixel offset, so the four
// weights are computed once; the edge-clamped path only runs for windows that touch the border.
function fillWindow(d, W, H, x0, y0, nw, nh, out) {
  const ix = Math.floor(x0);
  const iy = Math.floor(y0);
  const fx = x0 - ix;
  const fy = y0 - iy;
  const a = (1 - fx) * (1 - fy);
  const b = fx * (1 - fy);
  const c = (1 - fx) * fy;
  const e = fx * fy;
  let k = 0;
  if (ix >= 0 && iy >= 0 && ix + nw < W && iy + nh < H) {
    for (let r = 0; r < nh; r++) {
      let p = (iy + r) * W + ix;
      for (let col = 0; col < nw; col++, p++) out[k++] = a * d[p] + b * d[p + 1] + c * d[p + W] + e * d[p + W + 1];
    }
    return;
  }
  for (let r = 0; r < nh; r++) {
    const y = iy + r;
    const r0 = (y < 0 ? 0 : y >= H ? H - 1 : y) * W;
    const r1 = (y + 1 < 0 ? 0 : y + 1 >= H ? H - 1 : y + 1) * W;
    for (let col = 0; col < nw; col++) {
      const x = ix + col;
      const x0c = x < 0 ? 0 : x >= W ? W - 1 : x;
      const x1c = x + 1 < 0 ? 0 : x + 1 >= W ? W - 1 : x + 1;
      out[k++] = a * d[r0 + x0c] + b * d[r0 + x1c] + c * d[r1 + x0c] + e * d[r1 + x1c];
    }
  }
}

// Bilinear samples on an arbitrary grid (used by the template search, where the spacing is not 1).
function sampleGrid(lv, x0, y0, sx, sy, nw, nh, out) {
  const { data: d, width: W, height: H } = lv;
  // Cropped levels carry their offset in the full level.
  x0 -= lv.ox || 0;
  y0 -= lv.oy || 0;
  let k = 0;
  for (let r = 0; r < nh; r++) {
    let y = y0 + r * sy;
    y = y < 0 ? 0 : y > H - 1 ? H - 1 : y;
    const iy = Math.min(Math.floor(y), H - 2 < 0 ? 0 : H - 2);
    const fy = y - iy;
    const r0 = iy * W;
    const r1 = Math.min(iy + 1, H - 1) * W;
    for (let col = 0; col < nw; col++) {
      let x = x0 + col * sx;
      x = x < 0 ? 0 : x > W - 1 ? W - 1 : x;
      const ix = Math.min(Math.floor(x), W - 2 < 0 ? 0 : W - 2);
      const fx = x - ix;
      const ix1 = Math.min(ix + 1, W - 1);
      const top = d[r0 + ix] + (d[r0 + ix1] - d[r0 + ix]) * fx;
      const bot = d[r1 + ix] + (d[r1 + ix1] - d[r1 + ix]) * fx;
      out[k++] = top + (bot - top) * fy;
    }
  }
}

function median(src, n, tmp) {
  if (n === 0) return NaN;
  const a = tmp.subarray(0, n);
  for (let i = 0; i < n; i++) a[i] = src[i];
  a.sort();
  return n & 1 ? a[n >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}

export class BoxTracker {
  // gray: Uint8Array of the frame where the box was drawn; box in PIXELS of that gray frame
  constructor(gray, width, height, box, opts = {}) {
    const o = (this.o = { ...DEFAULTS, ...opts });
    this.width = width;
    this.height = height;
    // Two frame pyramids used in turn (previous, current): no per-frame allocation of whole frames.
    this.prev = buildPyramid(gray, width, height, o.levels);
    this.spare = allocPyramid(width, height, o.levels);
    this.box = { x: +box.x, y: +box.y, w: Math.max(o.minBox, +box.w), h: Math.max(o.minBox, +box.h) };
    // Templates for re-detection: the key frame (never drifts) and the last frame we trusted (looks most current).
    // Appearance grid: the box's aspect never changes (scale is uniform), so its shape is fixed at the start.
    const a = this.box.w / this.box.h;
    this.aw = Math.max(4, Math.round(a >= 1 ? o.appSize : o.appSize * a));
    this.ah = Math.max(4, Math.round(a >= 1 ? o.appSize / a : o.appSize));
    this.key = { pyr: cropPyramid(this.prev, this.box), box: { ...this.box }, look: this._look(this.prev, this.box) };
    this.good = this.key;
    this.lost = false;
    this.pending = null; // re-detection candidate waiting for confirmation: { x, y, n }
    this.vx = 0; // last centre motion, the LK starting guess (fast objects stay inside the pyramid's reach)
    this.vy = 0;
    const N = o.grid * o.grid;
    const n = 2 * o.half + 1;
    const m = n + 2;
    const q = 2 * o.nccHalf + 1;
    this.s = {
      S: new Float32Array(m * m), T: new Float32Array(n * n), J: new Float32Array(n * n),
      IX: new Float32Array(n * n), IY: new Float32Array(n * n),
      A: new Float32Array(q * q), B: new Float32Array(q * q),
      px: new Float64Array(N), py: new Float64Array(N), qx: new Float64Array(N), qy: new Float64Array(N),
      fb: new Float64Array(N), ncc: new Float64Array(N),
      ox: new Float64Array(N), oy: new Float64Array(N), tmp: new Float64Array(Math.max(N, (N * (N - 1)) / 2)),
      pairs: new Float64Array((N * (N - 1)) / 2),
    };
    this.rx = 0; // LK result
    this.ry = 0;
  }

  // next frame (in either direction — the caller feeds frames in order away from the key frame)
  update(gray) {
    const Q = this.spare;
    fillPyramid(gray, Q);
    const r = this.lost ? this._redetect(Q) : this._flow(Q);
    this.spare = this.prev;
    this.prev = Q;
    return r;
  }

  // Pyramidal LK (Bouguet) of one point from pyramid P to pyramid Q, starting from guess (gx, gy). Result in rx, ry.
  _lk(P, Q, x, y, gx, gy) {
    const o = this.o;
    const { S, T, J, IX, IY } = this.s;
    const h = o.half;
    const n = 2 * h + 1;
    const m = n + 2;
    const nn = n * n;
    const top = P.length - 1;
    let vx = gx / (1 << top);
    let vy = gy / (1 << top);
    const eps2 = o.eps * o.eps;
    for (let L = top; L >= 0; L--) {
      const k = 1 / (1 << L);
      const A = P[L];
      const B = Q[L];
      const px = x * k;
      const py = y * k;
      // Template and its gradients come from P only, so they are computed once per level (inverse formulation).
      fillWindow(A.data, A.width, A.height, px - h - 1, py - h - 1, m, m, S);
      let gxx = 0, gxy = 0, gyy = 0;
      for (let r = 0, t = 0; r < n; r++) {
        let i = (r + 1) * m + 1;
        for (let c = 0; c < n; c++, i++, t++) {
          const ix = (S[i + 1] - S[i - 1]) * 0.5;
          const iy = (S[i + m] - S[i - m]) * 0.5;
          IX[t] = ix;
          IY[t] = iy;
          T[t] = S[i];
          gxx += ix * ix;
          gxy += ix * iy;
          gyy += iy * iy;
        }
      }
      const det = gxx * gyy - gxy * gxy;
      const minEig = (gxx + gyy - Math.sqrt((gxx - gyy) * (gxx - gyy) + 4 * gxy * gxy)) / (2 * nn);
      if (minEig < o.minEig || det <= 0) return false;
      const iDet = 1 / det;
      for (let it = 0; it < o.iters; it++) {
        const qx = px + vx;
        const qy = py + vy;
        const BW = B.width;
        if (qx < -h || qy < -h || qx > BW - 1 + h || qy > B.height - 1 + h) return false;
        let bx = 0, by = 0;
        const jx = Math.floor(qx - h);
        const jy = Math.floor(qy - h);
        if (jx >= 0 && jy >= 0 && jx + n < BW && jy + n < B.height) {
          // Hot loop: bilinear sample and accumulate in one pass, each source pixel read once per row pair.
          const d = B.data;
          const fx = qx - h - jx;
          const fy = qy - h - jy;
          const w00 = (1 - fx) * (1 - fy);
          const w10 = fx * (1 - fy);
          const w01 = (1 - fx) * fy;
          const w11 = fx * fy;
          for (let r = 0, t = 0; r < n; r++) {
            let p = (jy + r) * BW + jx;
            let t0 = d[p];
            let b0 = d[p + BW];
            for (let c = 0; c < n; c++, t++) {
              p++;
              const t1 = d[p];
              const b1 = d[p + BW];
              const diff = T[t] - (w00 * t0 + w10 * t1 + w01 * b0 + w11 * b1);
              bx += diff * IX[t];
              by += diff * IY[t];
              t0 = t1;
              b0 = b1;
            }
          }
        } else {
          fillWindow(B.data, BW, B.height, qx - h, qy - h, n, n, J);
          for (let t = 0; t < nn; t++) {
            const diff = T[t] - J[t];
            bx += diff * IX[t];
            by += diff * IY[t];
          }
        }
        const dx = (gyy * bx - gxy * by) * iDet;
        const dy = (gxx * by - gxy * bx) * iDet;
        vx += dx;
        vy += dy;
        if (dx * dx + dy * dy < eps2) break;
      }
      if (L > 0) {
        vx *= 2;
        vy *= 2;
      }
    }
    this.rx = x + vx;
    this.ry = y + vy;
    return this.rx >= 0 && this.ry >= 0 && this.rx <= this.width - 1 && this.ry <= this.height - 1;
  }

  _patchNcc(A, ax, ay, B, bx, by) {
    const h = this.o.nccHalf;
    const q = 2 * h + 1;
    const { A: pa, B: pb } = this.s;
    fillWindow(A.data, A.width, A.height, ax - h, ay - h, q, q, pa);
    fillWindow(B.data, B.width, B.height, bx - h, by - h, q, q, pb);
    return ncc(pa, pb, q * q);
  }

  _flow(Q) {
    const o = this.o;
    const s = this.s;
    const P = this.prev;
    const b = this.box;
    const W = this.width;
    const H = this.height;
    const g = o.grid;
    const span = 1 - 2 * o.inset;
    let nv = 0;
    for (let j = 0; j < g; j++) {
      const y = b.y + b.h * (o.inset + (span * j) / (g - 1));
      for (let i = 0; i < g; i++) {
        const x = b.x + b.w * (o.inset + (span * i) / (g - 1));
        if (x < 0 || y < 0 || x > W - 1 || y > H - 1) continue;
        if (!this._lk(P, Q, x, y, this.vx, this.vy)) continue;
        const fx = this.rx;
        const fy = this.ry;
        // Track back from where the point landed; a real match comes home, a confused one does not.
        if (!this._lk(Q, P, fx, fy, x - fx, y - fy)) continue;
        const fb = Math.hypot(this.rx - x, this.ry - y);
        const c = this._patchNcc(P[0], x, y, Q[0], fx, fy);
        if (!(c >= o.minPointNcc)) continue;
        s.px[nv] = x;
        s.py[nv] = y;
        s.qx[nv] = fx;
        s.qy[nv] = fy;
        s.fb[nv] = fb;
        s.ncc[nv] = c;
        nv++;
      }
    }
    const total = g * g;
    if (nv < o.minPoints) return this._lose(Q);
    const medFB = median(s.fb, nv, s.tmp);
    const medNcc = median(s.ncc, nv, s.tmp);
    if (medFB > o.maxFB) return this._lose(Q);
    let nk = 0;
    for (let i = 0; i < nv; i++) {
      if (s.fb[i] <= medFB && s.ncc[i] >= medNcc) {
        s.px[nk] = s.px[i];
        s.py[nk] = s.py[i];
        s.qx[nk] = s.qx[i];
        s.qy[nk] = s.qy[i];
        nk++;
      }
    }
    if (nk < o.minPoints) return this._lose(Q);
    // Scale = median ratio of pairwise distances after / before.
    let np = 0;
    for (let i = 0; i < nk; i++) {
      for (let k = i + 1; k < nk; k++) {
        const d0 = Math.hypot(s.px[k] - s.px[i], s.py[k] - s.py[i]);
        if (d0 < 2) continue;
        s.pairs[np++] = Math.hypot(s.qx[k] - s.qx[i], s.qy[k] - s.qy[i]) / d0;
      }
    }
    let sc = np ? median(s.pairs, np, s.tmp) : 1;
    sc = Math.min(o.scaleMax, Math.max(o.scaleMin, sc));
    // Centre motion = median over points of where each one says the centre went, with the scale taken out first:
    // a plain median dx is biased whenever the kept points are not symmetric around the centre of a growing box.
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    for (let i = 0; i < nk; i++) {
      s.ox[i] = s.qx[i] - sc * (s.px[i] - cx) - cx;
      s.oy[i] = s.qy[i] - sc * (s.py[i] - cy) - cy;
    }
    const dx = median(s.ox, nk, s.tmp);
    const dy = median(s.oy, nk, s.tmp);
    const w = Math.max(o.minBox, b.w * sc);
    const h = Math.max(o.minBox, b.h * sc);
    const nb = { x: cx + dx - w / 2, y: cy + dy - h / 2, w, h };
    const vis =
      (Math.max(0, Math.min(nb.x + w, W) - Math.max(nb.x, 0)) * Math.max(0, Math.min(nb.y + h, H) - Math.max(nb.y, 0))) /
      (w * h);
    if (vis < o.minVisible) return this._lose(Q);
    // Flow only says the points moved consistently. Something textured passing in front moves consistently too,
    // and flow would ride away on it: the box must still look like the object (key or last good template).
    const look = this._look(Q, nb);
    const app = this._likeness(look);
    if (app < o.minAppearance) return this._lose(Q);
    this.box = nb;
    this.vx = dx;
    this.vy = dy;
    // nv / total: how much of the object could be followed at all (the median filter itself always drops ~3/4).
    const flowQ = Math.min(1, Math.max(0, 1 - medFB / o.maxFB)) * (nv / total);
    const quality = flowQ * Math.min(1, app / o.goodAppearance);
    if (flowQ >= o.goodQuality && app >= o.goodAppearance) this.good = { pyr: cropPyramid(Q, nb), box: { ...nb }, look };
    return { box: { ...nb }, quality, lost: false };
  }

  _lose(Q) {
    this.lost = true;
    this.pending = null;
    this.vx = 0;
    this.vy = 0;
    // The object may only have moved too far for LK: look for it right away.
    return this._redetect(Q);
  }

  // NCC template search around the last good position; this.box keeps the last good box while lost.
  _redetect(Q) {
    const o = this.o;
    const b = this.box;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const s1 = Math.min(1, o.searchSize / Math.max(b.w, b.h));
    const none = () => {
      this.pending = null;
      return { box: null, quality: 0, lost: true };
    };
    const coarse = this._match(Q, cx, cy, b.w, b.h, o.searchSpan * b.w, o.searchSpan * b.h, s1);
    // Smooth content matches a small template almost anywhere: a place counts only if it clearly beats the rest.
    if (!coarse || coarse.score < o.reacquire || coarse.score - coarse.second < o.ambiguity) return none();
    let best = coarse;
    const s2 = Math.min(1, o.refineSize / Math.max(b.w, b.h));
    if (s2 > s1 * 1.2) {
      const r = 1.5 / s1 + 1;
      const fine = this._match(Q, coarse.x, coarse.y, b.w, b.h, r, r, s2);
      if (!fine) return none();
      best = fine;
    }
    if (best.score < o.reacquireFine) return none();
    // One lucky frame is not enough: the place must be found again on the next frame(s), close to the last one.
    const p = this.pending;
    const tol = Math.max(4, 0.3 * Math.max(b.w, b.h));
    this.pending = p && Math.hypot(best.x - p.x, best.y - p.y) <= tol ? { x: best.x, y: best.y, n: p.n + 1 } : { x: best.x, y: best.y, n: 1 };
    if (this.pending.n < o.confirm) return { box: null, quality: 0, lost: true };
    this.pending = null;
    this.box = { x: best.x - b.w / 2, y: best.y - b.h / 2, w: b.w, h: b.h };
    this.lost = false;
    return { box: { ...this.box }, quality: Math.min(1, best.score), lost: false };
  }

  // Best NCC position of the templates (key + last good, both resized to w × h) for a centre within ±spanX, ±spanY
  // of (cx, cy), on a grid downscaled by s. Returns { score, x, y } (level-0 pixels) or null.
  _match(Q, cx, cy, w, h, spanX, spanY, s) {
    const o = this.o;
    let L = 0;
    while (L < Q.length - 1 && 1 / (1 << (L + 1)) >= s) L++;
    const k = 1 / (1 << L);
    const lv = Q[L];
    const step = 1 / s; // level-0 pixels between samples
    const tw = Math.max(4, Math.round(w * s));
    const th = Math.max(4, Math.round(h * s));
    const mx = Math.max(1, Math.round(spanX * s));
    const my = Math.max(1, Math.round(spanY * s));
    const sw = tw + 2 * mx;
    const sh = th + 2 * my;
    // Search image cells outside the frame are not usable; the template must sit fully inside it.
    const W0 = this.width;
    const H0 = this.height;
    const colX = i => cx + (i - (sw - 1) / 2) * step;
    const rowY = j => cy + (j - (sh - 1) / 2) * step;
    let c0 = 0, c1 = sw - 1, r0 = 0, r1 = sh - 1;
    while (c0 < sw && colX(c0) < 0) c0++;
    while (c1 >= 0 && colX(c1) > W0 - 1) c1--;
    while (r0 < sh && rowY(r0) < 0) r0++;
    while (r1 >= 0 && rowY(r1) > H0 - 1) r1--;
    const nu = c1 - c0 + 1 - tw + 1;
    const nvv = r1 - r0 + 1 - th + 1;
    if (nu < 1 || nvv < 1) return null;
    const img = new Float32Array(sw * sh);
    sampleGrid(lv, colX(0) * k, rowY(0) * k, step * k, step * k, sw, sh, img);
    // Integral images of the search patch for the window means and variances.
    const iw = sw + 1;
    const I1 = new Float64Array(iw * (sh + 1));
    const I2 = new Float64Array(iw * (sh + 1));
    for (let y = 0; y < sh; y++) {
      let a1 = 0, a2 = 0;
      for (let x = 0; x < sw; x++) {
        const v = img[y * sw + x];
        a1 += v;
        a2 += v * v;
        I1[(y + 1) * iw + x + 1] = I1[y * iw + x + 1] + a1;
        I2[(y + 1) * iw + x + 1] = I2[y * iw + x + 1] + a2;
      }
    }
    const nt = tw * th;
    const tpl = new Float32Array(nt);
    const map = new Float32Array(nu * nvv);
    let best = -2, bu = 0, bv = 0;
    for (const src of this.good === this.key ? [this.key] : [this.key, this.good]) {
      const sb = src.box;
      const sl = src.pyr[L];
      const sx = sb.w / tw;
      const sy = sb.h / th;
      const scx = sb.x + sb.w / 2;
      const scy = sb.y + sb.h / 2;
      sampleGrid(sl, (scx - ((tw - 1) / 2) * sx) * k, (scy - ((th - 1) / 2) * sy) * k, sx * k, sy * k, tw, th, tpl);
      let mean = 0;
      for (let i = 0; i < nt; i++) mean += tpl[i];
      mean /= nt;
      let tn = 0;
      for (let i = 0; i < nt; i++) {
        tpl[i] -= mean;
        tn += tpl[i] * tpl[i];
      }
      if (tn < nt * 1) continue; // a flat template matches anything
      tn = Math.sqrt(tn);
      for (let v = 0; v < nvv; v++) {
        const y0 = r0 + v;
        for (let u = 0; u < nu; u++) {
          const x0 = c0 + u;
          let dot = 0;
          for (let ty = 0, t = 0; ty < th; ty++) {
            let p = (y0 + ty) * sw + x0;
            for (let tx = 0; tx < tw; tx++) dot += tpl[t++] * img[p++];
          }
          const a = y0 * iw + x0;
          const z = (y0 + th) * iw + x0;
          const s1 = I1[z + tw] - I1[z] - I1[a + tw] + I1[a];
          const s2 = I2[z + tw] - I2[z] - I2[a + tw] + I2[a];
          const vr = s2 - (s1 * s1) / nt;
          const score = vr > nt ? dot / (tn * Math.sqrt(vr)) : 0;
          const mi = v * nu + u;
          if (score > map[mi] || src === this.key) map[mi] = score;
          if (score > best) {
            best = score;
            bu = u;
            bv = v;
          }
        }
      }
    }
    if (best <= -2) return null;
    // Best score away from the peak (more than half a template from it): how unique the peak is.
    const ru = Math.ceil(tw / 2);
    const rv = Math.ceil(th / 2);
    let second = -1;
    for (let v = 0; v < nvv; v++) {
      const far = Math.abs(v - bv) > rv;
      for (let u = 0; u < nu; u++) {
        if (!far && Math.abs(u - bu) <= ru) continue;
        const sc = map[v * nu + u];
        if (sc > second) second = sc;
      }
    }
    // Sub-cell peak from a parabola through the neighbours.
    const peak = (l, c, r) => {
      const den = l - 2 * c + r;
      return den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
    };
    const mi = bv * nu + bu;
    const ox = bu > 0 && bu < nu - 1 ? peak(map[mi - 1], map[mi], map[mi + 1]) : 0;
    const oy = bv > 0 && bv < nvv - 1 ? peak(map[mi - nu], map[mi], map[mi + nu]) : 0;
    return {
      score: best,
      second,
      x: colX(c0 + bu + ox + (tw - 1) / 2),
      y: rowY(r0 + bv + oy + (th - 1) / 2),
    };
  }

  // The box's picture on the fixed appearance grid, from the pyramid level whose pixels are no finer than the grid
  // spacing (so the samples are not aliased). Zero mean, unit length; null when the patch is flat.
  _look(pyr, box) {
    const n = this.aw * this.ah;
    const sx = box.w / this.aw;
    const sy = box.h / this.ah;
    let L = 0;
    while (L < pyr.length - 1 && 1 << (L + 1) <= Math.min(sx, sy)) L++;
    const k = 1 / (1 << L);
    const out = new Float32Array(n);
    sampleGrid(pyr[L], (box.x + sx / 2) * k, (box.y + sy / 2) * k, sx * k, sy * k, this.aw, this.ah, out);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += out[i];
    mean /= n;
    let ss = 0;
    for (let i = 0; i < n; i++) {
      out[i] -= mean;
      ss += out[i] * out[i];
    }
    if (ss < n * 1) return null; // flat (an occluder, a blown-out sky): looks like nothing
    const inv = 1 / Math.sqrt(ss);
    for (let i = 0; i < n; i++) out[i] *= inv;
    return out;
  }

  // NCC of a look with the key and the last good template, whichever is closer.
  _likeness(look) {
    if (!look) return 0;
    let best = -1;
    for (const t of this.good === this.key ? [this.key] : [this.key, this.good]) {
      if (!t.look) continue;
      let d = 0;
      for (let i = 0; i < look.length; i++) d += look[i] * t.look[i];
      if (d > best) best = d;
    }
    return Math.max(0, best);
  }
}

function ncc(a, b, n) {
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  // Flat patches (an occluder, a blown-out sky) carry no evidence either way.
  return aa > n * 0.25 && bb > n * 0.25 ? ab / Math.sqrt(aa * bb) : 0;
}
