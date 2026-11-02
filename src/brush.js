// Stroke engine. Input points are smoothed and joined with quadratic curves; every piece between two samples goes to
// the GPU as one instance: the round brush as a capsule with a radius at each end (pressure), the flat brush as the
// convex polygon a thin rectangular nib sweeps between two samples, so its line is wide or thin depending on the
// direction of travel, like a chisel marker or a calligraphy pen. The shaders (gpu.js) merge the pieces into one
// coverage mask, so joins are seamless and anti-aliased.
import { CAPS_FLOATS, POLY_FLOATS } from './gpu.js';

// Shoelace sum in document coordinates (y down). The polygon shader expects a positive sum.
function area(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    s += x0 * y1 - x1 * y0;
  }
  return s;
}

// Andrew's monotone chain; a handful of points per call.
function hull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export class Stroke {
  // gpu: receives the pieces. o: { kind: 'round' | 'flat' | 'eraser', size, angle (deg, flat nib), smoothing 0..0.95,
  // pressure (bool) }
  constructor(gpu, o) {
    this.gpu = gpu;
    this.o = o;
    this.flat = o.kind === 'flat';
    // The angle is read like on paper: counter-clockwise from horizontal, so 45° is a nib edge rising like "/".
    const a = (o.angle * Math.PI) / 180;
    this.u = [Math.cos(a), -Math.sin(a)]; // nib long axis
    this.v = [Math.sin(a), Math.cos(a)]; // nib thickness
    this.pts = [];
    this.s = null; // smoothed pen state
    this.raw = null;
    this.prev = null; // last emitted sample
    this.caps = [];
    this.polys = [];
    this.box = [Infinity, Infinity, -Infinity, -Infinity];
  }

  // Pressure to size factor: a light touch still leaves a visible line.
  factor(p) {
    return this.o.pressure ? 0.1 + 0.9 * Math.min(1, Math.max(0, p)) : 1;
  }

  add(x, y, p) {
    this.raw = [x, y, p];
    if (!this.s) {
      this.s = [x, y, p];
      this.pts.push([x, y, p]);
      this.emit(x, y, p);
      return;
    }
    const k = 1 - this.o.smoothing;
    const s = this.s;
    s[0] += (x - s[0]) * k;
    s[1] += (y - s[1]) * k;
    s[2] += (p - s[2]) * 0.5;
    const last = this.pts[this.pts.length - 1];
    if (Math.hypot(s[0] - last[0], s[1] - last[1]) < 0.6) return;
    this.pts.push([s[0], s[1], s[2]]);
    this.curve();
  }

  // Quadratic curve from the middle of the previous segment to the middle of the new one, through the shared point.
  curve() {
    const n = this.pts.length;
    if (n === 2) {
      const [a, b] = this.pts;
      this.line(a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
      return;
    }
    const a = this.pts[n - 3];
    const b = this.pts[n - 2];
    const c = this.pts[n - 1];
    const m0 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const m1 = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2, (b[2] + c[2]) / 2];
    const len = Math.hypot(b[0] - m0[0], b[1] - m0[1]) + Math.hypot(m1[0] - b[0], m1[1] - b[1]);
    const steps = Math.max(1, Math.min(48, Math.ceil(len / 2.5)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const w0 = (1 - t) * (1 - t);
      const w1 = 2 * (1 - t) * t;
      const w2 = t * t;
      this.emit(
        w0 * m0[0] + w1 * b[0] + w2 * m1[0],
        w0 * m0[1] + w1 * b[1] + w2 * m1[1],
        m0[2] + (m1[2] - m0[2]) * t,
      );
    }
  }

  line(from, to) {
    const steps = Math.max(1, Math.min(48, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 2.5)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this.emit(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t);
    }
  }

  // Lifts the pen: the smoothed trail catches up with where the pen actually left the paper.
  end() {
    const n = this.pts.length;
    if (n >= 2) {
      const a = this.pts[n - 2];
      const b = this.pts[n - 1];
      this.line([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], b);
    }
    const last = this.pts[n - 1];
    if (this.raw && last && Math.hypot(this.raw[0] - last[0], this.raw[1] - last[1]) > 0.5) {
      this.line(last, [this.raw[0], this.raw[1], last[2]]);
    }
    this.flush();
  }

  emit(x, y, p) {
    const f = this.factor(p);
    const s = this.flat
      ? { x, y, a: Math.max(0.75, (this.o.size / 2) * f), b: Math.max(0.6, (this.o.size / 2) * f * 0.16) }
      : { x, y, r: Math.max(0.5, (this.o.size / 2) * f) };
    const a = this.prev || s;
    if (this.flat) this.polygon(this.prev ? hull([...this.nib(a), ...this.nib(s)]) : this.nib(s));
    else this.caps.push(a.x, a.y, s.x, s.y, a.r, s.r); // a zero-length capsule is a dab
    this.prev = s;
    const m = (s.r || s.a) + 2;
    const box = this.box;
    if (x - m < box[0]) box[0] = x - m;
    if (y - m < box[1]) box[1] = y - m;
    if (x + m > box[2]) box[2] = x + m;
    if (y + m > box[3]) box[3] = y + m;
  }

  // Up to 8 vertices, padded with the last one, then the vertex count.
  polygon(pts) {
    if (area(pts) < 0) pts.reverse();
    for (let i = 0; i < 8; i++) {
      const [x, y] = pts[Math.min(i, pts.length - 1)];
      this.polys.push(x, y);
    }
    this.polys.push(pts.length);
  }

  nib(s) {
    const [ux, uy] = this.u;
    const [vx, vy] = this.v;
    return [
      [s.x + ux * s.a + vx * s.b, s.y + uy * s.a + vy * s.b],
      [s.x + ux * s.a - vx * s.b, s.y + uy * s.a - vy * s.b],
      [s.x - ux * s.a - vx * s.b, s.y - uy * s.a - vy * s.b],
      [s.x - ux * s.a + vx * s.b, s.y - uy * s.a + vy * s.b],
    ];
  }

  flush() {
    if (this.caps.length) this.gpu.capsules(new Float32Array(this.caps), this.caps.length / CAPS_FLOATS);
    if (this.polys.length) this.gpu.polygons(new Float32Array(this.polys), this.polys.length / POLY_FLOATS);
    this.caps.length = 0;
    this.polys.length = 0;
  }
}
