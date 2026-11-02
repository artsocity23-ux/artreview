// Renders the ArtReview icon (a film frame with a play triangle and a red map pin stuck into it, like a note on a shot)
// with signed distance fields and writes icon.png, icon.ico and build/icon.png for the installers. Run once: `node make-icon.js`.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

const roundRect = (cx, cy, hw, hh, r) => ([x, y]) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const circle = (cx, cy, r) => ([x, y]) => Math.hypot(x - cx, y - cy) - r;

// Exact distance to a convex polygon (points in clockwise screen order), negative inside.
const polygon = pts => ([x, y]) => {
  let d = Infinity;
  let inside = true;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const ex = bx - ax;
    const ey = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
    d = Math.min(d, Math.hypot(x - ax - t * ex, y - ay - t * ey));
    if (ex * (y - ay) - ey * (x - ax) < 0) inside = false;
  }
  return inside ? -d : d;
};
const union = (...shapes) => p => Math.min(...shapes.map(s => s(p)));
const grow = (shape, r) => p => shape(p) - r;

// Map pin: a circle with a point below it, the sides tangent to the circle.
function pin(cx, cy, r, tipY) {
  const d = tipY - cy;
  const s = r / d;
  const c = Math.sqrt(1 - s * s);
  return union(circle(cx, cy, r), polygon([[cx - r * c, cy + r * s], [cx + r * c, cy + r * s], [cx, tipY]]));
}

const BG = '#1f232b';
const FILM = '#e9e6df';
const PICTURE = '#2d323d';
const PIN = pin(0.71, 0.55, 0.15, 0.9);

// Sprocket holes along the top and bottom edge of the film frame.
const holes = [];
for (let i = 0; i < 6; i++) {
  const x = 0.15 + i * 0.112;
  holes.push([roundRect(x, 0.235, 0.028, 0.02, 0.008), hex(BG), 1]);
  holes.push([roundRect(x, 0.705, 0.028, 0.02, 0.008), hex(BG), 1]);
}

// Shapes in 0..1 icon space, painted back to front: [sdf, colour, opacity].
const LAYERS = [
  [roundRect(0.5, 0.5, 0.5, 0.5, 0.22), hex(BG), 1],
  [roundRect(0.43, 0.47, 0.35, 0.285, 0.05), hex(FILM), 1],
  ...holes,
  [roundRect(0.43, 0.47, 0.35, 0.185, 0.025), hex(PICTURE), 1],
  [polygon([[0.33, 0.37], [0.5, 0.47], [0.33, 0.57]]), hex(FILM), 1],
  // a background-coloured rim cuts the pin out of the frame so it reads at 16 px
  [grow(PIN, 0.03), hex(BG), 1],
  [PIN, hex('#ff5a4e'), 1],
  [circle(0.71, 0.55, 0.06), hex('#ffffff'), 1],
];

function render(size) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = [(x + 0.5) / size, (y + 0.5) / size];
      let [r, g, b, a] = [0, 0, 0, 0];
      for (const [sdf, [cr, cg, cb], alpha] of LAYERS) {
        const k = alpha * Math.max(0, Math.min(1, 0.5 - sdf(p) * size));
        if (!k) continue;
        const na = k + a * (1 - k);
        r = (cr * k + r * a * (1 - k)) / na;
        g = (cg * k + g * a * (1 - k)) / na;
        b = (cb * k + b * a * (1 - k)) / na;
        a = na;
      }
      out.set([r, g, b, a * 255].map(Math.round), (y * size + x) * 4);
    }
  }
  return out;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const rgba = render(size);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(images[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += images[i].length;
    return e;
  });
  return Buffer.concat([header, ...dir, ...images]);
}

const out = (name, data) => fs.writeFileSync(path.join(__dirname, name), data);
out('icon.png', png(256));
out('icon.ico', ico([16, 24, 32, 48, 256]));
fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
out('build/icon.png', png(1024)); // macOS and Linux installers want a big one
console.log('icons written');
