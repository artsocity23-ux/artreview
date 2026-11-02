// Note model helpers: where a note sits on a given frame, timecodes, and the notes as a message or markdown.
// Pure functions (no DOM), so the preview, the export and the tests all read notes the same way.

export const PALETTE = ['#ff5a4e', '#ffc23d', '#3dd6ff', '#7ee26b', '#ff6bd6', '#ff9a3d', '#b48cff', '#ffffff'];

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const newId = () => `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// The first palette colour no living note wears, counting on from the newest note's colour, so neighbours differ.
export function nextColor(notes) {
  const used = new Set(notes.map(n => n.color));
  const last = notes.length ? PALETTE.indexOf(notes[notes.length - 1].color) : -1;
  for (let k = 1; k <= PALETTE.length; k++) {
    const c = PALETTE[(last + k + PALETTE.length) % PALETTE.length];
    if (!used.has(c)) return c;
  }
  return PALETTE[notes.length % PALETTE.length]; // all eight taken: repeat rather than refuse
}

// Timecode HH:MM:SS:FF on the rounded nominal rate (24 for 23.976, 30 for 29.97), non-drop-frame.
export function timecode(f, fps) {
  const n = Math.max(1, Math.round(fps || 25));
  const ff = f % n;
  const s = Math.floor(f / n);
  const p = v => String(v).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

export const startOf = (review, settings) => review?.startFrame ?? settings?.startFrame ?? 1;

const box4 = b => (b ? { x: b[0], y: b[1], w: b[2], h: b[3] } : null);

// The tracked box at f, or the nearest tracked one: the pin holds where the object was last seen.
function trackedBox(track, f) {
  const n = track.boxes.length;
  if (!n) return { box: null, lost: false };
  const i = f - track.from;
  if (i >= 0 && i < n && track.boxes[i]) return { box: box4(track.boxes[i]), lost: false };
  const inside = i >= 0 && i < n;
  const start = clamp(i, 0, n - 1);
  for (let d = 0; d < n; d++) {
    // Look back in time first: a lost object is held where it was, not where it will be.
    if (start - d >= 0 && track.boxes[start - d]) return { box: box4(track.boxes[start - d]), lost: inside };
    if (start + d < n && track.boxes[start + d]) return { box: box4(track.boxes[start + d]), lost: inside };
  }
  return { box: null, lost: inside };
}

// Where a note is drawn at frame f: { pin, box, lost } in normalized picture coordinates, or null when hidden.
export function placeAt(note, f, { ignoreRange = false } = {}) {
  if (!ignoreRange && (f < note.in || f > note.out)) return null;
  if (!note.track || !note.box) return { pin: { ...note.pin }, box: note.box ? { ...note.box } : null, lost: false };
  const t = trackedBox(note.track, f);
  if (!t.box) return { pin: { ...note.pin }, box: { ...note.box }, lost: t.lost };
  const k = note.box;
  const u = k.w > 0 ? (note.pin.x - k.x) / k.w : 0.5;
  const v = k.h > 0 ? (note.pin.y - k.y) / k.h : 0;
  const b = t.box;
  return { pin: { x: b.x + u * b.w, y: b.y + v * b.h }, box: b, lost: t.lost };
}

export function lostFrames(note) {
  return note.track ? note.track.boxes.reduce((n, b) => n + (b ? 0 : 1), 0) : 0;
}

export function trackQuality(note) {
  const good = note.track?.boxes.filter(Boolean) || [];
  return good.length ? good.reduce((s, b) => s + (b[4] ?? 1), 0) / good.length : 0;
}

// Ukrainian plural: one / few (2–4) / many.
export function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export const nNotes = n => `${n} ${plural(n, 'нотатка', 'нотатки', 'нотаток')}`;

const baseName = review => review?.video?.name || 'відео';
const range = (note, s) => (note.out > note.in ? `кадр ${note.in + s}–${note.out + s}` : `кадр ${note.in + s}`);

// Message text: a short numbered list to paste into a chat beside the video.
export function notesText(review, settings) {
  const s = startOf(review, settings);
  const fps = review.video?.fps || 25;
  const lines = [`${baseName(review)} — ${nNotes(review.notes.length)}`];
  review.notes.forEach((n, i) => {
    const text = (n.text || '').trim().replace(/\s*\n\s*/g, '\n   ') || '(без тексту)';
    lines.push(`${i + 1}. ${timecode(n.in, fps)} (${range(n, s)}) — ${text}`);
  });
  return lines.join('\n');
}

// Markdown: the same list plus the facts a compositor wants (pin position in source pixels, tracking).
// `info` = { file, width, height } of the exported video, when there is one.
export function notesMarkdown(review, settings, info = null) {
  const s = startOf(review, settings);
  const v = review.video || {};
  const fps = v.fps || 25;
  const fpsText = Math.abs(fps - Math.round(fps)) < 1e-3 ? String(Math.round(fps)) : fps.toFixed(3);
  const facts = [`${fpsText} к/с`, `${v.width}×${v.height}`];
  if (info?.file) facts.push(`відео: ${info.file.split(/[\\/]/).pop()}${info.width ? ` (${info.width}×${info.height})` : ''}`);
  const out = [`# ${baseName(review)}`, '', facts.join(' · '), ''];
  review.notes.forEach((n, i) => {
    const text = (n.text || '').trim().replace(/\s*\n\s*/g, '  \n   ') || '(без тексту)';
    out.push(`${i + 1}. **${timecode(n.in, fps)}** (${range(n, s)}) — ${text}  `);
    const p = placeAt(n, n.key, { ignoreRange: true }).pin;
    const extra = [`x ${Math.round(p.x * (v.width || 0))}, y ${Math.round(p.y * (v.height || 0))} (кадр ${n.key + s})`];
    if (n.track) extra.push("стежить за об'єктом");
    out.push(`   ${extra.join(' · ')}`);
  });
  out.push('');
  return out.join('\n');
}

// A loaded note made safe: known fields, sane ranges, unique ids and colours.
export function normalizeNote(n, frameCount) {
  const last = Math.max(0, (frameCount || 1) - 1);
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  const nb = b => (b && [b.x, b.y, b.w, b.h].every(Number.isFinite) ? { x: +b.x, y: +b.y, w: +b.w, h: +b.h } : null);
  const inF = clamp(Math.round(num(n.in, 0)), 0, last);
  const box = nb(n.box);
  let track = null;
  if (box && n.track && Array.isArray(n.track.boxes)) {
    track = {
      from: Math.round(num(n.track.from, 0)),
      to: Math.round(num(n.track.to, 0)),
      boxes: n.track.boxes.map(b => (Array.isArray(b) && b.length >= 4 && b.slice(0, 4).every(Number.isFinite) ? b.slice(0, 5) : null)),
    };
  }
  return {
    id: typeof n.id === 'string' && n.id ? n.id : newId(),
    text: typeof n.text === 'string' ? n.text : '',
    color: PALETTE.includes(n.color) ? n.color : PALETTE[0],
    in: inF,
    out: clamp(Math.round(num(n.out, inF)), inF, last),
    pin: { x: clamp(num(n.pin?.x, 0.5), 0, 1), y: clamp(num(n.pin?.y, 0.5), 0, 1) },
    key: clamp(Math.round(num(n.key, inF)), 0, last),
    box,
    showBox: n.showBox !== false,
    track,
  };
}

export function normalizeNotes(list, frameCount) {
  const seen = new Set();
  const notes = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object') continue;
    const n = normalizeNote(raw, frameCount);
    if (seen.has(n.id)) n.id = newId();
    seen.add(n.id);
    notes.push(n);
  }
  return notes;
}
