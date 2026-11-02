// End-to-end check without a human: `electron . --selftest <outdir>`.
// Makes its own test shot (a textured square moving over noise, a frame counter, a tone), then with real mouse and
// keyboard input: pins a note, outlines the square so a second note follows it, edits in/out with I/O, undoes and
// redoes, exports through the copy button path, reads the system clipboard back (Windows), saves / reopens the notes
// and checks the silent autosave restore.
// Writes report.json plus screenshots into <outdir>; exits 1 if any check fails.
const { app, BrowserWindow, clipboard, ClipboardItem } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const wait = ms => new Promise(r => setTimeout(r, ms));
const W = 640;
const H = 360;
const FPS = 24;
const N = 120;
const TEXT_PIN = 'Тінь темніша, ніж на референсі';
const TEXT_OBJ = 'Прибрати відблиск на склі';
const PALETTE = ['#ff5a4e', '#ffc23d', '#3dd6ff', '#7ee26b', '#ff6bd6', '#ff9a3d', '#b48cff', '#ffffff'];

// Ground truth of the moving square, shared by the generator (in the renderer) and the checks (here).
const CENTRE = 'i => [320 + 200 * Math.sin(i / 120 * Math.PI * 2), 180 + 90 * Math.sin(i / 120 * Math.PI * 4)]';
const centre = i => [320 + 200 * Math.sin((i / 120) * Math.PI * 2), 180 + 90 * Math.sin((i / 120) * Math.PI * 4)];

// Files the self-test writes into its folder; only these are removed before a run (the folder may be anyone's).
const OWN_FILES = /^(report\.json|shot_010\.mp4|other_shot\.mp4|(notes|missing|other_notes)\.artreview|\d\d-[a-z-]+\.png)$/;

const HELPERS = `
window.__t = {
  async mb() { return import('./node_modules/mediabunny/dist/bundles/mediabunny.min.mjs'); },
  centre: ${CENTRE},
  // RGB at points of a canvas (read through a 1x1 copy: the decoder's canvas is not made for readback)
  pixels(canvas, pts) {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    const g = c.getContext('2d', { willReadFrequently: true });
    return pts.map(([x, y]) => {
      g.drawImage(canvas, Math.round(x), Math.round(y), 1, 1, 0, 0, 1, 1);
      return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
    });
  },
};
true`;

// 640x360, 24 fps: a noisy textured background, a textured 60x60 square on a smooth path, a frame counter, a tone.
const MAKE_VIDEO = (file, frames, withSquare) => `(async () => {
  const mb = await __t.mb();
  const W = ${W}, H = ${H}, FPS = ${FPS}, N = ${frames};
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const bg = document.createElement('canvas'); bg.width = W; bg.height = H;
  const bgc = bg.getContext('2d');
  const img = bgc.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const v = 60 + rnd() * 70;
    img.data[i * 4] = v * 0.8; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v * 1.1; img.data[i * 4 + 3] = 255;
  }
  bgc.putImageData(img, 0, 0);
  const sq = document.createElement('canvas'); sq.width = 60; sq.height = 60;
  const sqc = sq.getContext('2d');
  for (let y = 0; y < 60; y += 6) for (let x = 0; x < 60; x += 6) {
    sqc.fillStyle = 'hsl(' + Math.floor(rnd() * 360) + ',80%,' + (30 + rnd() * 50) + '%)';
    sqc.fillRect(x, y, 6, 6);
  }
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
  const vcodec = await mb.getFirstEncodableVideoCodec(['avc', 'vp9'], { width: W, height: H });
  const video = new mb.CanvasSource(c, { codec: vcodec, quality: mb.QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: FPS });
  const acodec = await mb.getFirstEncodableAudioCodec(['aac', 'opus']);
  const sound = acodec && new mb.AudioBufferSource({ codec: acodec, quality: mb.QUALITY_MEDIUM });
  if (sound) output.addAudioTrack(sound);
  await output.start();
  for (let i = 0; i < N; i++) {
    g.drawImage(bg, 0, 0);
    if (${withSquare}) {
      const [cx, cy] = __t.centre(i);
      g.drawImage(sq, cx - 30, cy - 30);
    }
    g.fillStyle = '#fff'; g.font = 'bold 28px Segoe UI'; g.fillText(String(i), 10, 34);
    await video.add(i / FPS, 1 / FPS);
  }
  if (sound) {
    const sr = 48000, ab = new AudioBuffer({ length: sr * N / FPS, numberOfChannels: 2, sampleRate: sr });
    for (let ch = 0; ch < 2; ch++) { const d = ab.getChannelData(ch); for (let k = 0; k < d.length; k++) d[k] = 0.2 * Math.sin(2 * Math.PI * 440 * k / sr); }
    await sound.add(ab);
  }
  await output.finalize();
  await ar.write(${JSON.stringify(file)}, new Uint8Array(output.target.buffer));
  return { vcodec, acodec };
})()`;

// Facts about an exported file, plus pixels at given points of one frame of it and of the same frame of the source.
const PROBE = (file, source, frame, pts) => `(async () => {
  const mb = await __t.mb();
  const open = async f => new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(new Blob([await ar.read(f)])) });
  const input = await open(${JSON.stringify(file)});
  const v = await input.getPrimaryVideoTrack();
  const a = await input.getPrimaryAudioTrack();
  const out = {
    duration: await input.computeDuration(),
    width: await v.getDisplayWidth(), height: await v.getDisplayHeight(),
    video: await v.getCodec(), audio: a ? await a.getCodec() : null,
    audioDuration: a ? await a.computeDuration() : 0,
  };
  let frames = 0;
  for await (const p of new mb.EncodedPacketSink(v).packets(undefined, undefined, { metadataOnly: true })) frames++;
  out.frames = frames;
  const sink = new mb.CanvasSink(v);
  const at = (await sink.getCanvas((${frame} + 0.5) / ${FPS})).canvas;
  out.exported = __t.pixels(at, ${JSON.stringify(pts)});
  window.__shots = { frame: at.toDataURL('image/png'), card: (await sink.getCanvas(out.duration - 0.5)).canvas.toDataURL('image/png') };
  const src = await open(${JSON.stringify(source)});
  const sv = await src.getPrimaryVideoTrack();
  out.source = __t.pixels((await new mb.CanvasSink(sv).getCanvas((${frame} + 0.5) / ${FPS})).canvas, ${JSON.stringify(pts)});
  return out;
})()`;

const hexRGB = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const near = (p, rgb, tol) => p.every((v, i) => Math.abs(v - rgb[i]) <= tol);
// Points on a ring inside a pin: clear of its white edge and of the number in the middle.
const ring = (x, y, r, n = 12) => Array.from({ length: n }, (_, k) => [x + Math.cos((k / n) * 2 * Math.PI) * r, y + Math.sin((k / n) * 2 * Math.PI) * r]);

// Reads the Windows clipboard the way a messenger sees it: the file drop list and the text.
function readWinClipboard() {
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$f = @(Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName })',
    '$t = Get-Clipboard -Raw',
    'ConvertTo-Json -Compress @{ files = $f; text = $t }',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 20000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return resolve({ error: String(stderr || err.message) });
      try {
        const j = JSON.parse(stdout.trim());
        resolve({ files: [].concat(j.files || []), text: j.text || '' });
      } catch {
        resolve({ error: `bad output: ${stdout}` });
      }
    });
  });
}

// The user's clipboard goes back after the clipboard step: every format Electron can read, and the text for sure.
// Kept in memory only; it is never written to the report or to disk.
async function saveClipboard() {
  const saved = { text: '', items: null };
  saved.text = await clipboard.readText().catch(() => '');
  try {
    saved.items = [];
    for (const item of await clipboard.read()) {
      const entry = {};
      for (const type of item.types) {
        try {
          entry[type] = await item.getType(type);
        } catch {
          // a format that cannot be read cannot be restored either
        }
      }
      if (Object.keys(entry).length) saved.items.push(entry);
    }
  } catch {
    saved.items = null;
  }
  return saved;
}

async function restoreClipboard(saved) {
  try {
    if (saved.items?.length && ClipboardItem) await clipboard.write(saved.items.map(e => new ClipboardItem(e)));
  } catch {
    // the text below still goes back
  }
  let now = await clipboard.readText().catch(() => null);
  if (now !== saved.text) {
    if (saved.text) await clipboard.writeText(saved.text);
    else clipboard.clear();
    now = await clipboard.readText().catch(() => null);
  }
  return now === saved.text;
}

module.exports = async function selftest({ win, out }) {
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(out)) if (OWN_FILES.test(f)) fs.rmSync(path.join(out, f), { force: true });
  for (const [dir, re] of [['reviews', /\.artreview$/], ['ArtReview', /_notes_.*\.(mp4|md)$/]]) {
    const d = path.join(out, dir);
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (re.test(f)) fs.rmSync(path.join(d, f), { force: true });
  }

  const wc = win.webContents;
  const report = { console: [], checks: {} };
  const check = (name, ok, detail) => {
    report.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) };
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
  };
  const consoleErrors = () => report.console.filter(l => /^(error|3):/i.test(l) || /Uncaught|TypeError|ReferenceError/.test(l));
  let finished = false;
  const finish = code => {
    if (finished) return;
    finished = true;
    report.errors = consoleErrors();
    report.failed = Object.entries(report.checks).filter(([, c]) => !c.ok).map(([n]) => n);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    try {
      wc.debugger.detach();
    } catch {
      // not attached
    }
    app.exit(code ?? (report.failed.length ? 1 : 0));
  };
  let clip = null; // the user's clipboard while the clipboard step holds it
  // A hung step must still end the run with a report and a failure, and give the clipboard back.
  const watchdog = setTimeout(async () => {
    report.fatal = 'timeout: the self-test did not finish in 4 minutes';
    if (clip) report.clipboardRestored = await restoreClipboard(clip).catch(() => false);
    finish(1);
  }, 240000);

  wc.on('console-message', e => report.console.push(`${e.level}: ${e.message}`));
  const js = code => wc.executeJavaScript(code);
  const shot = async name => fs.writeFileSync(path.join(out, name), (await wc.capturePage()).toPNG());
  const saveDataURL = (name, url) => fs.writeFileSync(path.join(out, name), Buffer.from(url.split(',')[1], 'base64'));

  try {
    await new Promise(r => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
    await wait(1200);
    win.focus();
    wc.focus();
    report.loaded = await js('!!(window.__ar && window.ar)');
    if (!report.loaded) throw new Error(`app did not start: ${report.console.join(' | ')}`);
    await js(HELPERS);
    wc.debugger.attach('1.3');
    const cdp = (method, params) => wc.debugger.sendCommand(method, params);

    const key = async (keyCode, modifiers = [], times = 1) => {
      for (let i = 0; i < times; i++) {
        wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
        await wait(70);
      }
      await wait(60);
    };
    const click = async (x, y) => {
      [x, y] = [Math.round(x), Math.round(y)];
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await wait(200);
    };
    const drag = async (a, b, steps = 12) => {
      const p = t => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t)];
      wc.sendInputEvent({ type: 'mouseMove', x: p(0)[0], y: p(0)[1] });
      wc.sendInputEvent({ type: 'mouseDown', x: p(0)[0], y: p(0)[1], button: 'left', clickCount: 1 });
      for (let k = 1; k <= steps; k++) {
        const [x, y] = p(k / steps);
        wc.sendInputEvent({ type: 'mouseMove', x, y, button: 'left', modifiers: ['leftButtonDown'] });
        await wait(12);
      }
      wc.sendInputEvent({ type: 'mouseUp', x: p(1)[0], y: p(1)[1], button: 'left', clickCount: 1 });
      await wait(200);
    };
    const typeText = async text => {
      await cdp('Input.insertText', { text });
      await wait(150);
    };
    // Video pixel -> window point, through the picture rect the app reports.
    let rect;
    const at = (x, y) => [rect.x + (rect.width * x) / W, rect.y + (rect.height * y) / H];
    const tool = () => js("document.querySelector('#tools button.on')?.dataset.tool || null");
    const notes = () => js('JSON.parse(JSON.stringify(__ar.review ? __ar.review.notes : []))');
    // Waits until the decoder has put the current frame on screen.
    const settle = async () => {
      for (let i = 0; i < 100; i++) {
        if (await js('!__ar.video || __ar.video.shown === __ar.cur')) break;
        await wait(20);
      }
      await wait(150);
    };
    // RGB of the window at window points (capturePage may be in device pixels).
    const screenPixels = async pts => {
      const img = await wc.capturePage();
      const { width: iw, height: ih } = img.getSize();
      const s = iw / (await js('innerWidth'));
      const bmp = img.toBitmap(); // BGRA
      return pts.map(([x, y]) => {
        const px = Math.min(iw - 1, Math.round(x * s));
        const py = Math.min(ih - 1, Math.round(y * s));
        const k = (py * iw + px) * 4;
        return [bmp[k + 2], bmp[k + 1], bmp[k]];
      });
    };

    await shot('01-empty.png');
    check('empty state shows the drop zone and the notes hint', await js(`(() => {
      const e = document.getElementById('empty'), h = document.getElementById('notesEmpty');
      return getComputedStyle(e).display !== 'none' && !e.hidden && !h.hidden && /Перетягни сюди відео/.test(e.textContent);
    })()`));

    // ---------- 0. notes for a video that is not there, opened before any video ----------
    const missingFile = path.join(out, 'missing.artreview');
    fs.writeFileSync(missingFile, JSON.stringify({
      format: 'artreview', version: 1, video: { name: 'missing_shot.mp4', path: path.join(out, 'nowhere', 'missing_shot.mp4'), size: 1 },
      notes: [{ id: 'n_missing1', text: 'Нотатка для іншого відео', color: PALETTE[0], in: 0, out: 10, pin: { x: 0.5, y: 0.5 }, key: 0 }],
    }));
    await js(`__ar.open(${JSON.stringify(missingFile)}).then(() => true)`);
    const missingToast = await js("document.getElementById('toast').textContent");

    // ---------- 1. open the video ----------
    const shotFile = path.join(out, 'shot_010.mp4');
    report.testVideo = await js(MAKE_VIDEO(shotFile, N, true));
    await js(`__ar.open(${JSON.stringify(shotFile)}).then(() => true)`);
    await settle();
    rect = await js('__ar.stageRect()');
    const v = await js('({ frames: __ar.video.frameCount, fps: __ar.video.fps, width: __ar.video.width, height: __ar.video.height, audio: __ar.video.hasAudio, notes: __ar.review.notes.length })');
    check('1. video opens: 120 frames at 24 fps, 640x360, with sound', v.frames === N && Math.abs(v.fps - FPS) < 1e-6 && v.width === W && v.height === H && v.audio && v.notes === 0, v);
    check('1. window title names the shot', win.getTitle() === 'ArtReview — shot_010.mp4', win.getTitle());
    check('0. notes made for a missing video are not put on another video opened next', v.notes === 0 && /missing_shot\.mp4/.test(missingToast),
      { notes: v.notes, toast: missingToast });
    check('1. empty state is gone once a video is open', await js("getComputedStyle(document.getElementById('empty')).display === 'none' || document.getElementById('empty').hidden"));
    await shot('02-opened.png');

    // ---------- 2. pin tool: click, type, Enter ----------
    await key('Home');
    await key('Right', [], 5);
    await settle();
    const cur2 = await js('__ar.cur');
    const tool2 = await tool();
    await click(...at(100, 310));
    const editorOpen = await js("!!__ar.editingId && !document.getElementById('editor').hidden && document.activeElement === document.getElementById('editor')");
    await typeText(TEXT_PIN);
    await wait(150);
    await shot('03-typing.png');
    await key('Enter');
    let ns = await notes();
    check('2. pin tool: click, type, Enter makes one note with the text at the current frame', cur2 === 5 && tool2 === 'pin' && editorOpen && ns.length === 1 &&
      ns[0].text === TEXT_PIN && ns[0].in === 5 && ns[0].key === 5 && ns[0].out === 5 + 72 - 1 &&
      Math.abs(ns[0].pin.x * W - 100) < 1.5 && Math.abs(ns[0].pin.y * H - 310) < 1.5 && ns[0].color === PALETTE[0] && !(await js('__ar.editingId')),
    { cur: cur2, tool: tool2, editorOpen, notes: ns.map(n => ({ text: n.text, in: n.in, out: n.out, key: n.key, pin: n.pin })) });
    check('2. the note is undoable', (await js('__ar.undoDepth')) === 1, await js('__ar.undoDepth'));

    // ---------- 3. object tool: outline the square at frame 10, track ----------
    await key('O'); // right after Enter: the Object tool, not "end the note here"
    const tool3 = await tool();
    const afterO = (await notes())[0] || {};
    check('2. O right after typing a note switches to the Object tool and leaves the note as it was',
      tool3 === 'object' && afterO.in === 5 && afterO.out === 5 + 72 - 1 && !(await js('__ar.selectedId')), { tool: tool3, in: afterO.in, out: afterO.out });
    await key('Home');
    await key('Right', ['shift']);
    await settle();
    const cur3 = await js('__ar.cur');
    const c10 = centre(10);
    await drag(at(c10[0] - 36, c10[1] - 36), at(c10[0] + 36, c10[1] + 36));
    await typeText(TEXT_OBJ); // typing while it tracks
    await shot('04-tracking.png');
    await key('Enter');
    const t0 = Date.now();
    await js('__ar.waitIdle()');
    report.trackSeconds = (Date.now() - t0) / 1000;
    report.trackEngine = await js("import('./src/track.js').then(m => m.trackingEngine ? m.trackingEngine() : null)");
    ns = await notes();
    const obj = ns[1] || {};
    const tr = obj.track;
    let good = 0;
    let pinGood = 0;
    const errs = [];
    if (tr && obj.box) {
      const k0 = obj.box;
      const off = [(obj.pin.x - k0.x - k0.w / 2) * W, (obj.pin.y - k0.y - k0.h / 2) * H]; // pin from the box centre, at the key
      const pins = await js(`import('./src/notes.js').then(m => Array.from({ length: ${N} }, (_, f) => m.placeAt(__ar.review.notes[1], f, { ignoreRange: true }).pin))`);
      for (let f = 0; f < N; f++) {
        const b = tr.boxes[f - tr.from];
        const [cx, cy] = centre(f);
        if (!b) {
          errs.push(Infinity);
          continue;
        }
        const e = Math.hypot((b[0] + b[2] / 2) * W - cx, (b[1] + b[3] / 2) * H - cy);
        errs.push(e);
        if (e <= 4) good++;
        // the pin as drawn (notes.js placeAt) must ride with the true square
        if (Math.hypot(pins[f].x * W - (cx + off[0]), pins[f].y * H - (cy + off[1])) <= 4) pinGood++;
      }
    }
    const sorted = [...errs].sort((a, b) => a - b);
    const trackDetail = {
      tool: tool3, frame: cur3, text: obj.text, from: tr?.from, to: tr?.to, within4px: good, pinWithin4px: pinGood, frames: N,
      medianPx: sorted.length ? +sorted[sorted.length >> 1].toFixed(2) : null, maxPx: sorted.length ? +sorted[sorted.length - 1].toFixed(2) : null,
      lost: errs.filter(e => e === Infinity).length, seconds: report.trackSeconds, engine: report.trackEngine,
    };
    report.tracking = trackDetail;
    check('3. object tool: a box drawn at frame 10 makes a followed note', tool3 === 'object' && cur3 === 10 && ns.length === 2 && obj.text === TEXT_OBJ &&
      obj.key === 10 && obj.in === 10 && obj.box && obj.color === PALETTE[1] && Math.abs((obj.box.x + obj.box.w / 2) * W - c10[0]) < 2 &&
      Math.abs((obj.box.y + obj.box.h / 2) * H - c10[1]) < 2, { ...trackDetail, box: obj.box, color: obj.color });
    check('3. tracking covers the whole shot', tr && tr.from === 0 && tr.to === N - 1 && tr.boxes.length === N, trackDetail);
    check('3. tracked centre within 4 px of the true square on >= 95% of frames', good >= 0.95 * N, trackDetail);
    check('3. the pin moves with the object', pinGood >= 0.95 * N, trackDetail);
    const trackText = await js(`document.querySelector('.card[data-id="${obj.id}"] .track')?.textContent || ''`);
    check('3. notes panel shows the tracking status', /стежить/.test(trackText), trackText);

    // The live preview draws the pin where the square is now (screen pixels, far from the key frame).
    const truthPin = f => {
      const [cx, cy] = centre(f);
      return [cx + (obj.pin.x - obj.box.x - obj.box.w / 2) * W, cy + (obj.pin.y - obj.box.y - obj.box.h / 2) * H];
    };
    await js('__ar.seek(37)');
    await settle();
    rect = await js('__ar.stageRect()');
    const rScreen = Math.max(9, (13 * Math.max(rect.width, rect.height)) / 1000);
    const scr = await screenPixels(ring(...at(...truthPin(37)), rScreen * 0.72));
    const scrHits = scr.filter(p => near(p, hexRGB(obj.color), 45)).length;
    check('3. preview draws the followed pin on the square (screen pixels)', scrHits >= 10, { hits: scrHits, of: scr.length, pixels: scr });
    await shot('05-tracked.png');

    // ---------- 4. I / O keys, undo / redo ----------
    const cardAt = await js(`(() => { const r = document.querySelector('.card[data-id="${obj.id}"] .range').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await click(...cardAt);
    const sel = (await js('__ar.selectedId')) === obj.id;
    const jumped = await js('__ar.cur');
    await key('Right', ['shift'], 4); // 10 -> 50
    await key('O');
    await key('Left', ['shift'], 2);
    await key('Left', [], 5); // -> 25
    await key('I');
    ns = await notes();
    const edited = { in: ns[1].in, out: ns[1].out };
    await key('Z', ['control']);
    await key('Z', ['control']);
    ns = await notes();
    const undone = { in: ns[1].in, out: ns[1].out, tracked: !!ns[1].track, notes: ns.length };
    await key('Z', ['control', 'shift']);
    await key('Y', ['control']);
    ns = await notes();
    const redone = { in: ns[1].in, out: ns[1].out, tracked: !!ns[1].track };
    const toolAfter = await tool();
    check('4. I / O set in and out of the selected note', sel && jumped === 10 && edited.in === 25 && edited.out === 50 && toolAfter === 'object', { selected: sel, jumped, edited, tool: toolAfter });
    check('4. undo restores in / out, redo applies them again (tracking kept)', undone.in === 10 && undone.out === 81 && undone.tracked && undone.notes === 2 &&
      redone.in === 25 && redone.out === 50 && redone.tracked, { undone, redone });
    await settle();
    await shot('06-inout.png');

    // Select tool: drag pin 1 to a new place, undo puts it back.
    await key('V');
    const toolV = await tool();
    await drag(at(100, 310), at(160, 290));
    const movedPin = (await notes())[0].pin;
    await key('Z', ['control']);
    const backPin = (await notes())[0].pin;
    check('select tool: dragging a pin moves it, undo puts it back', toolV === 'select' && Math.abs(movedPin.x * W - 160) < 1.5 && Math.abs(movedPin.y * H - 290) < 1.5 &&
      Math.abs(backPin.x * W - 100) < 1.5 && Math.abs(backPin.y * H - 310) < 1.5, { tool: toolV, moved: [movedPin.x * W, movedPin.y * H], back: [backPin.x * W, backPin.y * H] });

    // Transport: Space plays at the shot's rate and stops again.
    await key('Home');
    await settle();
    const playT0 = Date.now();
    await key('Space');
    await wait(1000);
    await key('Space');
    const playedFor = (Date.now() - playT0) / 1000;
    const stoppedAt = await js('__ar.cur');
    await wait(300);
    const stillAt = await js('__ar.cur');
    check('playback: Space plays about 24 frames a second and stops', stoppedAt >= 0.6 * FPS * playedFor && stoppedAt <= 1.25 * FPS * playedFor && stillAt === stoppedAt,
      { seconds: playedFor, frames: stoppedAt, after: stillAt });
    await js('__ar.seek(25)');
    await settle();

    const otherFile = path.join(out, 'other_shot.mp4');
    await js(MAKE_VIDEO(otherFile, 24, false));

    // ---------- 5 + 6. export through the copy button path, then the clipboard ----------
    const isWin = process.platform === 'win32';
    if (isWin) clip = await saveClipboard();
    await js('window.__exp = __ar.exportNow(); true');
    await wait(150);
    const busyShown = await js("!document.getElementById('busy').hidden");
    // Opening another file while the export runs (a drop, a double-click in Explorer) is refused: the shot stays.
    const duringOpen = busyShown ? await js(`__ar.open(${JSON.stringify(otherFile)}).then(() => ({ file: __ar.video.file, toast: document.getElementById('toast').textContent }))`) : null;
    await shot('07-exporting.png');
    const res = await js('window.__exp');
    const exp = res?.export || null;
    report.export = exp && { ...exp, text: undefined };
    const sees = isWin ? await readWinClipboard() : null;
    // A second copy with nothing changed must reuse the file, not encode again.
    const t1 = Date.now();
    const res2 = await js('__ar.exportNow()');
    const reuseMs = Date.now() - t1;
    if (isWin) {
      report.clipboardRestored = await restoreClipboard(clip);
      clip = null;
    }
    await wait(200);
    await shot('08-copied.png');

    const exists = !!exp?.file && fs.existsSync(exp.file);
    check('5. export: the MP4 is written to the output folder, with progress shown', exists && path.dirname(exp.file) === path.join(out, 'ArtReview') &&
      /^shot_010_notes_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.mp4$/.test(path.basename(exp.file)) && busyShown, { file: exp?.file, busyShown });
    const pinPt = truthPin(37);
    const pts = ring(...pinPt, Math.max(9, 13 * 0.64) * 0.72);
    const probe = exists ? await js(PROBE(exp.file, shotFile, 37, pts)) : null;
    report.probe = probe && { ...probe, exported: undefined, source: undefined };
    check('5. export decodes: 640x360, 5 s + 3 s end card (+-1 frame), with audio', !!probe && probe.width === W && probe.height === H &&
      Math.abs(probe.duration - 8) <= 1 / FPS + 1e-3 && Math.abs(probe.frames - (N + 3 * FPS)) <= 1 && !!probe.audio && exp.audio === true &&
      Math.abs(probe.audioDuration - 5) < 0.1 && exp.width === W && exp.height === H, report.probe);
    const col = hexRGB(obj.color);
    const outHits = probe ? probe.exported.filter(p => near(p, col, 50)).length : 0;
    const srcHits = probe ? probe.source.filter(p => near(p, col, 50)).length : 0;
    check('5. export frame 37 has the note colour at the tracked pin position (and the source does not)', outHits >= 10 && srcHits <= 2,
      { outHits, srcHits, of: pts.length, at: pinPt.map(Math.round), exported: probe?.exported });
    if (probe) {
      const shots = await js('window.__shots');
      saveDataURL('09-export-frame.png', shots.frame);
      saveDataURL('10-endcard.png', shots.card);
    }
    const md = exp?.mdFile && fs.existsSync(exp.mdFile) ? fs.readFileSync(exp.mdFile, 'utf8') : '';
    check('5. the .md beside the video lists both notes with timecodes', !!exp && md.includes(TEXT_PIN) && md.includes(TEXT_OBJ) && md.includes('00:00:00:05') &&
      md.includes('00:00:01:01') && md.includes('# shot_010.mp4') && md.includes(path.basename(exp.file)) && md.includes("стежить за об'єктом") &&
      exp.mdFile === exp.file.replace(/\.mp4$/, '.md'), md);
    check('5. opening another video during the export is refused; the copied text is the exported shot\'s', !!duringOpen &&
      duringOpen.file === shotFile && /Зачекай/.test(duringOpen.toast) && (res?.export?.text || '').startsWith('shot_010.mp4 — 2 нотатки'), { duringOpen, text: res?.export?.text });
    check('5. copying again with no changes reuses the export', !!exp && res2?.export?.file === exp.file && reuseMs < 1500, { again: res2?.export?.file, ms: reuseMs });

    const want = `shot_010.mp4 — 2 нотатки\n1. 00:00:00:05 (кадр 6–77) — ${TEXT_PIN}\n2. 00:00:01:01 (кадр 26–51) — ${TEXT_OBJ}`;
    if (isWin) {
      const text = (sees?.text || '').replace(/\r\n/g, '\n');
      check('6. clipboard holds the MP4 as a file (Get-Clipboard -Format FileDropList)', !!exp && res?.copy?.ok && sees?.files?.length === 1 &&
        path.resolve(sees.files[0]) === path.resolve(exp.file), { copy: res?.copy, files: sees?.files, error: sees?.error });
      check('6. clipboard text (Get-Clipboard) has the note texts', res?.copy?.withText && text.trim() === want, { text, want });
      check("6. the user's clipboard text is restored", report.clipboardRestored === true);
    } else {
      check('6. clipboard (Windows only): skipped on this platform', true, process.platform);
    }
    const lc = await js('__ar.lastClipboard');
    check('6. the app reports what it put on the clipboard', !!exp && lc?.ok && lc.file === exp.file && (lc.text || '').trim() === (isWin ? want : (lc.text || '').trim()), lc);
    const statusText = await js("document.getElementById('statusText').textContent");
    const chipText = await js("document.getElementById('chip').hidden ? '' : document.getElementById('chip').textContent");
    check('5. status line and the drag chip say what was copied', /^Скопійовано/.test(statusText) && chipText.includes(path.basename(exp?.file || '?')), { status: statusText, chip: chipText });

    // ---------- 7. save / open .artreview, autosave restore ----------
    const reviewFile = path.join(out, 'notes.artreview');
    await js(`__ar.saveTo(${JSON.stringify(reviewFile)})`);
    const before = JSON.stringify(await notes());
    const savedJSON = fs.existsSync(reviewFile) ? JSON.parse(fs.readFileSync(reviewFile, 'utf8')) : null;
    await js('__ar.clearNotes()');
    const cleared = (await notes()).length;
    await js(`__ar.open(${JSON.stringify(reviewFile)}).then(() => true)`);
    await wait(300);
    const reopened = JSON.stringify(await notes());
    check('7. notes saved to .artreview, cleared and opened again are identical', savedJSON?.format === 'artreview' && savedJSON.version === 1 &&
      savedJSON.video?.name === 'shot_010.mp4' && savedJSON.video.frameCount === N && cleared === 0 && reopened === before,
    { cleared, same: reopened === before, video: savedJSON?.video });

    await js('__ar.flushAutosave()');
    await js(`__ar.open(${JSON.stringify(otherFile)}).then(() => true)`);
    await settle();
    const other = { notes: (await notes()).length, frames: await js('__ar.video.frameCount'), title: win.getTitle() };
    await js(`__ar.open(${JSON.stringify(shotFile)}).then(() => true)`);
    await wait(250);
    const restored = JSON.stringify(await notes());
    const toastText = await js("document.getElementById('toast').classList.contains('show') ? document.getElementById('toast').textContent : ''");
    const reviewsDir = path.join(out, 'reviews');
    const autosaves = fs.existsSync(reviewsDir) ? fs.readdirSync(reviewsDir).filter(f => f.endsWith('.artreview')) : [];
    check('7. reopening the video restores the notes silently from the autosave', other.notes === 0 && other.frames === 24 &&
      other.title === 'ArtReview — other_shot.mp4' && restored === before && toastText === 'Нотатки відновлено' && autosaves.length >= 1,
    { other, same: restored === before, toast: toastText, autosaves });
    await settle();
    await js('__ar.seek(30)');
    await settle();
    await shot('11-restored.png');

    // ---------- 7b. notes from a file replace the autosaved ones only undoably; ids from files are sanitised ----------
    await js(`__ar.open(${JSON.stringify(otherFile)}).then(() => true)`);
    await settle();
    const crafted = path.join(out, 'other_notes.artreview');
    fs.writeFileSync(crafted, JSON.stringify({
      format: 'artreview', version: 1, video: { name: 'shot_010.mp4', path: shotFile, size: fs.statSync(shotFile).size },
      notes: [{ id: 'x"><b id="pwn">', text: 'Інша версія нотатки', color: PALETTE[2], in: 0, out: 10, pin: { x: 0.5, y: 0.5 }, key: 0 }],
    }));
    await js(`__ar.open(${JSON.stringify(crafted)}).then(() => true)`);
    await wait(250);
    const fromFile = await notes();
    const fileToast = await js("document.getElementById('toast').textContent");
    const depth = await js('__ar.undoDepth');
    const injected = await js("!!document.getElementById('pwn')");
    await key('Z', ['control']);
    const backToAutosave = JSON.stringify(await notes());
    check('7. notes from a file replace the autosaved notes undoably (Ctrl+Z brings the autosaved ones back)',
      (await js('__ar.video.file')) === shotFile && fromFile.length === 1 && fromFile[0].text === 'Інша версія нотатки' && depth === 1 &&
      /Ctrl\+Z/.test(fileToast) && backToAutosave === before, { notes: fromFile.map(n => n.text), depth, toast: fileToast, back: backToAutosave === before });
    check('7. a note id from a file cannot inject HTML', /^n_[a-z0-9]+$/.test(fromFile[0]?.id || '') && !injected, { id: fromFile[0]?.id, injected });

    // The HUD tag (export only) is drawn under the notes: a pin in the bottom-left corner still shows.
    const hudPin = await js(`import('./src/overlay.js').then(m => {
      const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
      const g = c.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, 1920, 1080);
      const review = { video: { name: 'shot_010.mp4' }, notes: [{ id: 'n_hud', text: 'Контакт з підлогою', color: '#3dd6ff', in: 0, out: 10, pin: { x: 0.06, y: 0.97 }, key: 0, box: null, showBox: true, track: null }] };
      const lay = m.drawOverlay(g, 1920, 1080, review, 0, { hud: true, timecode: '00:00:00:00', frameLabel: '1' });
      const r = lay[0].r * 0.72, px = 0.06 * 1920, py = 0.97 * 1080;
      const pts = Array.from({ length: 12 }, (_, k) => [px + Math.cos(k / 12 * 2 * Math.PI) * r, py + Math.sin(k / 12 * 2 * Math.PI) * r]);
      const pix = __t.pixels(c, pts);
      const b = lay[0].bubble;
      return { hits: pix.filter(p => Math.abs(p[0] - 0x3d) < 30 && Math.abs(p[1] - 0xd6) < 30 && Math.abs(p[2] - 0xff) < 30).length, bubbleBottom: b.y + b.h };
    })`);
    check('8. the export HUD does not cover a pin in the bottom-left corner', hudPin.hits >= 10, hudPin);

    // The window shows our page only: a navigation started by the page is refused, the bridge still works after it.
    const appURL = wc.getURL();
    // (a meta refresh, as an injected tag would do it, to another local page)
    await js(`document.head.insertAdjacentHTML('beforeend', '<meta http-equiv="refresh" content="0;url=donate.html">'); true`).catch(() => null);
    await wait(600);
    check('8. the main window cannot be navigated away from the app', wc.getURL() === appURL && (await js('!!(window.ar && window.__ar && __ar.video)')), wc.getURL());
    // The donate window still talks to the main process through its own channels (it shows only after donate-ready).
    await js('ar.openDonate(); true');
    let donateShown = false;
    for (let i = 0; i < 40 && !donateShown; i++) {
      await wait(100);
      donateShown = BrowserWindow.getAllWindows().some(w => w !== win && w.isVisible());
    }
    for (const w of BrowserWindow.getAllWindows()) if (w !== win) w.close();
    await wait(200);
    win.focus();
    wc.focus();
    check('8. the donate window opens (its channels pass the sender check)', donateShown);

    // ---------- 8. other main states ----------
    await js("document.getElementById('settingsBtn').click(); true");
    await wait(300);
    check('8. settings popover opens with the defaults', await js(`(() => {
      const p = document.getElementById('settings');
      const on = [...p.querySelectorAll('#sizeSeg button.on')].map(b => b.dataset.size);
      return !p.hidden && on.join() === '1920' && [...p.querySelectorAll('[data-s]')].every(i => i.checked);
    })()`));
    await shot('12-settings.png');
    await key('Escape');
  } catch (err) {
    report.fatal = err.stack || String(err);
    console.error(report.fatal);
  } finally {
    if (clip) report.clipboardRestored = await restoreClipboard(clip).catch(() => false);
    clip = null;
  }
  clearTimeout(watchdog);
  if (finished) return;

  check('no errors in the console', !consoleErrors().length, consoleErrors());
  if (report.fatal) check('self-test ran to the end', false, report.fatal);
  const pngs = fs.readdirSync(out).filter(f => f.endsWith('.png'));
  check('8. screenshots of the main states written', pngs.length >= 12, pngs);
  finish();
};
