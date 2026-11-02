// ArtReview: open a shot, click to pin a note, type, copy the video with the notes burned in into a chat.
// This file holds the UI state and wiring: stage and tools, inline text editing, notes panel, timeline, playback,
// undo, autosave per video, save / open .artreview, tracking queue and the copy flow.
import { runExport } from './export.js';
import { drawOverlay } from './overlay.js';
import {
  clamp, lostFrames, nNotes, newId, nextColor, normalizeNotes, notesText, placeAt, plural, timecode, trackQuality,
} from './notes.js';
import { trackNote } from './track.js';
import { openVideo } from './video.js';

const ar = window.ar;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;
const REVIEW_EXT = /\.artreview$/i;
const UNDO_MAX = 200;
const STAGE_PAD = 16;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const basename = p => String(p).split(/[\\/]/).pop();
const dirname = p => String(p).replace(/[\\/][^\\/]*$/, '');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtFps = fps => (Math.abs(fps - Math.round(fps)) < 1e-3 ? String(Math.round(fps)) : fps.toFixed(3).replace(/0+$/, ''));

const stage = $('#stage');
const view = $('#view');
const vctx = view.getContext('2d');
const editor = $('#editor');
const tl = $('#tl');
const tctx = tl.getContext('2d');
const tlWrap = $('#tlWrap');
const audio = $('#audio');

let settings = { outDir: null, maxSize: 1920, endCard: true, hud: true, audio: true, startFrame: 1, copyTextWithVideo: true };
let video = null; // VideoRef of the open shot
let review = null; // the live review: { format, version, video, startFrame, notes }
let cur = 0; // current frame, 0-based
let tool = 'pin';
let selectedId = null;
let editing = null; // { id, before, isNew, startText }
let layout = []; // last overlay layout, picture coordinates (hit tests, editor placement)
let pic = { x: 0, y: 0, w: 0, h: 0 }; // picture rect inside the stage, CSS pixels
let frameCanvas = null;
let drag = null;
let boxFor = null; // note id waiting for a box ("Стежити за об'єктом")
let undoStack = [];
let redoStack = [];
let reviewKey = null;
let autosaveExists = false;
let lastExport = null; // { sig, result }
let lastClipboard = null;
let exporting = null; // AbortController of the running export
let pendingReview = null; // opened notes whose video is not found yet
const tracks = { queue: [], running: null, state: new Map() }; // state: id -> { status, progress }

const find = id => review?.notes.find(n => n.id === id) || null;
const last = () => (video ? video.frameCount - 1 : 0);
const startNum = () => review?.startFrame ?? settings.startFrame ?? 1;

// ---------- status and toast ----------

function status(text, cls = '') {
  const el = $('#statusText');
  el.textContent = text;
  el.className = cls;
}

let toastTimer = 0;
function toast(text, error = false) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.toggle('err', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), error ? 6000 : 3200);
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err.message || String(err), true);
    status(err.message || String(err), 'err');
    ar.log('error:', err.stack || err.message);
    return null;
  }
}

const TOOL_HINTS = {
  pin: 'Клікни по відео — з’явиться пін і поле для тексту. Enter — готово, Shift+Enter — новий рядок.',
  object: "Обведи об'єкт рамкою — пін поїде за ним. Текст можна писати, поки йде трекінг.",
  select: 'Тягни пін, щоб посунути. Подвійний клік по нотатці — редагувати текст, Delete — видалити.',
};

// ---------- stage layout and drawing ----------

function fitStage() {
  const dpr = devicePixelRatio || 1;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  view.width = Math.max(1, Math.round(w * dpr));
  view.height = Math.max(1, Math.round(h * dpr));
  if (video) {
    const s = Math.min((w - 2 * STAGE_PAD) / video.width, (h - 2 * STAGE_PAD) / video.height);
    const pw = Math.max(2, Math.round(video.width * s));
    const ph = Math.max(2, Math.round(video.height * s));
    pic = { x: Math.round((w - pw) / 2), y: Math.round((h - ph) / 2), w: pw, h: ph };
    if (video.layout(pw * dpr, ph * dpr) && !playing) video.show(cur);
  } else {
    pic = { x: 0, y: 0, w: 0, h: 0 };
  }
  render();
}

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function rubberRect() {
  if (drag?.kind !== 'box') return null;
  const x = Math.min(drag.x0, drag.x1);
  const y = Math.min(drag.y0, drag.y1);
  const color = drag.forId ? find(drag.forId)?.color : nextColor(review.notes);
  return { x, y, w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0), color };
}

function render() {
  const dpr = devicePixelRatio || 1;
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.clearRect(0, 0, view.width, view.height);
  if (!video || !review) {
    layout = [];
    placeEditor();
    return;
  }
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  vctx.fillStyle = '#000';
  vctx.fillRect(pic.x, pic.y, pic.w, pic.h);
  if (frameCanvas) vctx.drawImage(frameCanvas, pic.x, pic.y, pic.w, pic.h);
  vctx.save();
  vctx.translate(pic.x, pic.y);
  vctx.beginPath();
  vctx.rect(0, 0, pic.w, pic.h);
  vctx.clip();
  layout = drawOverlay(vctx, pic.w, pic.h, review, cur, {
    selectedId,
    editingId: editing?.id,
    preview: true,
    hud: false,
    rubber: rubberRect(),
  });
  vctx.restore();
  vctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  vctx.lineWidth = 1;
  vctx.strokeRect(pic.x - 0.5, pic.y - 0.5, pic.w + 1, pic.h + 1);
  placeEditor();
}

function onFrame(canvas, f) {
  frameCanvas = canvas;
  if (playing && f !== cur) {
    cur = f;
    updateInfo();
    renderTimeline();
  }
  requestRender();
}

// ---------- pointer on the stage ----------

const toPic = e => {
  const r = view.getBoundingClientRect();
  return { x: e.clientX - r.left - pic.x, y: e.clientY - r.top - pic.y };
};
const insidePic = p => p.x >= 0 && p.y >= 0 && p.x <= pic.w && p.y <= pic.h;

// Pins win over bubbles; later notes are drawn on top, so they are hit first.
function hitTest(p) {
  for (let i = layout.length - 1; i >= 0; i--) {
    const it = layout[i];
    if (Math.hypot(p.x - it.pin.x, p.y - it.pin.y) <= it.r + 4) return { id: it.id, part: 'pin' };
  }
  for (let i = layout.length - 1; i >= 0; i--) {
    const b = layout[i].bubble;
    if (b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return { id: layout[i].id, part: 'bubble' };
  }
  return null;
}

function onStageDown(e) {
  if (e.button !== 0 || !video) return;
  if (editing) {
    // A click outside the text finishes it; the next click makes the next note.
    e.preventDefault();
    commitEditor();
    return;
  }
  closeSettings();
  stopPlayback();
  const p = toPic(e);
  const hit = boxFor ? null : hitTest(p);
  view.setPointerCapture(e.pointerId);
  if (hit) {
    select(hit.id);
    drag = hit.part === 'pin' ? { kind: 'pin', id: hit.id, start: p, moved: false, before: snapshot() } : { kind: 'none' };
    return;
  }
  if (!insidePic(p)) {
    select(null);
    return;
  }
  if (boxFor || tool === 'object') {
    drag = { kind: 'box', x0: p.x, y0: p.y, x1: p.x, y1: p.y, forId: boxFor };
  } else if (tool === 'pin') {
    drag = { kind: 'newpin', p };
  } else {
    select(null);
  }
}

function onStageMove(e) {
  if (!video) return;
  const p = toPic(e);
  if (!drag) {
    stage.classList.toggle('over-note', !!hitTest(p));
    return;
  }
  if (drag.kind === 'pin') {
    if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 3) return;
    drag.moved = true;
    stage.classList.add('dragging');
    const note = find(drag.id);
    if (note) setPinAt(note, clamp(p.x / pic.w, 0, 1), clamp(p.y / pic.h, 0, 1), cur);
    requestRender();
  } else if (drag.kind === 'box') {
    drag.x1 = clamp(p.x, 0, pic.w);
    drag.y1 = clamp(p.y, 0, pic.h);
    requestRender();
  }
}

function onStageUp() {
  const d = drag;
  drag = null;
  stage.classList.remove('dragging');
  if (!d || !video) return;
  if (d.kind === 'pin' && d.moved) {
    pushUndo(d.before);
    // Moving a followed pin keeps it riding with the object, so the box itself stays.
    changed();
  } else if (d.kind === 'box') {
    const r = { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) };
    requestRender();
    if (r.w < 8 || r.h < 8) {
      if (r.w < 3 && r.h < 3 && tool === 'object' && !d.forId) return status("Потягни мишею, щоб обвести об'єкт рамкою.");
      return toast("Рамка замала — обведи об'єкт більшою рамкою");
    }
    const box = { x: r.x / pic.w, y: r.y / pic.h, w: r.w / pic.w, h: r.h / pic.h };
    if (d.forId && find(d.forId)) assignBox(find(d.forId), box);
    else createObjectNote(box);
  } else if (d.kind === 'newpin') {
    createPinNote(d.p.x / pic.w, d.p.y / pic.h);
  }
}

function onStageDblClick(e) {
  if (!video) return;
  const hit = hitTest(toPic(e));
  if (hit) openEditor(hit.id);
}

// Moves the pin as seen on frame f. A followed pin keeps riding with the box: its place relative to the box changes.
function setPinAt(note, x, y, f) {
  const at = note.box && note.track ? placeAt(note, f, { ignoreRange: true }) : null;
  if (at?.box && at.box.w > 0 && at.box.h > 0) {
    const u = (x - at.box.x) / at.box.w;
    const v = (y - at.box.y) / at.box.h;
    note.pin = { x: note.box.x + u * note.box.w, y: note.box.y + v * note.box.h };
  } else {
    note.pin = { x, y };
  }
}

// ---------- notes ----------

function newNote(extra) {
  const inF = cur;
  return {
    id: newId(),
    text: '',
    color: nextColor(review.notes),
    in: inF,
    out: Math.min(last(), inF + Math.round(3 * video.fps) - 1),
    pin: { x: 0.5, y: 0.5 },
    key: inF,
    box: null,
    showBox: true,
    track: null,
    ...extra,
  };
}

function createPinNote(x, y) {
  const before = snapshot();
  const note = newNote({ pin: { x: clamp(x, 0, 1), y: clamp(y, 0, 1) } });
  review.notes.push(note);
  selectedId = note.id;
  changed();
  openEditor(note.id, { isNew: true, before });
}

function createObjectNote(box) {
  const before = snapshot();
  const note = newNote({ box, pin: { x: box.x + box.w / 2, y: box.y } });
  review.notes.push(note);
  selectedId = note.id;
  queueTrack(note.id);
  changed();
  openEditor(note.id, { isNew: true, before });
}

function assignBox(note, box) {
  const before = snapshot();
  const p = placeAt(note, cur, { ignoreRange: true }).pin;
  abortTrack(note.id);
  tracks.state.delete(note.id);
  note.box = box;
  note.key = cur;
  // The pin stays where it is seen now, and from now on rides with the box.
  note.pin = { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) };
  note.track = null;
  note.showBox = true;
  boxFor = null;
  pushUndo(before);
  queueTrack(note.id);
  setTool(tool);
  changed();
}

function startBoxFor(id) {
  const note = find(id);
  if (!note) return;
  commitEditor();
  select(id);
  if (cur < note.in || cur > note.out) seek(note.key);
  boxFor = id;
  stage.classList.add('tool-object');
  status(`Обведи рамкою об'єкт, за яким стежитиме нотатка ${review.notes.indexOf(note) + 1}. Esc — скасувати.`);
}

function untrack(id) {
  const note = find(id);
  if (!note || !note.box) return;
  const before = snapshot();
  abortTrack(id);
  tracks.state.delete(id);
  const p = placeAt(note, cur, { ignoreRange: true }).pin;
  note.pin = { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) };
  note.box = null;
  note.track = null;
  pushUndo(before);
  changed();
}

function removeNote(id, { undo = true } = {}) {
  const i = review?.notes.findIndex(n => n.id === id) ?? -1;
  if (i < 0) return;
  const before = snapshot();
  abortTrack(id);
  tracks.state.delete(id);
  review.notes.splice(i, 1);
  if (undo) pushUndo(before);
  if (selectedId === id) selectedId = null;
  if (boxFor === id) boxFor = null;
  if (editing?.id === id) {
    editing = null;
    editor.hidden = true;
  }
  changed();
}

function select(id) {
  if (selectedId === id) return;
  selectedId = id;
  renderNotes();
  renderTimeline();
  requestRender();
  if (id) $(`.card[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
}

function setInOut(which) {
  const note = find(selectedId);
  if (!note) return status('Спершу вибери нотатку');
  const before = snapshot();
  if (which === 'in') {
    note.in = cur;
    if (note.out < cur) note.out = cur;
  } else {
    note.out = cur;
    if (note.in > cur) note.in = cur;
  }
  pushUndo(before);
  changed();
  const n = review.notes.indexOf(note) + 1;
  status(`${which === 'in' ? 'Початок' : 'Кінець'} нотатки ${n}: кадр ${cur + startNum()}`);
}

function jumpTo(id) {
  const note = find(id);
  if (!note) return;
  select(id);
  seek(note.key);
}

// ---------- inline text editor ----------

function openEditor(id, { isNew = false, before = null } = {}) {
  if (editing && editing.id !== id) commitEditor();
  const note = find(id);
  if (!note) return;
  stopPlayback();
  if (cur < note.in || cur > note.out) seek(note.key);
  editing = { id, isNew, before: before || snapshot(), startText: note.text };
  selectedId = id;
  editor.value = note.text;
  editor.style.setProperty('--c', note.color);
  editor.placeholder = 'Що виправити?';
  editor.hidden = false;
  render();
  renderNotes();
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
  status('Enter — готово · Shift+Enter — новий рядок · Esc — закінчити');
}

function placeEditor() {
  if (!editing) {
    editor.hidden = true;
    return;
  }
  const it = layout.find(l => l.id === editing.id);
  if (!it?.bubble) return;
  const m = it.metrics;
  const b = it.bubble;
  editor.hidden = false;
  Object.assign(editor.style, {
    left: `${pic.x + b.x + m.stripe + m.pad}px`,
    top: `${pic.y + b.y + m.pad}px`,
    width: `${Math.max(20, b.w - 2 * m.pad - m.stripe + 2)}px`,
    height: `${Math.max(m.line, b.h - 2 * m.pad + (m.line - m.font) * 0.5)}px`,
    fontSize: `${m.font}px`,
    lineHeight: `${m.line}px`,
  });
}

function commitEditor() {
  if (!editing) return;
  const ed = editing;
  editing = null;
  editor.hidden = true;
  if (document.activeElement === editor) editor.blur();
  const note = find(ed.id);
  if (note) {
    note.text = editor.value.replace(/^\s+|\s+$/g, '');
    if (!note.text) {
      // An empty note is no note: a new one disappears without a trace, an emptied one is an undoable delete.
      const i = review.notes.indexOf(note);
      abortTrack(note.id);
      tracks.state.delete(note.id);
      review.notes.splice(i, 1);
      if (!ed.isNew) pushUndo(ed.before);
      if (selectedId === note.id) selectedId = null;
      reconcileTracks();
    } else if (ed.isNew || note.text !== ed.startText) {
      pushUndo(ed.before);
    }
  }
  setTool(tool);
  changed();
}

// ---------- undo ----------

const snapshot = () => structuredClone(review?.notes || []);

function pushUndo(before) {
  undoStack.push(before);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack = [];
  updateButtons();
}

function undo() {
  commitEditor();
  if (!undoStack.length || !review) return;
  redoStack.push(snapshot());
  review.notes = undoStack.pop();
  afterRestore();
}

function redo() {
  commitEditor();
  if (!redoStack.length || !review) return;
  undoStack.push(snapshot());
  review.notes = redoStack.pop();
  afterRestore();
}

function afterRestore() {
  if (selectedId && !find(selectedId)) selectedId = null;
  if (boxFor && !find(boxFor)) boxFor = null;
  reconcileTracks();
  changed();
}

// ---------- tracking queue ----------

const trackSig = n => JSON.stringify([n.box, n.key]);

function queueTrack(id) {
  // A track being aborted (box redrawn) still holds the slot for a moment; the new one queues behind it.
  if (tracks.queue.includes(id) || (tracks.running?.id === id && !tracks.running.ctrl.signal.aborted)) return;
  tracks.queue.push(id);
  tracks.state.set(id, { status: 'queued', progress: 0 });
  pumpTracks();
}

function abortTrack(id) {
  tracks.queue = tracks.queue.filter(q => q !== id);
  if (tracks.running?.id === id) tracks.running.ctrl.abort();
}

function abortAllTracks() {
  tracks.queue = [];
  tracks.running?.ctrl.abort();
  tracks.state.clear();
}

// After undo / redo / loading: stop tracks whose box is gone or changed, start the ones that are missing.
function reconcileTracks() {
  if (!review) return;
  const r = tracks.running;
  if (r) {
    const n = find(r.id);
    if (!n || !n.box || trackSig(n) !== r.sig) r.ctrl.abort();
  }
  tracks.queue = tracks.queue.filter(id => find(id)?.box && !find(id).track);
  for (const [id] of tracks.state) if (!find(id)) tracks.state.delete(id);
  for (const n of review.notes) {
    if (n.box && !n.track && tracks.state.get(n.id)?.status !== 'failed') queueTrack(n.id);
  }
}

async function pumpTracks() {
  if (tracks.running || !video || !review) return;
  const id = tracks.queue.shift();
  if (!id) return;
  const note = find(id);
  if (!note || !note.box || note.track) {
    tracks.state.delete(id);
    return pumpTracks();
  }
  const ctrl = new AbortController();
  const sig = trackSig(note);
  const vref = video;
  const st = { status: 'running', progress: 0 };
  tracks.running = { id, ctrl, sig };
  tracks.state.set(id, st);
  updateTrackUI(id);
  let lastUI = 0;
  try {
    const result = await trackNote(vref, structuredClone(note), {
      signal: ctrl.signal,
      onProgress: p => {
        st.progress = p;
        const now = performance.now();
        if (now - lastUI > 120) {
          lastUI = now;
          updateTrackUI(id);
        }
      },
    });
    if (vref === video && !ctrl.signal.aborted) applyTrack(id, sig, result);
    if (tracks.state.get(id) === st) tracks.state.delete(id);
  } catch (err) {
    if (tracks.state.get(id) === st) tracks.state.delete(id);
    if (err?.name !== 'AbortError') {
      tracks.state.set(id, { status: 'failed', progress: 0 });
      ar.log('tracking failed:', err.stack || err.message);
      toast(`Трекінг не вдався: ${err.message}`, true);
    }
  } finally {
    tracks.running = null;
    if (vref === video) {
      renderNotes();
      renderTimeline();
      requestRender();
    }
    pumpTracks();
  }
}

// The finished track goes to the note and to the same note in the undo history, so undo never loses tracking.
function applyTrack(id, sig, result) {
  const patch = list => {
    for (const n of list) if (n.id === id && n.box && trackSig(n) === sig) n.track = result;
  };
  patch(review.notes);
  undoStack.forEach(patch);
  redoStack.forEach(patch);
  const n = find(id);
  if (n) {
    const lost = lostFrames(n);
    status(`Нотатка ${review.notes.indexOf(n) + 1}: стежить за об'єктом${lost ? `, загублено на ${lost} ${plural(lost, 'кадрі', 'кадрах', 'кадрах')}` : ''}`);
  }
  scheduleAutosave();
}

function trackStatus(note) {
  const st = tracks.state.get(note.id);
  if (st?.status === 'running') return { cls: '', text: `трекінг… ${Math.round(st.progress * 100)}%`, bar: st.progress };
  if (st?.status === 'queued') return { cls: '', text: 'трекінг… (у черзі)' };
  if (st?.status === 'failed') return { cls: 'bad', text: 'трекінг не вдався' };
  if (!note.box) return null;
  if (!note.track) return { cls: '', text: 'трекінг…' };
  const lost = lostFrames(note);
  const q = Math.round(trackQuality(note) * 100);
  if (lost) return { cls: 'bad', text: `стежить · ${q}% · загублено на ${lost} ${plural(lost, 'кадрі', 'кадрах', 'кадрах')}` };
  return { cls: 'ok', text: `стежить · ${q}%` };
}

function trackHTML(note) {
  const t = trackStatus(note);
  if (!t) return '';
  const bar = t.bar !== undefined ? `<span class="bar"><i style="width:${Math.round(t.bar * 100)}%"></i></span>` : '';
  return `<span>${esc(t.text)}</span>${bar}`;
}

function updateTrackUI(id) {
  const note = find(id);
  const el = $(`.card[data-id="${id}"] .track`);
  if (note && el) {
    const t = trackStatus(note);
    el.className = `track ${t?.cls || ''}`;
    el.innerHTML = trackHTML(note);
  } else {
    renderNotes();
  }
  renderTimeline();
}

async function waitTracks(signal) {
  while (tracks.running || tracks.queue.length) {
    if (signal?.aborted) throw new DOMException('Скасовано', 'AbortError');
    const st = tracks.running && tracks.state.get(tracks.running.id);
    if (st) busyProgress(st.progress, `Чекаю на трекінг… ${Math.round(st.progress * 100)}%`);
    await sleep(80);
  }
}

// ---------- notes panel ----------

function renderNotes() {
  const list = $('#notes');
  const notes = review?.notes || [];
  $('#noteCount').textContent = notes.length ? String(notes.length) : '';
  $('#notesEmpty').hidden = !!notes.length;
  const fps = video?.fps || 25;
  const s = startNum();
  list.innerHTML = notes.map((n, i) => {
    const range = n.out > n.in ? `кадр ${n.in + s}–${n.out + s}` : `кадр ${n.in + s}`;
    const t = trackStatus(n);
    const text = n.text ? esc(n.text) : 'Без тексту — клікни, щоб написати';
    const actions = n.box
      ? `<button data-act="untrack" title="Пін більше не їде за об'єктом">Не стежити</button>
         <label title="Показувати рамку навколо об'єкта"><input type="checkbox" data-act="showbox" ${n.showBox ? 'checked' : ''}>Рамка</label>
         <button data-act="track" title="Обвести об'єкт заново на поточному кадрі">Обвести заново</button>`
      : `<button data-act="track" title="Обведи об'єкт рамкою — пін поїде за ним">Стежити за об'єктом</button>`;
    return `<div class="card${n.id === selectedId ? ' sel' : ''}" data-id="${n.id}" style="--c:${n.color}">
      <div class="head"><span class="num">${i + 1}</span><span class="range">${range} · ${timecode(n.in, fps)}</span>
        <button class="x" data-act="del" title="Видалити нотатку (Delete)">×</button></div>
      <div class="text${n.text ? '' : ' empty'}" data-act="edit" title="Клікни, щоб редагувати">${text}</div>
      ${t ? `<div class="track ${t.cls}">${trackHTML(n)}</div>` : ''}
      <div class="actions">${actions}</div>
    </div>`;
  }).join('');
}

function onNotesClick(e) {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.closest('label')) return; // the box toggle: its change event does the work
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'del') return removeNote(id);
  if (act === 'edit') {
    jumpTo(id);
    return openEditor(id);
  }
  if (act === 'track') return startBoxFor(id);
  if (act === 'untrack') return untrack(id);
  if (act === 'showbox') return; // handled on change
  if (editing) commitEditor();
  jumpTo(id);
}

function onNotesChange(e) {
  if (e.target.dataset.act !== 'showbox') return;
  const note = find(e.target.closest('.card').dataset.id);
  if (!note) return;
  const before = snapshot();
  note.showBox = e.target.checked;
  pushUndo(before);
  changed();
}

// ---------- timeline ----------

const TL = { padX: 10, ruler: 20, lane: 18, bar: 10 };
const TICK_STEPS = [1, 2, 5, 10, 12, 24, 25, 30, 48, 50, 60, 100, 120, 240, 250, 300, 500, 600, 1000, 1200, 2400, 3000, 6000, 12000];

function tlGeom() {
  const w = tl.clientWidth || 1;
  const n = video ? video.frameCount : 1;
  const cw = (w - 2 * TL.padX) / n;
  return { w, n, cw, x: f => TL.padX + f * cw, frameAt: x => clamp(Math.floor((x - TL.padX) / cw), 0, n - 1) };
}

function renderTimeline() {
  const dpr = devicePixelRatio || 1;
  const lanes = Math.max(1, review?.notes.length || 0);
  const cssW = Math.max(50, tlWrap.clientWidth - 20);
  const cssH = TL.ruler + lanes * TL.lane + 6;
  tl.style.height = `${cssH}px`;
  if (tl.width !== Math.round(cssW * dpr) || tl.height !== Math.round(cssH * dpr)) {
    tl.width = Math.round(cssW * dpr);
    tl.height = Math.round(cssH * dpr);
  }
  const c = tctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, cssW, cssH);
  c.fillStyle = '#15171c';
  c.fillRect(0, 0, cssW, TL.ruler);
  if (!video || !review) return;
  const g = tlGeom();
  const s = startNum();

  // Ruler: labels at a round step at least ~70 px apart, minor ticks between.
  const step = TICK_STEPS.find(t => t * g.cw >= 70) || TICK_STEPS[TICK_STEPS.length - 1];
  const minor = TICK_STEPS.slice().reverse().find(t => t < step && step % t === 0 && t * g.cw >= 7);
  c.font = '10px "Segoe UI", system-ui, sans-serif';
  c.textBaseline = 'top';
  c.fillStyle = '#8b91a0';
  c.strokeStyle = '#3a404c';
  c.lineWidth = 1;
  c.beginPath();
  if (minor) for (let f = 0; f < g.n; f += minor) {
    const x = Math.round(g.x(f)) + 0.5;
    c.moveTo(x, TL.ruler - 4);
    c.lineTo(x, TL.ruler);
  }
  for (let f = 0; f < g.n; f += step) {
    const x = Math.round(g.x(f)) + 0.5;
    c.moveTo(x, TL.ruler - 9);
    c.lineTo(x, TL.ruler);
    c.fillText(String(f + s), x + 3, 2);
  }
  c.stroke();

  review.notes.forEach((n, i) => {
    const y = TL.ruler + i * TL.lane + 3;
    if (i % 2) {
      c.fillStyle = 'rgba(255, 255, 255, 0.025)';
      c.fillRect(0, y - 3, cssW, TL.lane);
    }
    const x0 = g.x(n.in);
    const x1 = Math.max(g.x(n.out + 1), x0 + 3);
    const sel = n.id === selectedId;
    c.globalAlpha = sel ? 1 : 0.78;
    c.fillStyle = n.color;
    c.beginPath();
    c.roundRect(x0, y, x1 - x0, TL.bar, 3);
    c.fill();
    c.globalAlpha = 1;
    if (sel) {
      c.strokeStyle = '#fff';
      c.lineWidth = 1.5;
      c.stroke();
      // grips on the ends
      c.fillStyle = '#fff';
      c.fillRect(x0 - 1, y - 2, 3, TL.bar + 4);
      c.fillRect(x1 - 2, y - 2, 3, TL.bar + 4);
    }
    if (x1 - x0 > 16) {
      c.fillStyle = '#14161b';
      c.font = '700 9px "Segoe UI", system-ui, sans-serif';
      c.fillText(String(i + 1), x0 + 4, y + 0.5);
    }
    // the frame where the pin was put
    const kx = g.x(n.key) + g.cw / 2;
    c.fillStyle = 'rgba(255, 255, 255, 0.9)';
    c.beginPath();
    c.arc(kx, y + TL.bar / 2, 2, 0, Math.PI * 2);
    c.fill();

    // Tracking stripe under the bar: tracked frames in the note colour, lost frames red.
    const sy = y + TL.bar + 1.5;
    const st = tracks.state.get(n.id);
    if (st?.status === 'running' || st?.status === 'queued') {
      c.fillStyle = '#2f3440';
      c.fillRect(TL.padX, sy, g.w - 2 * TL.padX, 3);
      c.fillStyle = n.color;
      c.globalAlpha = 0.7;
      c.fillRect(TL.padX, sy, (g.w - 2 * TL.padX) * (st.progress || 0), 3);
      c.globalAlpha = 1;
    } else if (n.track) {
      const b = n.track.boxes;
      let runStart = 0;
      for (let k = 1; k <= b.length; k++) {
        if (k < b.length && !b[k] === !b[runStart]) continue;
        c.fillStyle = b[runStart] ? n.color : '#ff3b30';
        c.globalAlpha = b[runStart] ? 0.55 : 1;
        const fx0 = g.x(n.track.from + runStart);
        c.fillRect(fx0, sy, Math.max(1, g.x(n.track.from + k) - fx0), 3);
        runStart = k;
      }
      c.globalAlpha = 1;
    }
  });

  // Playhead
  const px = Math.round(g.x(cur) + g.cw / 2);
  c.fillStyle = '#ff5a4e';
  c.fillRect(px - 1, 0, 2, cssH);
  c.beginPath();
  c.roundRect(px - 5, 0, 10, 8, 2);
  c.fill();
}

function tlHit(e) {
  const r = tl.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  const g = tlGeom();
  const f = g.frameAt(x);
  if (y < TL.ruler || !review) return { f };
  const i = Math.floor((y - TL.ruler) / TL.lane);
  const n = review.notes[i];
  if (!n) return { f };
  const x0 = g.x(n.in);
  const x1 = Math.max(g.x(n.out + 1), x0 + 3);
  const grip = Math.min(6, Math.max(3, (x1 - x0) / 3));
  if (Math.abs(x - x0) <= grip) return { f, note: n, mode: 'in' };
  if (Math.abs(x - x1) <= grip) return { f, note: n, mode: 'out' };
  if (x > x0 && x < x1) return { f, note: n, mode: 'move' };
  return { f };
}

function onTlDown(e) {
  if (e.button !== 0 || !video) return;
  commitEditor();
  stopPlayback();
  tl.setPointerCapture(e.pointerId);
  const h = tlHit(e);
  if (h.note) {
    select(h.note.id);
    drag = { kind: 'tl', mode: h.mode, id: h.note.id, f0: h.f, in0: h.note.in, out0: h.note.out, before: snapshot(), moved: false };
    if (h.mode === 'move') seek(h.f);
    return;
  }
  drag = { kind: 'scrub' };
  seek(h.f);
}

function onTlMove(e) {
  if (!video) return;
  if (!drag || (drag.kind !== 'tl' && drag.kind !== 'scrub')) {
    const h = tlHit(e);
    tl.style.cursor = h.mode === 'in' || h.mode === 'out' ? 'ew-resize' : h.mode === 'move' ? 'grab' : 'pointer';
    return;
  }
  const f = tlGeom().frameAt(e.clientX - tl.getBoundingClientRect().left);
  if (drag.kind === 'scrub') return seek(f);
  const n = find(drag.id);
  if (!n) return;
  if (drag.mode === 'in') n.in = Math.min(f, n.out);
  else if (drag.mode === 'out') n.out = Math.max(f, n.in);
  else {
    const d = clamp(f - drag.f0, -drag.in0, last() - drag.out0);
    n.in = drag.in0 + d;
    n.out = drag.out0 + d;
  }
  const moved = n.in !== drag.in0 || n.out !== drag.out0;
  drag.moved = drag.moved || moved;
  if (drag.mode !== 'move') seek(drag.mode === 'in' ? n.in : n.out);
  renderTimeline();
  renderNotes();
  requestRender();
}

function onTlUp() {
  const d = drag;
  if (!d || (d.kind !== 'tl' && d.kind !== 'scrub')) return;
  drag = null;
  if (d.kind === 'tl' && d.moved) {
    pushUndo(d.before);
    changed();
  }
}

// ---------- frames and playback ----------

function seek(f) {
  if (!video) return;
  f = clamp(Math.round(f), 0, last());
  if (playing) stopPlayback(false);
  cur = f;
  video.show(f);
  const ahead = [];
  for (let k = 1; k <= 4; k++) ahead.push(f + k);
  ahead.push(f - 1);
  video.prefetch(ahead);
  updateInfo();
  renderTimeline();
  requestRender();
}

function updateInfo() {
  if (!video) {
    $('#frameInfo').textContent = '';
    return;
  }
  const s = startNum();
  $('#frameInfo').innerHTML = `кадр <b>${cur + s}</b> / ${last() + s} · <b>${timecode(cur, video.fps)}</b> · ${fmtFps(video.fps)} к/с`;
}

let playing = null;
const clock = () => (playing ? playing.from / video.fps + (performance.now() - playing.t0) / 1000 : 0);
const PLAY_ICON = '<svg viewBox="0 0 24 24"><path class="fill" d="M8 5.5v13l10.5-6.5z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24"><path class="fill" d="M7 5.5h3.5v13H7zM13.5 5.5H17v13h-3.5z"/></svg>';

function play() {
  if (playing || !video) return;
  commitEditor();
  const from = cur >= last() ? 0 : cur;
  playing = { t0: performance.now(), from };
  $('#playBtn').classList.add('on');
  $('#playBtn').innerHTML = PAUSE_ICON;
  startMedia(from);
  requestAnimationFrame(playLoop);
}

function startMedia(from) {
  video.play(from, clock);
  if (video.hasAudio && audio.src) {
    audio.currentTime = Math.max(0, from / video.fps);
    audio.play().catch(() => {});
  }
}

function playLoop() {
  if (!playing) return;
  const f = Math.floor(clock() * video.fps + 1e-6);
  if (f >= video.frameCount) {
    // Reviews loop: the shot plays round until paused.
    video.stop();
    audio.pause();
    playing.t0 = performance.now();
    playing.from = 0;
    startMedia(0);
  }
  requestAnimationFrame(playLoop);
}

function stopPlayback(show = true) {
  if (!playing) return;
  playing = null;
  video?.stop();
  audio.pause();
  $('#playBtn').classList.remove('on');
  $('#playBtn').innerHTML = PLAY_ICON;
  if (show && video) seek(cur);
}

const togglePlay = () => (playing ? stopPlayback() : play());

// ---------- change bookkeeping, autosave ----------

function changed() {
  requestRender();
  renderNotes();
  renderTimeline();
  updateButtons();
  scheduleAutosave();
}

function updateButtons() {
  const has = !!video;
  $('#undoBtn').disabled = !undoStack.length;
  $('#redoBtn').disabled = !redoStack.length;
  $('#saveBtn').disabled = !has;
  $('#copyBtn').disabled = !has;
  $('#copyTextBtn').disabled = !has || !review?.notes.length;
  $$('#transport button').forEach(b => { b.disabled = !has; });
}

function serialize() {
  return { format: 'artreview', version: 1, video: { ...review.video }, startFrame: review.startFrame, notes: review.notes };
}

async function hashKey(path, size) {
  const bytes = new TextEncoder().encode(`${path}|${size}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

let autosaveTimer = 0;
function scheduleAutosave() {
  if (!review || !reviewKey) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosaveNow, 400);
}

async function autosaveNow() {
  clearTimeout(autosaveTimer);
  if (!review || !reviewKey) return;
  if (!review.notes.length && !autosaveExists) return; // nothing to keep, nothing to overwrite
  try {
    await ar.reviewAutosave(reviewKey, JSON.stringify(serialize()));
    autosaveExists = true;
  } catch (err) {
    ar.log('autosave failed:', err.message);
  }
}

// ---------- open / save ----------

async function openPath(path) {
  if (!path) return;
  if (REVIEW_EXT.test(path)) return openReviewFile(path);
  return openVideoFile(path);
}

async function openVideoDialog() {
  const path = await ar.openDialog('video');
  if (path) await guarded(() => openVideoFile(path));
}

async function openVideoFile(path, { data = null } = {}) {
  stopPlayback(false);
  commitEditor();
  await autosaveNow();
  status(`Відкриваю ${basename(path)}…`);
  const v = await openVideo(path);
  abortAllTracks();
  video?.dispose();
  video = v;
  video.onFrame = onFrame;
  review = {
    format: 'artreview',
    version: 1,
    video: { name: v.name, path, size: v.size, width: v.width, height: v.height, fps: v.fps, frameCount: v.frameCount },
    startFrame: settings.startFrame ?? 1,
    notes: [],
  };
  undoStack = [];
  redoStack = [];
  selectedId = null;
  boxFor = null;
  lastExport = null;
  $('#chip').hidden = true;
  cur = 0;
  frameCanvas = null;
  reviewKey = await hashKey(path, v.size);
  autosaveExists = false;
  let restored = false;
  const incoming = data || pendingReview;
  pendingReview = null;
  const saved = await ar.reviewAutoload(reviewKey).catch(() => null);
  if (saved) autosaveExists = true;
  if (incoming) {
    applyReviewData(incoming, false);
  } else if (saved) {
    try {
      const d = typeof saved === 'string' ? JSON.parse(saved) : saved;
      review.notes = normalizeNotes(d.notes, v.frameCount);
      if (Number.isInteger(d.startFrame)) review.startFrame = d.startFrame;
      restored = review.notes.length > 0;
    } catch (err) {
      ar.log('autosave unreadable:', err.message);
    }
  }
  audio.src = v.hasAudio ? await ar.fileURL(path) : '';
  if (!v.hasAudio) audio.removeAttribute('src');
  const title = `ArtReview — ${v.name}`;
  ar.setTitle(title);
  document.title = title;
  $('#empty').hidden = true;
  fitStage();
  seek(0);
  reconcileTracks();
  changed();
  status(`${v.name} · ${v.width}×${v.height} · ${fmtFps(v.fps)} к/с · ${v.frameCount} ${plural(v.frameCount, 'кадр', 'кадри', 'кадрів')}${v.hasAudio ? ' · зі звуком' : ''}`);
  if (restored) toast('Нотатки відновлено');
  else if (incoming) toast(`Відкрито нотатки: ${nNotes(review.notes.length)}`);
  return v;
}

function applyReviewData(data, undoable) {
  if (undoable) pushUndo(snapshot());
  abortAllTracks();
  review.notes = normalizeNotes(data.notes, video.frameCount);
  if (Number.isInteger(data.startFrame)) review.startFrame = data.startFrame;
  selectedId = null;
  reconcileTracks();
  changed();
  updateInfo();
}

async function openReviewFile(path) {
  const bytes = await ar.read(path);
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Не вдалося прочитати файл нотаток');
  }
  if (data?.format !== 'artreview' || !Array.isArray(data.notes)) throw new Error('Це не файл нотаток ArtReview');
  const rv = data.video || {};
  if (video && (video.file === rv.path || (video.name === rv.name && video.size === rv.size))) {
    applyReviewData(data, true);
    toast(`Відкрито нотатки: ${nNotes(review.notes.length)}`);
    return;
  }
  const candidates = [rv.path, rv.name && `${dirname(path)}${path.includes('\\') ? '\\' : '/'}${rv.name}`].filter(Boolean);
  for (const p of candidates) {
    if (await ar.stat(p)) return openVideoFile(p, { data });
  }
  if (video) {
    applyReviewData(data, true);
    toast(`Відео «${rv.name || '?'}» не знайдено — нотатки накладено на поточне відео`);
    return;
  }
  pendingReview = data;
  toast(`Не знайдено відео «${rv.name || '?'}». Відкрий його — нотатки підхопляться.`, true);
}

async function openReviewDialog() {
  const path = await ar.openDialog('review');
  if (path) await guarded(() => openReviewFile(path));
}

async function saveReviewTo(path) {
  await ar.write(path, new TextEncoder().encode(JSON.stringify(serialize(), null, 1)));
  return path;
}

async function saveReview() {
  if (!review) return toast('Спершу відкрий відео', true);
  commitEditor();
  const name = `${review.video.name.replace(/\.[^.]+$/, '')}.artreview`;
  const path = await ar.saveDialog('review', name);
  if (!path) return;
  await saveReviewTo(path);
  toast(`Збережено: ${basename(path)}`);
  status(`Нотатки збережено: ${path}`, 'ok');
}

// ---------- export and clipboard ----------

function exportSig() {
  return JSON.stringify({
    path: video.file,
    notes: review.notes,
    startFrame: review.startFrame,
    s: [settings.maxSize, settings.endCard, settings.hud, settings.audio, settings.outDir],
  });
}

function busyProgress(p, text) {
  $('#busyBar').style.width = `${Math.round(clamp(p, 0, 1) * 100)}%`;
  if (text !== undefined) $('#busyText').textContent = text;
}

async function exportIfNeeded() {
  if (lastExport?.sig === exportSig() && (await ar.stat(lastExport.result.file))) return lastExport.result;
  const ctrl = new AbortController();
  exporting = ctrl;
  $('#busyTitle').textContent = 'Готую відео з нотатками…';
  busyProgress(0, '');
  $('#busy').hidden = false;
  try {
    if (tracks.running || tracks.queue.length) await waitTracks(ctrl.signal);
    busyProgress(0, '0%');
    const sig = exportSig();
    const t0 = performance.now();
    const result = await runExport(structuredClone(review), video, settings, {
      signal: ctrl.signal,
      onProgress: p => busyProgress(p, `${Math.round(p * 100)}%`),
    });
    lastExport = { sig, result };
    showChip(result.file);
    ar.log(`export ${((performance.now() - t0) / 1000).toFixed(1)} s: ${result.file} ${result.width}x${result.height} ${result.codec} audio=${result.audio}`);
    return result;
  } catch (err) {
    if (err?.name === 'AbortError') {
      toast('Експорт скасовано');
      status('Експорт скасовано');
      return null;
    }
    throw new Error(`Не вдалося зробити відео: ${err.message}`);
  } finally {
    exporting = null;
    $('#busy').hidden = true;
  }
}

async function copyVideo() {
  if (!video) {
    toast('Спершу відкрий відео', true);
    return null;
  }
  if (exporting) return null;
  commitEditor();
  stopPlayback();
  const result = await exportIfNeeded();
  if (!result) return null;
  const text = notesText(review, settings);
  const wantText = settings.copyTextWithVideo !== false;
  let res;
  try {
    res = await ar.copyVideo(result.file, wantText ? text : null);
  } catch (err) {
    ar.log('copy failed:', err.message);
    res = { ok: false, withText: false };
  }
  lastClipboard = { file: res?.ok ? result.file : null, text: res?.withText ? text : null, ok: !!res?.ok };
  let msg;
  if (res?.ok) {
    msg = res.withText ? 'Скопійовано: відео + текст. Встав у чат (Ctrl+V)' : 'Скопійовано відео. Встав у чат (Ctrl+V)';
    if (wantText && !res.withText) msg += ' · текст — кнопкою «Копіювати текст»';
    status(msg, 'ok');
    toast(msg);
  } else {
    msg = 'Не вдалося покласти відео в буфер. Перетягни його в чат з кнопки ⇱ угорі.';
    status(msg, 'err');
    toast(msg, true);
  }
  return { export: result, copy: res };
}

async function copyText() {
  if (!review) return;
  commitEditor();
  const text = notesText(review, settings);
  await ar.copyText(text);
  lastClipboard = { file: null, text, ok: true };
  toast('Скопійовано текст нотаток');
  status('Текст нотаток у буфері. Встав у чат (Ctrl+V)', 'ok');
}

function showChip(file) {
  const chip = $('#chip');
  chip.textContent = `⇱ ${basename(file)}`;
  chip.dataset.file = file;
  chip.hidden = false;
}

// ---------- settings popover ----------

async function refreshSettingsUI() {
  const def = await ar.defaultOutDir().catch(() => '');
  $('#outDir').textContent = settings.outDir || `${def} (за замовчуванням)`;
  $('#outDir').title = settings.outDir || def;
  $$('#sizeSeg button').forEach(b => b.classList.toggle('on', +b.dataset.size === (+settings.maxSize || 0)));
  $$('#settings [data-s]').forEach(i => { i.checked = settings[i.dataset.s] !== false; });
  const sf = startNum();
  $$('#startSeg button').forEach(b => b.classList.toggle('on', +b.dataset.start === sf));
  $('#startNum').value = sf;
  $('#startNum').classList.toggle('on', sf !== 1 && sf !== 1001);
}

async function setSettings(patch) {
  const next = await ar.setSettings(patch).catch(() => null);
  settings = next ? { ...settings, ...next } : { ...settings, ...patch };
  refreshSettingsUI();
}

async function setStartFrame(v) {
  v = Math.max(0, Math.round(+v || 0));
  await setSettings({ startFrame: v });
  if (review) {
    review.startFrame = v;
    changed();
    updateInfo();
  }
  refreshSettingsUI();
}

function toggleSettings() {
  const pop = $('#settings');
  if (pop.hidden) {
    refreshSettingsUI();
    pop.hidden = false;
  } else {
    pop.hidden = true;
  }
}

function closeSettings() {
  $('#settings').hidden = true;
}

// ---------- tools ----------

function setTool(name) {
  if (!TOOL_HINTS[name]) return;
  tool = name;
  if (boxFor && name !== 'object') boxFor = null;
  $$('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === name));
  stage.classList.remove('tool-pin', 'tool-object', 'tool-select');
  stage.classList.add(`tool-${name}`);
  if (video && !editing) status(TOOL_HINTS[name]);
}

// ---------- wiring ----------

function wire() {
  const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);
  $$('#tools button').forEach(b => { b.onclick = () => { commitEditor(); setTool(b.dataset.tool); }; });
  on('#openBtn', 'click', openVideoDialog);
  on('#emptyOpen', 'click', openVideoDialog);
  on('#undoBtn', 'click', undo);
  on('#redoBtn', 'click', redo);
  on('#saveBtn', 'click', () => guarded(saveReview));
  on('#loadBtn', 'click', openReviewDialog);
  on('#settingsBtn', 'click', toggleSettings);
  on('#donateBtn', 'click', () => ar.openDonate());
  on('#copyBtn', 'click', () => guarded(copyVideo));
  on('#copyTextBtn', 'click', () => guarded(copyText));
  on('#busyCancel', 'click', () => exporting?.abort());
  on('#chip', 'click', () => $('#chip').dataset.file && ar.reveal($('#chip').dataset.file));
  on('#chip', 'dragstart', e => {
    e.preventDefault();
    if ($('#chip').dataset.file) ar.dragOut($('#chip').dataset.file);
  });

  on('#outDirBtn', 'click', async () => {
    const dir = await ar.folderDialog();
    if (dir) await setSettings({ outDir: dir });
  });
  $$('#sizeSeg button').forEach(b => { b.onclick = () => setSettings({ maxSize: +b.dataset.size }); });
  $$('#settings [data-s]').forEach(i => { i.onchange = () => setSettings({ [i.dataset.s]: i.checked }); });
  $$('#startSeg button').forEach(b => { b.onclick = () => setStartFrame(+b.dataset.start); });
  on('#startNum', 'change', e => setStartFrame(e.target.value));
  addEventListener('pointerdown', e => {
    if (!$('#settings').hidden && !e.target.closest('#settings, #settingsBtn')) closeSettings();
  });

  view.addEventListener('pointerdown', onStageDown);
  view.addEventListener('pointermove', onStageMove);
  view.addEventListener('pointerup', onStageUp);
  view.addEventListener('pointercancel', onStageUp);
  view.addEventListener('dblclick', onStageDblClick);
  view.addEventListener('pointerleave', () => stage.classList.remove('over-note'));

  editor.addEventListener('input', () => {
    const note = editing && find(editing.id);
    if (!note) return;
    note.text = editor.value;
    requestRender();
    const t = $(`.card[data-id="${note.id}"] .text`);
    if (t) {
      t.textContent = note.text || 'Без тексту — клікни, щоб написати';
      t.classList.toggle('empty', !note.text);
    }
    scheduleAutosave();
  });
  editor.addEventListener('keydown', e => {
    e.stopPropagation(); // letters typed here are text, not shortcuts
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyC') {
      e.preventDefault();
      commitEditor();
      guarded(copyVideo);
      return;
    }
    if ((e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') && !e.shiftKey) {
      e.preventDefault();
      commitEditor();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      commitEditor();
    }
  });
  editor.addEventListener('blur', () => {
    // Focus may leave for a moment (window switch); only a real move elsewhere ends the edit.
    setTimeout(() => {
      if (editing && document.activeElement !== editor && document.hasFocus()) commitEditor();
    }, 0);
  });

  on('#notes', 'click', onNotesClick);
  on('#notes', 'change', onNotesChange);

  tl.addEventListener('pointerdown', onTlDown);
  tl.addEventListener('pointermove', onTlMove);
  tl.addEventListener('pointerup', onTlUp);
  tl.addEventListener('pointercancel', onTlUp);

  on('#firstBtn', 'click', () => seek(0));
  on('#prevBtn', 'click', () => seek(cur - 1));
  on('#playBtn', 'click', togglePlay);
  on('#nextBtn', 'click', () => seek(cur + 1));
  on('#lastBtn', 'click', () => seek(last()));

  // Buttons and toggles must not keep focus: Space and letters belong to the review.
  document.addEventListener('pointerup', () => {
    const a = document.activeElement;
    if (a?.matches?.('button, input[type=checkbox]')) a.blur();
  });

  new ResizeObserver(() => {
    fitStage();
    renderTimeline();
  }).observe(stage);
  new ResizeObserver(() => renderTimeline()).observe(tlWrap);

  // Drop a video or a .artreview onto the window.
  let dragDepth = 0;
  addEventListener('dragenter', e => {
    e.preventDefault();
    dragDepth++;
    stage.classList.add('drop');
  });
  addEventListener('dragleave', () => {
    if (--dragDepth <= 0) stage.classList.remove('drop');
  });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    stage.classList.remove('drop');
    const file = e.dataTransfer.files[0];
    const p = file && ar.pathForFile(file);
    if (!p) return;
    if (!REVIEW_EXT.test(p) && !VIDEO_EXT.test(p)) {
      toast('Підтримуються відео (MP4, MOV, M4V, WebM, MKV) і нотатки .artreview', true);
      return;
    }
    guarded(() => openPath(p));
  });

  addEventListener('beforeunload', () => {
    if (editing) {
      const n = find(editing.id);
      if (n) n.text = editor.value;
    }
    autosaveNow();
  });
}

// ---------- keyboard ----------

const typing = t => t?.matches?.('input[type=number], input[type=text], textarea, select');

addEventListener('keydown', e => {
  if (e.target === editor) return;
  if (typing(e.target)) {
    if (e.key === 'Escape' || e.key === 'Enter') e.target.blur();
    return;
  }
  if (!$('#busy').hidden) {
    if (e.code === 'Escape') exporting?.abort();
    e.preventDefault();
    return;
  }
  const k = e.code;
  const ctrl = e.ctrlKey || e.metaKey;
  let handled = true;
  if (ctrl) {
    if (k === 'KeyZ') e.shiftKey ? redo() : undo();
    else if (k === 'KeyY') redo();
    else if (k === 'KeyC' && e.shiftKey) guarded(copyVideo);
    else if (k === 'KeyS') guarded(saveReview);
    else if (k === 'KeyO') openVideoDialog();
    else handled = false;
  } else if (e.altKey) {
    handled = false;
  } else if (k === 'Space') {
    if (!e.repeat) togglePlay();
  } else if (k === 'ArrowLeft') seek(cur - (e.shiftKey ? 10 : 1));
  else if (k === 'ArrowRight') seek(cur + (e.shiftKey ? 10 : 1));
  else if (k === 'Home') seek(0);
  else if (k === 'End') seek(last());
  else if (k === 'KeyP') setTool('pin');
  else if (k === 'KeyV') setTool('select');
  else if (k === 'KeyI') setInOut('in');
  // O sets the end of the selected note; with nothing selected it is the Object tool.
  else if (k === 'KeyO') (selectedId && find(selectedId) ? setInOut('out') : setTool('object'));
  else if (k === 'Delete' || k === 'Backspace') {
    if (selectedId) removeNote(selectedId);
  } else if (k === 'Enter' || k === 'NumpadEnter') {
    if (selectedId) openEditor(selectedId);
  } else if (k === 'Escape') {
    if (!$('#settings').hidden) closeSettings();
    else if (boxFor) {
      boxFor = null;
      setTool(tool);
      status("Обведення скасовано");
    } else select(null);
  } else handled = false;
  if (handled) {
    e.preventDefault();
    if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();
  }
});

// ---------- start ----------

async function start() {
  wire();
  settings = { ...settings, ...((await ar.settings().catch(() => null)) || {}) };
  setTool('pin');
  updateButtons();
  renderNotes();
  fitStage();
  renderTimeline();
  status('Відкрий відео або перетягни його у вікно.');
  ar.donateAvailable?.().then(v => { $('#donateBtn').hidden = !v; }).catch(() => {});
  ar.onOpenFile(p => guarded(() => openPath(p)));
  const pending = await ar.pendingFile().catch(() => null);
  if (pending) await guarded(() => openPath(pending));
}

start();

// Handle for the self-test (selftest.js drives real input and reads state through it).
window.__ar = {
  get review() { return review; },
  get cur() { return cur; },
  get video() { return video; },
  get lastClipboard() { return lastClipboard; },
  get undoDepth() { return undoStack.length; },
  get selectedId() { return selectedId; },
  get editingId() { return editing?.id || null; },
  get settings() { return settings; },
  open: path => openPath(path),
  // Resolves once the frame is on screen.
  seek: async f => {
    seek(f);
    for (let i = 0; i < 200 && video && video.shown !== cur; i++) await sleep(10);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return cur;
  },
  tool: name => setTool(name),
  stageRect: () => {
    const r = view.getBoundingClientRect();
    const x = r.left + pic.x;
    const y = r.top + pic.y;
    return { x, y, left: x, top: y, width: pic.w, height: pic.h, right: x + pic.w, bottom: y + pic.h };
  },
  waitIdle: async () => {
    while (tracks.running || tracks.queue.length || exporting) await sleep(50);
  },
  exportNow: () => copyVideo(),
  // extras for the self-test: save without the dialog, start from no notes
  saveTo: path => saveReviewTo(path),
  clearNotes: () => {
    if (!review) return;
    pushUndo(snapshot());
    abortAllTracks();
    review.notes = [];
    selectedId = null;
    changed();
  },
  flushAutosave: () => autosaveNow(),
};
