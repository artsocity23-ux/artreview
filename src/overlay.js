// The one renderer for notes: the live preview and the exported video both call drawOverlay, so what the reviewer
// sees is what lands in the chat. Everything is laid out in the W×H picture area and scales with it.
import { placeAt } from './notes.js';

export const FONT_FAMILY = '"Segoe UI", system-ui, sans-serif';
const BUBBLE_BG = 'rgba(16, 18, 22, 0.82)';

// Sizes for a picture of W×H: u is one thousandth of the long side, with floors so small previews stay legible.
export function metrics(W, H) {
  const u = Math.max(W, H) / 1000;
  const font = Math.max(13, 18 * u);
  return {
    u,
    font,
    line: Math.round(font * 1.3),
    pinR: Math.max(9, 13 * u),
    lw: Math.max(2, 2.5 * u),
    pad: Math.max(6, 9 * u),
    stripe: Math.max(3, 4 * u),
    margin: Math.max(6, 10 * u),
    gap: Math.max(10, 16 * u),
    maxW: Math.max(120, W * 0.34),
    minEditW: Math.max(120, 170 * u),
  };
}

// Word-wraps text into lines no wider than maxW; words longer than a line are broken by characters.
export function wrapText(ctx, text, maxW) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const tryLine = line + word;
      if (ctx.measureText(tryLine).width <= maxW) {
        line = tryLine;
        continue;
      }
      if (/^\s+$/.test(word)) {
        lines.push(line);
        line = '';
        continue;
      }
      if (line) lines.push(line.trimEnd());
      line = '';
      // A word wider than the bubble: cut it where it overflows.
      let rest = word;
      while (ctx.measureText(rest).width > maxW && rest.length > 1) {
        let k = rest.length - 1;
        while (k > 1 && ctx.measureText(rest.slice(0, k)).width > maxW) k--;
        lines.push(rest.slice(0, k));
        rest = rest.slice(k);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

const overlap = (a, b) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

// Up-right, up-left, down-right, down-left of the pin first; then beside it and stacked further away, which are
// taken only when strictly less crowded (a crowded shot still gets readable bubbles, with longer leader lines).
function candidates(px, py, w, h, d) {
  const list = [
    { x: px + d, y: py - d - h }, { x: px - d - w, y: py - d - h }, { x: px + d, y: py + d }, { x: px - d - w, y: py + d },
    { x: px + d, y: py - h / 2 }, { x: px - d - w, y: py - h / 2 },
  ];
  for (let s = 1; s <= 8; s++) {
    const e = s * (h * 0.55 + d * 0.5);
    list.push(
      { x: px + d, y: py - d - h - e }, { x: px - d - w, y: py - d - h - e },
      { x: px + d, y: py + d + e }, { x: px - d - w, y: py + d + e },
    );
  }
  return list;
}

function placeBubble(px, py, w, h, W, H, m, placed, pins) {
  const d = m.gap * 0.75 + m.pinR * 0.5;
  let best = null;
  for (const c of candidates(px, py, w, h, d)) {
    const r = { x: c.x, y: c.y, w, h };
    const outside = Math.max(0, m.margin - r.x) + Math.max(0, r.x + w - (W - m.margin)) + Math.max(0, m.margin - r.y) + Math.max(0, r.y + h - (H - m.margin));
    let cost = outside > 0 ? 1e9 + outside * 1e4 : 0;
    for (const p of placed) cost += overlap(r, p);
    for (const p of pins) cost += overlap(r, p) * 0.5;
    if (!best || cost < best.cost) best = { ...r, cost };
  }
  // Never outside the picture: a bubble that fits nowhere is pushed in.
  best.x = Math.max(m.margin, Math.min(best.x, W - m.margin - w));
  best.y = Math.max(m.margin, Math.min(best.y, H - m.margin - h));
  if (w > W - 2 * m.margin) best.x = Math.max(0, (W - w) / 2);
  if (h > H - 2 * m.margin) best.y = Math.max(0, (H - h) / 2);
  return { x: best.x, y: best.y, w, h };
}

// Nearest point of a rectangle to (x, y): where the leader line meets the bubble.
const nearest = (r, x, y) => ({ x: Math.max(r.x, Math.min(x, r.x + r.w)), y: Math.max(r.y, Math.min(y, r.y + r.h)) });

/**
 * Draws the notes visible on frame f into the W×H picture area of ctx (origin at the picture's top-left).
 * opts = { selectedId, editingId, hud, timecode, frameLabel, preview, rubber }
 * Returns the layout for hit-testing and for placing the text editor: [{ id, index, pin, r, bubble, box, lost }].
 */
export function drawOverlay(ctx, W, H, review, f, opts = {}) {
  const m = metrics(W, H);
  const items = [];
  review.notes.forEach((note, index) => {
    const at = placeAt(note, f);
    if (!at) return;
    items.push({
      note,
      index,
      id: note.id,
      pin: { x: at.pin.x * W, y: at.pin.y * H },
      box: at.box ? { x: at.box.x * W, y: at.box.y * H, w: at.box.w * W, h: at.box.h * H } : null,
      lost: at.lost,
    });
  });

  ctx.save();
  ctx.textBaseline = 'top';
  ctx.font = `${m.font}px ${FONT_FAMILY}`;

  // Bubble sizes and places, in note order so earlier notes keep the best spots.
  const placed = [];
  const pinRects = items.map(it => ({ x: it.pin.x - m.pinR, y: it.pin.y - m.pinR, w: m.pinR * 2, h: m.pinR * 2 }));
  for (const it of items) {
    const editing = it.id === opts.editingId;
    const text = it.note.text || '';
    if (!text.trim() && !editing) {
      it.bubble = null;
      continue;
    }
    const inner = m.maxW - 2 * m.pad - m.stripe;
    it.lines = wrapText(ctx, text, inner);
    let tw = Math.max(...it.lines.map(l => ctx.measureText(l).width), 0);
    if (editing) tw = Math.max(tw + m.font, m.minEditW - 2 * m.pad - m.stripe); // room for the caret and the next word
    tw = Math.min(tw, inner);
    const w = Math.ceil(tw + 2 * m.pad + m.stripe);
    const h = Math.ceil(it.lines.length * m.line + 2 * m.pad - (m.line - m.font) * 0.5);
    it.bubble = placeBubble(it.pin.x, it.pin.y, w, h, W, H, m, placed, pinRects.filter((_, k) => items[k] !== it));
    it.bubble.inner = tw;
    placed.push(it.bubble);
  }

  // Boxes first: they sit under everything else.
  for (const it of items) {
    if (!it.box || !it.note.showBox) continue;
    const b = it.box;
    const r = Math.max(3, 5 * m.u);
    ctx.setLineDash(it.lost ? [m.lw * 3, m.lw * 2.2] : []);
    roundRect(ctx, b.x, b.y, b.w, b.h, r);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = m.lw + 2;
    ctx.stroke();
    ctx.strokeStyle = it.note.color;
    ctx.lineWidth = m.lw;
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Leader lines from pin to bubble.
  for (const it of items) {
    if (!it.bubble) continue;
    const p = nearest(it.bubble, it.pin.x, it.pin.y);
    const dx = p.x - it.pin.x;
    const dy = p.y - it.pin.y;
    if (Math.hypot(dx, dy) <= m.pinR) continue;
    ctx.beginPath();
    ctx.moveTo(it.pin.x, it.pin.y);
    ctx.lineTo(p.x, p.y);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.lineWidth = m.lw * 0.8 + 2;
    ctx.stroke();
    ctx.strokeStyle = it.note.color;
    ctx.lineWidth = m.lw * 0.8;
    ctx.stroke();
  }

  // Bubbles: dark panel, colour stripe on the left, white text.
  for (const it of items) {
    const b = it.bubble;
    if (!b) continue;
    const r = Math.max(4, 6 * m.u);
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 6 * Math.max(1, m.u);
    roundRect(ctx, b.x, b.y, b.w, b.h, r);
    ctx.fillStyle = BUBBLE_BG;
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundRect(ctx, b.x, b.y, b.w, b.h, r);
    ctx.clip();
    ctx.fillStyle = it.note.color;
    ctx.fillRect(b.x, b.y, m.stripe, b.h);
    ctx.restore();
    if (opts.preview && it.id === opts.selectedId) {
      roundRect(ctx, b.x - 1, b.y - 1, b.w + 2, b.h + 2, r + 1);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (it.id === opts.editingId) continue; // the live <textarea> sits on top and shows the text and caret
    ctx.fillStyle = '#fff';
    const x = b.x + m.stripe + m.pad;
    it.lines.forEach((line, k) => ctx.fillText(line, x, b.y + m.pad + k * m.line));
  }

  // Pins on top: filled circle, white ring, dark number, a soft shadow so they read on any footage.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const it of items) {
    const { x, y } = it.pin;
    const r = m.pinR;
    if (opts.preview && it.id === opts.selectedId) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.shadowColor = it.note.color;
      ctx.shadowBlur = 12;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = Math.max(3, 4 * m.u);
    ctx.shadowOffsetY = Math.max(1, m.u);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = it.note.color;
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#14161b';
    const label = String(it.index + 1);
    ctx.font = `700 ${Math.round(r * (label.length > 1 ? 0.95 : 1.15))}px ${FONT_FAMILY}`;
    ctx.fillText(label, x, y + r * 0.05);
  }

  if (opts.rubber) {
    const b = opts.rubber;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 3;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = b.color || '#fff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
  }

  if (opts.hud) drawHud(ctx, W, H, review, opts, m);
  ctx.restore();

  return items.map(it => ({ id: it.id, index: it.index, pin: it.pin, r: m.pinR, bubble: it.bubble, box: it.box, lost: it.lost, metrics: m }));
}

// Bottom-left tag: shot · timecode · frame.
function drawHud(ctx, W, H, review, opts, m) {
  const name = (review.video?.name || '').replace(/\.[^.]+$/, '');
  let frame = String(opts.frameLabel ?? '');
  if (/^\d/.test(frame)) frame = `кадр ${frame}`;
  const text = [name, opts.timecode, frame].filter(Boolean).join(' · ');
  if (!text) return;
  const size = Math.max(11, 13 * m.u);
  ctx.font = `${size}px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const padX = size * 0.6;
  const h = size * 1.7;
  const w = ctx.measureText(text).width + padX * 2;
  const x = m.margin;
  const y = H - m.margin - h;
  roundRect(ctx, x, y, w, h, size * 0.35);
  ctx.fillStyle = 'rgba(16, 18, 22, 0.75)';
  ctx.fill();
  ctx.fillStyle = '#e7e9ee';
  ctx.fillText(text, x + padX, y + h / 2);
}
