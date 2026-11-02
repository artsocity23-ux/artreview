# ArtReview — specification v0.1

ArtReview is a small desktop app for art-direction notes on a video shot. You open a shot, put numbered pins with
comments on it (a pin can follow an object through the shot), press one button, and paste (Ctrl+V) a ready MP4
with the notes burned in — plus the notes as text — into a messenger (Telegram, Slack, WhatsApp desktop).

Audience: VFX / animation artists and their clients. The person making notes is often NOT technical (a client, a
director). **The interface must be very simple**: open video → click → type → copy. Everything else is secondary.

Sibling apps by the same author (same look, same stack): `C:\Tools\ArtFrames` (frame-by-frame animation; video
decode/encode with mediabunny; read it for patterns), `C:\Tools\ArtNote` (screenshot + pin comments; the pin look
and the "everything goes to the clipboard" idea come from there). ArtReview started as a copy of ArtFrames.

## Stack (fixed)

* Electron 45 (already in `node_modules`), no bundler, no new npm packages, **no downloads**. Renderer = plain ES
  modules. Video decode/encode: `node_modules/mediabunny/dist/bundles/mediabunny.min.mjs` (WebCodecs).
* Tracking is our own JS code (no neural network, no model files): pyramidal Lucas–Kanade "median flow" plus NCC
  template re-detection. Runs in a module Web Worker.
* All UI text is **Ukrainian**. Code comments in English, matching the sibling apps' style (short, explain *why*).
* Keyboard shortcuts use `e.code` (so they work on the Ukrainian layout).
* Dark theme like ArtFrames (`app.css` tokens: --bg #15171c, --panel #1c1f26, --accent #ff5a4e, …).
* Everything must work offline.

## Files and ownership

```
main.js            main process: window, dialogs, file IO, byte ranges for the decoder, settings, clipboard, drag-out
preload.js         window.ar bridge (exact API below)
index.html         layout
app.css            styles
src/app.js         UI state, editing, timeline, playback, keyboard, undo, save/load, wiring
src/video.js       video open + exact frame access (adapted from ArtFrames src/video.js; no project "ticks": frame = video frame)
src/overlay.js     drawOverlay(): the ONE renderer for notes, used by the live preview AND by the export
src/export.js      runExport(): MP4 with notes burned in (+ end card, + audio) and the notes text / markdown
src/notes.js       note model helpers: positions per frame, timecodes, text summary, markdown
src/track.js       renderer-side tracking driver: decodes small gray frames, talks to the worker
src/tracker.js     pure tracking math (no DOM, no mediabunny) — importable from node for tests
src/track-worker.js module worker wrapping tracker.js
selftest.js        `electron . --selftest <outdir>` end-to-end check, exits 1 on failure
test/tracker.test.mjs  `node test/tracker.test.mjs` — tracker on synthetic frames
make-icon.js, icon.png, icon.ico, build/icon.png   app icon (procedural, like ArtFrames)
```
Remove ArtFrames-only files: `src/brush.js`, `src/gpu.js`, `src/exporter.js`, `bench.js`, `demo.js`. Keep the donate
window (`donate.html`, `donate.js`, `donate.json`) exactly as in ArtFrames, renamed channel prefix `ar:`.

## Data model

Frames are **video frames**, 0-based internally (`f = 0 … frameCount-1`). Displayed frame numbers are
`f + settings.startFrame` (default 1; VFX people may set 1001). Timecode `HH:MM:SS:FF` uses the rounded nominal fps
(24 for 23.976, 30 for 29.97; non-drop-frame).

Coordinates in notes are **normalized to the video picture** (0..1 in x and y, of the displayed, rotation-applied
picture), so they are independent of preview / export size.

```js
// a review (saved as .artreview JSON, also autosaved)
{
  format: 'artreview', version: 1,
  video: { name: 'shot_010.mp4', path: 'D:/…/shot_010.mp4', size: 12345678, width, height, fps, frameCount },
  startFrame: 1,
  notes: [Note],
}
// Note
{
  id: 'n_k3j2…',          // stable
  text: 'Тінь темніша',   // may be multi-line; may be '' while being typed
  color: '#ff5a4e',       // from PALETTE, assigned in creation order, never reused while the note exists
  in: 12, out: 84,        // visible frames, inclusive
  pin: { x: 0.42, y: 0.31 },          // where the pin was put, at frame `key`
  key: 12,                // frame where the pin / box was placed
  box: null | { x, y, w, h },         // normalized box around the followed object at frame `key`
  showBox: true,          // draw the box outline (only meaningful when box != null)
  track: null | {         // result of following `box` through the shot
    from: 0, to: 120,     // frames that were tracked (inclusive)
    boxes: [[x, y, w, h, q] | null, …],   // index = f - from; normalized; q = quality 0..1; null = lost
  },
}
```
`PALETTE = ['#ff5a4e', '#ffc23d', '#3dd6ff', '#7ee26b', '#ff6bd6', '#ff9a3d', '#b48cff', '#ffffff']`.
Note number shown on screen = its index in `notes` + 1 (notes stay in creation order; deleting renumbers).

### Where a note is drawn at frame f (src/notes.js `placeAt(note, f)`)
* Not visible outside `[in, out]`.
* No track: pin at `note.pin`, box at `note.box`.
* With track: take the tracked box at f (if f is outside `[from, to]` or the entry is null, use the nearest
  tracked non-null entry — the pin "holds" where the object was last seen). The pin rides with the box:
  `u = (pin.x - box.x) / box.w`, `v = (pin.y - box.y) / box.h` at `key`; at f `pin = (b.x + u*b.w, b.y + v*b.h)`.
* Returns `{ pin: {x, y}, box: {x,y,w,h} | null, lost: bool }` (`lost` = f inside the tracked range but no entry there).

### Creating notes (the whole interaction)
* **Pin tool (P, default)**: click on the picture → new note, `pin` = click, `key = in = current frame`,
  `out = min(last, in + round(3 * fps) - 1)`, text editor opens right there (inline textarea in the bubble;
  Enter = done, Shift+Enter = new line, Esc = done). Empty text after editing → the note is deleted.
* **Object tool (O)**: drag a rectangle around an object → new note with `box` = rectangle, `pin` = top-centre of
  the box, `showBox = true`, same in/out rule; tracking starts immediately in the background (progress shown on
  the note in the list and on the timeline) and the text editor opens at once (typing while it tracks).
* **Select tool (V)** (also: clicking an existing pin/bubble in any tool selects it): drag a pin to move it
  (moves `pin` at `key`; for tracked notes adjusts `u, v`), double-click a bubble to edit text, Delete removes the
  selected note. Selected note: "Стежити за об'єктом" button in the notes list → drag a box → track.
* I / O keys: set `in` / `out` of the selected note to the current frame.
* Timeline: each note is a coloured bar on its own lane from in to out; drag the bar ends to change in/out, drag the
  middle to move both; tracked range shown as a thin stripe under the bar, lost frames marked red.
* Undo / redo (Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y) of every note change (snapshot of the notes array, max 200).

### Bubble layout (src/overlay.js)
Same function draws preview and export: `drawOverlay(ctx, W, H, review, f, opts)` where the canvas area `W×H` is the
video picture, `opts = { selectedId, editingId, hud: bool, timecode: string, frameLabel: string, preview: bool }`.
* Sizes scale with the picture: `u = max(W, H) / 1000`; font `max(13, 18*u)` px "Segoe UI", system-ui; pin radius
  `max(9, 13*u)`; line widths `max(2, 2.5*u)`.
* Pin = filled circle in the note colour with a white 2px ring and the note number in dark text; a small drop shadow
  for readability on any footage.
* Box (if `showBox`): rounded rectangle outline in the note colour, 2.5u wide, with a 1px dark outer edge; dashed when `lost`.
* Bubble: dark rounded panel (rgba(16,18,22,0.82)), white text, a colour stripe on the left, max width 34% of W,
  word-wrapped (also long words), leader line from the pin to the bubble. Placement: try up-right of the pin, then
  up-left, down-right, down-left; pick the first that fits inside the frame with a margin and overlaps already
  placed bubbles least (place notes in order). Never outside the picture.
* HUD (export option, on by default): bottom-left small dark tag `shot_010 · 00:00:01:12 · кадр 37`.
* Preview-only: selection glow around the selected pin; while editing, the bubble shows the live text with a caret
  (the editor itself may be a real <textarea> positioned over the bubble — simplest robust choice).

## Video (src/video.js)
Adapt ArtFrames `openVideo` / `VideoRef`: open through `CustomSource` + `window.ar.range`, detect fps the same way,
**frame-accurate** access by frame index `f` (time = `first + (f + 0.25) / fps`, as ArtFrames nudges), LRU cache,
prefetch neighbours, paced playback against a clock, audio playback through an `<audio>` element synced like ArtFrames.
Display size = the stage size (fit, keep aspect). Rotated phone videos must show upright (mediabunny `displayWidth`).
Unsupported codec → clear Ukrainian message ("Цей кодек не підтримується. Перекодуй у H.264 (MP4).").

## Tracking

### src/tracker.js (pure, no DOM) — exact API
```js
export function toGray(rgba, width, height) // -> Uint8Array (luma, BT.601 integer)
export function buildPyramid(gray, width, height, levels = 3) // -> [{ data: Float32Array, width, height }, …]
export class BoxTracker {
  // gray: Uint8Array of the frame where the box was drawn; box in PIXELS of that gray frame
  constructor(gray, width, height, box /* {x, y, w, h} */, opts = {})
  // next frame (in either direction — the caller feeds frames in order away from the key frame)
  update(gray) // -> { box: {x, y, w, h} | null, quality: 0..1, lost: bool }
}
```
Algorithm ("median flow" + re-detection):
1. Points: a 10×10 grid inside the box (inset 10%), tracked prev→next with pyramidal LK (window 15×15, 3 levels,
   ≤ 20 iterations, epsilon 0.03), then next→prev (forward–backward error) and 11×11 NCC between the patches.
2. Keep points with FB error ≤ median FB error and NCC ≥ median NCC; need ≥ 8. Displacement = median dx, dy;
   scale = median of pairwise distance ratios (clamped 0.8..1.25 per frame).
3. Lost if fewer than 8 points, median FB error > 8 px (at the gray frame's scale), or the box leaves the frame
   by more than half. On loss: NCC template search (template = the key-frame patch and the last good patch, both
   resized to the current box size, downscaled search) in a window 3× the box around the last good position;
   re-acquire when NCC ≥ 0.65, else stay lost (return box null) and keep searching on the next frames.
4. `quality` = clamp(1 - medianFB / 8, 0, 1) × (fraction of points kept).
Performance target: ≤ 8 ms per frame for a 640×360 gray frame on a desktop CPU.

### src/track-worker.js
Module worker. Messages: `{type:'start', id, gray, width, height, box}` → creates a BoxTracker; `{type:'frame', id,
gray}` → replies `{type:'result', id, box, quality, lost}`; `{type:'stop', id}`. Transfer the gray buffers.

### src/track.js (renderer) — exact API
```js
// Tracks note.box from note.key forward to the last frame and backward to frame 0 (two passes, each its own
// BoxTracker). Decodes frames with mediabunny CanvasSink at a reduced size (long side 640, keep aspect),
// converts to gray, sends to the worker. Backward pass: decode chunks of ≤ 48 frames forward and feed them in
// reverse. Stops a direction after 2 s (in frames) of continuous loss.
export async function trackNote(video, note, { onProgress /* (0..1) */, signal /* AbortSignal */ })
  // -> { from, to, boxes: [[x,y,w,h,q] | null, …] }  (normalized), or throws AbortError
```
Editing the box / deleting the note aborts its running track. One track at a time; queue others.

## Export (src/export.js) — exact API
```js
// review: the review object; video: the opened VideoRef; settings: see Settings
export async function runExport(review, video, settings, { onProgress, signal })
  // -> { file, mdFile, text, width, height, frames, seconds, audio: bool, codec }
export function notesText(review, settings)      // message text (also in src/notes.js; one implementation)
export function notesMarkdown(review, settings)
```
* Output: `<outDir>/<videoBase>_notes_<YYYY-MM-DD_HH-mm-ss>.mp4` and the same name `.md`. `outDir` =
  `settings.outDir` or the default `<Videos>/ArtReview` (from main: `app.getPath('videos')`).
* Size: original, but the long side capped by `settings.maxSize` (default 1920; options 1280 / 1920 / original);
  even dimensions. Frame rate = the video's. Codec: H.264 (`avc`) first via `getFirstEncodableVideoCodec`,
  quality `QUALITY_HIGH`, keyframe every 2 s, MP4 with `fastStart: 'in-memory'`.
* Every source frame: draw the decoded frame (rotation applied) into a W×H canvas, `drawOverlay(...)` with `hud`,
  encode. Frame index from the sample timestamp exactly as ArtFrames `overVideo` does (middle-of-frame rule).
* **End card** (`settings.endCard`, default true): after the last frame, hold a summary card for
  `max(3 s, 1 s per 3 notes)`: dark background, title `shot_010.mp4 — нотатки`, then the numbered list (colour dot,
  number, frame range / timecode, text; wrapped; if it doesn't fit, smaller font, then two columns).
* **Audio** (`settings.audio`, default true): copy the primary audio track's packets if the codec fits MP4 (AAC,
  Opus, MP3), otherwise re-encode to AAC; if that's impossible export without audio and report `audio:false`.
  The end card is silent. (Use mediabunny `Output` + `VideoSampleSource` + `EncodedAudioPacketSource` /
  `AudioSampleSource` — manual pipeline, because Conversion cannot append the end card.)
* Cancellable (`signal`), progress 0..1. Writes through `ar.write`.

### Message text (`notesText`)
```
shot_010.mp4 — 3 нотатки
1. 00:00:00:12 (кадр 13–85) — Тінь темніша
2. 00:00:02:03 (кадр 52–124) — Прибрати відблиск на склі
3. …
```
Markdown = same list under a `# shot_010.mp4` heading plus a line with fps, size and the export file name; each note
also gets `x, y` of the pin in source pixels at its `key` frame and "стежить за об'єктом" when tracked.

## Clipboard and sharing (main.js)
* `ar:copy-video` `(file, text|null)`:
  * Windows: run `powershell.exe -NoProfile -STA -NonInteractive -Command <script>` with the path and the text passed
    through environment variables (never interpolated into the command): `System.Windows.Forms.DataObject` with
    `SetFileDropList` (+ `Preferred DropEffect` = copy) and, when text is given, `SetText(text, UnicodeText)`;
    `Clipboard.SetDataObject(data, $true)`. Returns `{ ok, withText }`.
  * macOS: `osascript -e 'set the clipboard to (POSIX file "<path>")'` with the path passed as an argument via
    `on run argv` (no interpolation); text is not combined → `withText: false`.
  * Linux: `xclip -selection clipboard -t text/uri-list` if present; else `{ ok: false }`.
* `ar:copy-text (text)` → `clipboard.writeText`.
* `ar:drag-out (file)` (ipcMain.on) → `event.sender.startDrag({ file, icon })` so the user can drag the exported
  video straight into a chat.
* `ar:reveal (file)` → show in folder.

## Settings (main.js keeps `settings.json` in userData; source run: beside the code, gitignored)
`{ outDir: null, maxSize: 1920, endCard: true, hud: true, audio: true, startFrame: 1, copyTextWithVideo: true }`
Settings popover (gear button): folder ("Змінити…"), size (1280 / 1920 / Оригінал), checkboxes: "Підсумок у кінці
відео", "Таймкод на відео", "Звук", "Текст нотаток разом з відео", number "Нумерація кадрів з" (1 / 1001 / custom).

## Main window (index.html)
* **Top bar**: [Відкрити відео] · tools [Пін P] [Об'єкт O] [Вибір V] · undo/redo · [Зберегти нотатки] [Відкрити
  нотатки] · spacer · settings gear · donate heart · **primary accent button "Скопіювати відео з нотатками"
  (Ctrl+Shift+C)** · secondary "Копіювати текст" · after an export a small draggable chip
  "⇱ shot_010_notes.mp4" (drag into a chat; click = show in folder).
* **Stage** (centre): the video frame + overlay. Empty state: big drop zone "Перетягни сюди відео або натисни
  «Відкрити відео»" (MP4, MOV, M4V, WebM, MKV). Dropping a `.artreview` file opens notes.
* **Notes panel** (right, ~300 px): one card per note: colour + number, the text (click to edit), the frame range
  and timecode, a tracking status ("стежить · 92%", "трекінг…", "загублено на 14 кадрах"), buttons: "Стежити за
  об'єктом" / "Не стежити", show-box toggle, delete. Click a card → jump to its `key` frame and select. Empty state:
  "Натисни на відео, щоб поставити пін. Обведи об'єкт інструментом «Об'єкт» — пін поїде за ним."
* **Transport + timeline** (bottom): play/pause (Space), frame step (←/→, Shift = 10), Home/End, J/K/L not needed;
  current frame number + timecode + fps; the scrubber with note lanes as described; click/drag scrubs.
* **Status line**: short hints and results ("Скопійовано: відео + текст. Встав у чат (Ctrl+V)").
* Progress overlay while exporting with Скасувати.
* The copy flow: press the button → export (progress) → copy (video + text when `copyTextWithVideo`) → toast with
  what is in the clipboard. If the notes did not change since the last export, reuse the file (no re-encode).
* Close with unsaved notes: notes are autosaved continuously (per video, in userData `reviews/<hash>.artreview`,
  hash of path + size), so closing never loses work and reopening the same video restores the notes silently with
  a toast "Нотатки відновлено". No save prompt on close.
* Window title: `ArtReview — shot_010.mp4`.

## Window API (preload.js → `window.ar`)
```js
ar.env                      // { selftest, version, platform }
ar.openDialog(kind)         // 'video' | 'review' -> path | null
ar.saveDialog(kind, name)   // 'review' -> path | null
ar.folderDialog()           // -> path | null
ar.read(file) / ar.write(file, bytes) / ar.stat(file) / ar.fileURL(file) / ar.reveal(file) / ar.pathForFile(File)
ar.range(file, start, end) / ar.rangeClose(file)
ar.settings()               // -> settings ;  ar.setSettings(patch) -> settings
ar.defaultOutDir()          // -> '<Videos>/ArtReview'
ar.reviewAutosave(key, json) / ar.reviewAutoload(key) -> json | null
ar.copyVideo(file, text|null) -> { ok, withText } ;  ar.copyText(text) ;  ar.dragOut(file)
ar.pendingFile() / ar.onOpenFile(cb)    // file passed on the command line or opened from the OS (.artreview or a video)
ar.setTitle(title) ; ar.log(...parts)
ar.donateAvailable() / ar.openDonate() / ar.donate() / ar.donateCopy(i) / ar.donateOpen(i) / ar.donateReady(h)
```

## Test hooks (for selftest.js)
`window.__ar` exposes: `review` (live object), `cur` (current frame), `video` (VideoRef or null),
`open(path)`, `seek(f)`, `tool(name)`, `stageRect()` (client rect of the video picture), `waitIdle()` (resolves
when no tracking/export is running), `exportNow()` (same as the copy button but returns the export result and the
copy result), `lastClipboard` (what was put on the clipboard), `undoDepth`.

## Self-test (selftest.js) — must pass
Generates its own test video in the renderer with mediabunny (no files from the user's disk): 640×360, 24 fps,
5 s, a textured 60×60 square moving on a smooth path over a noisy textured background, a frame counter, and a tone.
Then, with real mouse input (`sendInputEvent`) and keyboard:
1. opens the video; frame count = 120, fps = 24;
2. Pin tool: click → type a Ukrainian text (CDP `Input.insertText`) → Enter: one note with that text, in = current frame;
3. Object tool: drag a box around the square at frame 10 → tracking finishes; tracked box centre within 4 px of the
   true square centre (in 640×360 pixels) on ≥ 95% of frames; the pin moves with it;
4. I/O keys change in/out; undo/redo restores;
5. export: MP4 exists, decodes, 640×360, duration 5 s + end card (± 1 frame), has audio; a pixel test on one decoded
   output frame finds the note colour at the tracked pin position; `.md` contains both texts and timecodes;
6. clipboard (Windows): `Get-Clipboard -Format FileDropList` = the MP4 path and `Get-Clipboard` text contains the note
   texts (the selftest saves and restores the user's clipboard text around this step);
7. save notes to `.artreview`, clear, open it: identical notes; autosave restore on reopening the video;
8. screenshots of the main states; `report.json`; exit 1 on any failure.
Also `node test/tracker.test.mjs`: synthetic sequences (translation, scale 0.9–1.15, partial occlusion for 6 frames
then reappearance, noise) — centre error ≤ 2 px median, re-acquisition after occlusion, per-frame time reported.

## Out of scope for v0.1
Free-hand drawing, arrows, voice notes, comparing two versions, cloud sharing, neural trackers. Keep the code ready
for "arrow" as a later note kind but do not build UI for it.
