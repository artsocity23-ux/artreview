// Renders the ArtFrames icon (a sheet of paper with a ball and its onion-skin ghosts, red behind and green ahead)
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

// Shapes in 0..1 icon space, painted back to front: [sdf, colour, opacity].
const LAYERS = [
  [roundRect(0.5, 0.5, 0.5, 0.5, 0.22), hex('#1f232b'), 1],
  [roundRect(0.5, 0.52, 0.36, 0.3, 0.05), hex('#f3f1ec'), 1],
  [circle(0.29, 0.67, 0.105), hex('#ff5a4e'), 0.5],
  [circle(0.71, 0.37, 0.105), hex('#1fb35a'), 0.5],
  [circle(0.5, 0.52, 0.125), hex('#1b1b1f'), 1],
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
