// End-to-end check without a human: `electron . --selftest <outdir>`.
// Draws a bouncing ball over several frames with real mouse input and a pen with pressure (Chrome DevTools input,
// which arrives as PointerEvents of type "pen"), checks the onion skin, undo and frame operations, plays it back,
// generates a test video with a frame counter and a tone, traces over it, draws an own reference under the frames,
// and exports PNG, GIF, WebM and MP4.
// Writes report.json plus screenshots; exits 1 if any check fails.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const wait = ms => new Promise(r => setTimeout(r, ms));

// Counts the images in a GIF and sums their delays (walks the block structure; image data may contain any byte).
function gifInfo(buf) {
  let p = 13;
  if (buf[10] & 0x80) p += 3 * (1 << ((buf[10] & 7) + 1));
  let frames = 0;
  let delay = 0;
  const skipSub = () => {
    while (buf[p]) p += buf[p] + 1;
    p++;
  };
  while (p < buf.length) {
    const b = buf[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = buf[p++];
      if (label === 0xf9) delay += buf.readUInt16LE(p + 2);
      skipSub();
    } else if (b === 0x2c) {
      const flags = buf[p + 8];
      p += 9;
      if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
      p++; // LZW minimum code size
      skipSub();
      frames++;
    } else {
      throw new Error(`bad GIF block 0x${b.toString(16)} at ${p - 1}`);
    }
  }
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), frames, seconds: delay / 100 };
}

const HELPERS = `
window.__t = {
  // Drawings and scene layers live on the GPU; __af reads them back as premultiplied RGBA.
  ink(i) {
    const d = __af.readFrame(i);
    if (!d) return 0;
    let n = 0;
    for (let k = 3; k < d.length; k += 4) if (d[k] > 127) n++;
    return n;
  },
  // Length of opaque run along a line through (x, y) in direction (dx, dy), in pixels.
  thickness(i, x, y, dx, dy, reach) {
    const d = __af.readFrame(i), W = __af.doc.width;
    const n = Math.hypot(dx, dy); dx /= n; dy /= n;
    let hits = 0;
    for (let s = -reach; s <= reach; s += 0.25) {
      const px = Math.round(x + dx * s), py = Math.round(y + dy * s);
      if (d[(py * W + px) * 4 + 3] > 127) hits++;
    }
    return hits * 0.25;
  },
  tints() {
    const d = __af.readLayer('onion');
    let red = 0, green = 0;
    for (let k = 0; k < d.length; k += 4) {
      const a = d[k + 3];
      if (a < 20) continue;
      const r = d[k] * 255 / a, g = d[k + 1] * 255 / a;
      if (r > g + 40) red++;
      else if (g > r + 40) green++;
    }
    return { red, green };
  },
  refPixel(x, y) { return [...__af.readLayer('ref', x, y, 1, 1)]; },
  scenePixel(x, y) { return [...__af.readLayer('scene', x, y, 1, 1)]; },
  // The brush cursor drawn over the stage: whether it shows, and where (window coordinates of its centre).
  cursor() {
    const st = document.getElementById('stage'), c = document.getElementById('cursor'), r = st.getBoundingClientRect();
    const m = /translate\\(([-\\d.]+)px, ([-\\d.]+)px\\)/.exec(c.style.transform) || [0, NaN, NaN];
    return { shown: getComputedStyle(c).display !== 'none', x: +m[1] + r.left, y: +m[2] + r.top };
  },
  sketchInk() {
    const d = __af.readLayer('sketch');
    let n = 0;
    for (let k = 3; k < d.length; k += 4) if (d[k] > 127) n++;
    return n;
  },
  // A solid pixel inside the own reference where no frame has ink: where to look for it in the scene and exports.
  sketchSpot() {
    const s = __af.readLayer('sketch'), W = __af.doc.width, row = W * 4 * 2;
    const frames = __af.doc.frames.map((f, i) => __af.readFrame(i)).filter(Boolean);
    for (let k = 3 + row; k < s.length - row; k += 4) {
      if (s[k] < 255 || s[k - row] < 255 || s[k + row] < 255 || frames.some(d => d[k] > 0)) continue;
      const p = (k - 3) / 4;
      return [p % W, Math.floor(p / W)];
    }
    return null;
  },
  // Share of the inked pixels of a that are inked in b too.
  covered(a, b) {
    let n = 0, both = 0;
    for (let k = 3; k < a.length; k += 4) if (a[k] > 127) { n++; if (b[k] > 127) both++; }
    return n ? both / n : 0;
  },
  pixel(canvas, x, y) {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(canvas, x, y, 1, 1, 0, 0, 1, 1);
    return [...g.getImageData(0, 0, 1, 1).data];
  },
  async mb() { return import('./node_modules/mediabunny/dist/bundles/mediabunny.min.mjs'); },
};
true`;

// 2 s, 24 fps, 640x360: a grey square whose level is 5 x frame number (to check frame sync), a moving ball, a 440 Hz tone.
const MAKE_VIDEO = file => `(async () => {
  const mb = await __t.mb();
  const W = 640, H = 360, FPS = 24, N = 48;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
  const vcodec = await mb.getFirstEncodableVideoCodec(['avc', 'vp9'], { width: W, height: H });
  const video = new mb.CanvasSource(c, { codec: vcodec, quality: mb.QUALITY_VERY_HIGH, keyFrameInterval: 0.5 });
  output.addVideoTrack(video, { frameRate: FPS });
  const acodec = await mb.getFirstEncodableAudioCodec(['aac', 'opus']);
  const sound = acodec && new mb.AudioBufferSource({ codec: acodec, quality: mb.QUALITY_MEDIUM });
  if (sound) output.addAudioTrack(sound);
  await output.start();
  for (let i = 0; i < N; i++) {
    g.fillStyle = '#3a5f7a'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#f0c040'; g.beginPath(); g.arc(90 + i * 10, 230, 42, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgb(' + i * 5 + ',' + i * 5 + ',' + i * 5 + ')'; g.fillRect(0, 0, 48, 48);
    g.fillStyle = '#fff'; g.font = 'bold 72px Segoe UI'; g.fillText(String(i), 420, 120);
    await video.add(i / FPS, 1 / FPS);
  }
  if (sound) {
    const sr = 48000, ab = new AudioBuffer({ length: sr * 2, numberOfChannels: 2, sampleRate: sr });
    for (let ch = 0; ch < 2; ch++) { const d = ab.getChannelData(ch); for (let k = 0; k < d.length; k++) d[k] = 0.25 * Math.sin(2 * Math.PI * 440 * k / sr); }
    await sound.add(ab);
  }
  await output.finalize();
  await af.write(${JSON.stringify(file)}, new Uint8Array(output.target.buffer));
  return { vcodec, acodec };
})()`;

// 10 s at 30000/1001 fps: squares at x 0 and 48 encode the frame index as (i % 50) * 5 and floor(i / 50) * 40.
const MAKE_NTSC = file => `(async () => {
  const mb = await __t.mb();
  const W = 640, H = 360, N = 300, FPS = 30000 / 1001;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
  const video = new mb.CanvasSource(c, { codec: 'avc', quality: mb.QUALITY_VERY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: FPS });
  await output.start();
  for (let i = 0; i < N; i++) {
    g.fillStyle = '#2d4a3a'; g.fillRect(0, 0, W, H);
    const a = (i % 50) * 5, b = Math.floor(i / 50) * 40;
    g.fillStyle = 'rgb(' + a + ',' + a + ',' + a + ')'; g.fillRect(0, 0, 48, 48);
    g.fillStyle = 'rgb(' + b + ',' + b + ',' + b + ')'; g.fillRect(48, 0, 48, 48);
    g.fillStyle = '#fff'; g.font = 'bold 72px Segoe UI'; g.fillText(String(i), 380, 140);
    await video.add(i * 1001 / 30000, 1001 / 30000);
  }
  await output.finalize();
  await af.write(${JSON.stringify(file)}, new Uint8Array(output.target.buffer));
  return true;
})()`;

const PROBE = (file, at) => `(async () => {
  const mb = await __t.mb();
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(new Blob([await af.read(${JSON.stringify(file)})])) });
  const v = await input.getPrimaryVideoTrack();
  const a = await input.getPrimaryAudioTrack();
  const out = { duration: +(await input.computeDuration()).toFixed(3), width: v.displayWidth, height: v.displayHeight, video: v.codec, audio: a ? a.codec : null };
  out.fps = +(await v.computePacketStats()).averagePacketRate.toFixed(2);
  if (${JSON.stringify(at || null)}) {
    const sink = new mb.CanvasSink(v);
    out.samples = {};
    for (const [name, t, x, y] of ${JSON.stringify(at || [])}) out.samples[name] = __t.pixel((await sink.getCanvas(t)).canvas, x, y);
  }
  return out;
})()`;

module.exports = async function selftest({ win, out }) {
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(out)) fs.rmSync(path.join(out, f), { recursive: true, force: true });
  const wc = win.webContents;
  const report = { console: [], checks: {} };
  const check = (name, ok, detail) => {
    report.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) };
  };
  wc.on('console-message', e => report.console.push(`${e.level}: ${e.message}`));
  const js = code => wc.executeJavaScript(code);
  const shot = async name => fs.writeFileSync(path.join(out, name), (await wc.capturePage()).toPNG());

  await new Promise(r => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
  await wait(1200);
  win.focus();
  wc.focus();
  report.loaded = await js('!!(window.__af && __af.doc)');
  if (!report.loaded) throw new Error(`app did not start: ${report.console.join(' | ')}`);
  await js(HELPERS);
  wc.debugger.attach('1.3');
  const cdp = (method, params) => wc.debugger.sendCommand(method, params);

  const key = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await wait(90);
  };
  let rect;
  const measure = async () => {
    rect = await js("(() => { const r = document.getElementById('sheet').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()");
  };
  const at = (fx, fy) => [rect.x + rect.w * fx, rect.y + rect.h * fy];
  const mouse = async pts => {
    const [x, y] = pts[0].map(Math.round);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    for (const p of pts.slice(1)) {
      const [mx, my] = p.map(Math.round);
      wc.sendInputEvent({ type: 'mouseMove', x: mx, y: my, button: 'left', modifiers: ['leftButtonDown'] });
      await wait(8);
    }
    const [ex, ey] = pts[pts.length - 1].map(Math.round);
    wc.sendInputEvent({ type: 'mouseUp', x: ex, y: ey, button: 'left', clickCount: 1 });
    await wait(120);
  };
  // Pen with pressure; pts are [x, y, pressure].
  const pen = async pts => {
    const ev = (type, [x, y, force]) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force });
    await ev('mousePressed', pts[0]);
    for (const p of pts.slice(1)) {
      await ev('mouseMoved', p);
      await wait(6);
    }
    await ev('mouseReleased', pts[pts.length - 1]);
    await wait(120);
  };
  const line = (a, b, n = 24) => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  const ring = (fx, fy, rx, ry, n = 56) => Array.from({ length: n + 1 }, (_, i) => {
    const t = (i / n) * Math.PI * 2.08;
    return at(fx + Math.cos(t) * rx, fy + Math.sin(t) * ry);
  });
  const state = () => js('({ frames: __af.doc.frames.length, cur: __af.cur, holds: __af.doc.frames.map(f => f.hold), undo: __af.undoDepth, playing: __af.playing })');

  // ---------- 1. bouncing ball, frame by frame ----------
  await js('__af.setDoc({ width: 1280, height: 720, fps: 12 })');
  await wait(300);
  await measure();
  report.sheet = rect;

  await key('B');
  await mouse(line(at(0.05, 0.9), at(0.95, 0.9), 30)); // the ground
  await mouse(ring(0.16, 0.22, 0.05, 0.088));
  await key('N');
  await mouse(ring(0.31, 0.5, 0.05, 0.088));
  await key('N');
  // Squash on the ground, drawn with the pen: pressure grows from light to full along the stroke.
  const squash = ring(0.46, 0.8, 0.068, 0.07, 64).map(([x, y], i, a) => [x, y, 0.15 + (0.85 * i) / (a.length - 1)]);
  await key('3');
  await pen(squash);
  await key('1');
  await key('N');
  await mouse(ring(0.61, 0.5, 0.05, 0.088));
  await key('N');
  await key('F');
  await mouse(ring(0.76, 0.24, 0.05, 0.088, 72)); // a calligraphic ring with the flat brush
  // Flat brush direction test on the same frame: "/" runs along the 45° nib (thin), "\" across it (wide).
  await mouse(line(at(0.86, 0.75), at(0.95, 0.59), 30));
  await mouse(line(at(0.86, 0.42), at(0.95, 0.58), 30));
  await key('B');

  let s = await state();
  check('five frames drawn', s.frames === 5 && s.cur === 4, s);
  const inks = await js('__af.doc.frames.map((f, i) => __t.ink(i))');
  check('every frame has ink', inks.every(n => n > 500), inks);

  const W = 1280;
  const H = 720;
  const mid = (a, b) => [(a[0] + b[0]) / 2 * W, (a[1] + b[1]) / 2 * H];
  const thin = mid([0.86, 0.75], [0.95, 0.59]);
  const wide = mid([0.86, 0.42], [0.95, 0.58]);
  // Measure perpendicular to each stroke (in document pixels).
  const tThin = await js(`__t.thickness(4, ${thin[0]}, ${thin[1]}, ${0.16 * H}, ${0.09 * W}, 40)`);
  const tWide = await js(`__t.thickness(4, ${wide[0]}, ${wide[1]}, ${0.16 * H}, ${-0.09 * W}, 40)`);
  check('flat brush: width depends on direction', tWide > tThin * 3, { alongNib: tThin, acrossNib: tWide, size: 22 });

  // Pressure: the squash ring starts light and ends heavy. Compare stroke width near the start and near the end.
  const p0 = squash[4];
  const p1 = squash[56];
  const toDocPt = ([x, y]) => [((x - rect.x) / rect.w) * W, ((y - rect.y) / rect.h) * H];
  const [ax, ay] = toDocPt(p0);
  const [bx, by] = toDocPt(p1);
  const cx = 0.46 * W;
  const cy = 0.8 * H;
  const tLight = await js(`__t.thickness(2, ${ax}, ${ay}, ${ax - cx}, ${ay - cy}, 20)`);
  const tHeavy = await js(`__t.thickness(2, ${bx}, ${by}, ${bx - cx}, ${by - cy}, 20)`);
  check('pen pressure changes width', tHeavy > tLight * 2, { light: tLight, heavy: tHeavy });

  // ---------- 2. onion skin ----------
  await key('Left');
  await key('Left');
  s = await state();
  const tints = await js('__t.tints()');
  check('onion skin shows previous (red) and next (green)', s.cur === 2 && tints.red > 300 && tints.green > 300, tints);
  await wait(300);
  await shot('onion.png');

  // ---------- 3. undo / redo ----------
  const before = await js('__t.ink(2)');
  await mouse(line(at(0.38, 0.95), at(0.54, 0.95), 12));
  const drawn = await js('__t.ink(2)');
  await key('Z', ['control']);
  const undone = await js('__t.ink(2)');
  await key('Y', ['control']);
  const redone = await js('__t.ink(2)');
  await key('Z', ['control']);
  check('undo and redo a stroke', drawn > before && undone === before && redone === drawn && (await js('__t.ink(2)')) === before, { before, drawn, undone, redone });

  // ---------- 4. frame operations ----------
  await key('D');
  s = await state();
  const dupOk = s.frames === 6 && s.cur === 3 && (await js('__t.ink(3)')) === before;
  await key('=');
  const holdUp = (await state()).holds[3];
  await key('-');
  await key('-');
  const holdDown = (await state()).holds[3];
  await key('Right', ['alt']);
  const moved = (await state()).cur;
  await key('Delete', ['shift']);
  s = await state();
  check('duplicate, hold, move, delete', dupOk && holdUp === 3 && holdDown === 1 && moved === 4 && s.frames === 5, { dupOk, holdUp, holdDown, moved, after: s });

  // ---------- 5. playback ----------
  await key('Home');
  const seen = new Set();
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  for (let k = 0; k < 24; k++) {
    await wait(50);
    seen.add(await js('__af.cur'));
  }
  const wasPlaying = await js('__af.playing');
  await key('Space');
  s = await state();
  check('playback runs through frames', wasPlaying && seen.size >= 4 && !s.playing, { seen: [...seen] });

  // ---------- 6. save and export the animation ----------
  const project = path.join(out, 'ball.artframes');
  await js(`__af.save(${JSON.stringify(project)})`);
  report.inksSaved = await js('__af.doc.frames.map((f, i) => __t.ink(i))');
  const total = s.holds.reduce((a, b) => a + b, 0);

  const pngDir = path.join(out, 'png');
  let r = await js(`__af.exportTo({ kind: 'png', target: ${JSON.stringify(pngDir)}, name: 'ball', scale: 1, withRef: false, transparent: true })`);
  const pngs = fs.existsSync(pngDir) ? fs.readdirSync(pngDir).filter(f => f.endsWith('.png')).sort() : [];
  const pngHead = pngs[0] && fs.readFileSync(path.join(pngDir, pngs[0]));
  check('PNG sequence: one file per tick', pngs.length === total && pngHead.readUInt32BE(16) === 1280 && pngHead.readUInt32BE(20) === 720, { files: pngs.length, total, first: pngs[0] });

  const gifFile = path.join(out, 'ball.gif');
  await js(`__af.exportTo({ kind: 'gif', target: ${JSON.stringify(gifFile)}, name: 'ball', scale: 0.5, withRef: false })`);
  const gif = fs.existsSync(gifFile) && gifInfo(fs.readFileSync(gifFile));
  check('GIF: one image per drawing, timing kept', gif && gif.frames === 5 && gif.width === 640 && Math.abs(gif.seconds - total / 12) < 0.05, gif);

  const webm = path.join(out, 'ball.webm');
  r = await js(`__af.exportTo({ kind: 'webm', target: ${JSON.stringify(webm)}, name: 'ball', scale: 0.5, withRef: false })`);
  const webmInfo = await js(PROBE(webm));
  check('WebM animation', Math.abs(webmInfo.duration - total / 12) < 0.1 && webmInfo.width === 640, { ...webmInfo, codec: r.codec });

  // ---------- 7. video reference ----------
  const videoFile = path.join(out, 'test-video.mp4');
  report.testVideo = await js(MAKE_VIDEO(videoFile));
  await js('__af.setDoc({ width: 1920, height: 1080, fps: 24 })');
  await js(`__af.loadReference(${JSON.stringify(videoFile)})`);
  await wait(500);
  s = await state();
  const docInfo = await js('({ w: __af.doc.width, h: __af.doc.height, fps: __af.doc.fps, vfps: __af.ref.fps, hasAudio: __af.ref.hasAudio })');
  check('empty project adopts the video', docInfo.w === 640 && docInfo.h === 360 && docInfo.fps === 24 && s.frames === 24 && s.holds.every(h => h === 2), { ...docInfo, frames: s.frames });

  // Step through frames: frame i starts at tick 2i, so the grey square must read about 10 * i.
  const levels = [];
  for (let i = 0; i < 6; i++) {
    if (i) await key('Right');
    for (let k = 0; k < 40; k++) {
      if (await js('__af.ref.shownTick === __af.cur * 2')) break;
      await wait(25);
    }
    levels.push((await js('__t.refPixel(20, 20)'))[0]);
  }
  check('video reference follows the frames', levels.every((v, i) => Math.abs(v - 10 * i) <= 8), levels);

  // Doodle in red on frames 2-4 (round on 2 and 3, flat on 4), right over the moving ball.
  await key('Home');
  await key('Right');
  await measure();
  await key('3');
  await key('B');
  await mouse(ring(0.35, 0.62, 0.05, 0.09));
  await mouse(line(at(0.3, 0.45), at(0.4, 0.45), 10));
  await key('Right');
  await mouse(ring(0.38, 0.62, 0.05, 0.09));
  await key('Right');
  await key('F');
  await mouse(ring(0.41, 0.62, 0.05, 0.09, 64));
  await key('B');
  await wait(400);
  await shot('video.png');

  // Playback with the video: the shown video frame must match the animation tick, and the sound must run.
  await key('Home');
  await wait(300);
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  const pairs = [];
  for (let k = 0; k < 16; k++) {
    await wait(70);
    pairs.push(await js(`(() => {
      const a = document.getElementById('audio');
      return { tick: __af.doc.frames.slice(0, __af.cur).reduce((s, f) => s + f.hold, 0), video: Math.round(__t.refPixel(20, 20)[0] / 5), audio: +a.currentTime.toFixed(3), paused: a.paused };
    })()`));
  }
  await key('Space');
  // Drawings change every 2 ticks, so the video may lead the drawing's start tick by up to 2 frames (plus one for timing).
  const inSync = pairs.filter(p => p.video - p.tick >= -1 && p.video - p.tick <= 3).length;
  const audioRan = pairs.some(p => !p.paused) && pairs[pairs.length - 1].audio > pairs[0].audio + 0.3;
  check('playback over video: frames in sync, sound plays', new Set(pairs.map(p => p.video)).size >= 6 && inSync >= pairs.length * 0.8 && audioRan, pairs);

  // Over-video MP4 with sound: at 0.1 s (video frame 2 = drawing 2) expect red ink at the line and the grey square ~10.
  const mp4 = path.join(out, 'over-video.mp4');
  r = await js(`__af.exportTo({ kind: 'mp4', target: ${JSON.stringify(mp4)}, name: 'over', scale: 1, withRef: true, audio: true })`);
  const mp4Info = await js(PROBE(mp4, [['ink', 2.5 / 24, Math.round(0.35 * 640), Math.round(0.45 * 360)], ['square', 2.5 / 24, 20, 20], ['clean', 30.5 / 24, Math.round(0.35 * 640), Math.round(0.45 * 360)]]));
  const ink = mp4Info.samples.ink;
  const sq = mp4Info.samples.square;
  check('MP4 over video keeps video, drawing and sound',
    mp4Info.audio && Math.abs(mp4Info.duration - 2) < 0.1 && mp4Info.width === 640 && ink[0] > 150 && ink[1] < 110 && Math.abs(sq[0] - 10) <= 10,
    { ...mp4Info, codec: r.codec, audioKept: r.audio });

  const gifOver = path.join(out, 'over-video.gif');
  await js(`__af.exportTo({ kind: 'gif', target: ${JSON.stringify(gifOver)}, name: 'over', scale: 0.5, withRef: true })`);
  const gif2 = fs.existsSync(gifOver) && gifInfo(fs.readFileSync(gifOver));
  check('GIF over video: one image per tick', gif2 && gif2.frames === 48 && gif2.width === 320 && Math.abs(gif2.seconds - 2) < 0.06, gif2);

  // ---------- 8. 29.97 fps: late frames must still line up ----------
  const ntsc = path.join(out, 'ntsc.mp4');
  await js(MAKE_NTSC(ntsc));
  await js('__af.setDoc({ width: 1280, height: 720, fps: 24 })');
  await js(`__af.loadReference(${JSON.stringify(ntsc)})`);
  await wait(300);
  const ntscDoc = await js('({ fps: __af.doc.fps, frames: __af.doc.frames.length, exact: __af.doc.fps === 30000 / 1001 })');
  // Frame 140 starts at tick 280: draw a mark there and read which video frame the editor shows.
  await js('__af.go(140)');
  for (let k = 0; k < 80; k++) {
    if (await js('__af.ref.shownTick === 280')) break;
    await wait(25);
  }
  const decode = px => Math.round(px[1][0] / 40) * 50 + Math.round(px[0][0] / 5);
  const shown = decode(await js('[__t.refPixel(20, 20), __t.refPixel(70, 20)]'));
  await measure();
  await key('3');
  await mouse(line(at(0.4, 0.6), at(0.6, 0.6), 12));
  const ntscMp4 = path.join(out, 'ntsc-over.mp4');
  await js(`__af.exportTo({ kind: 'mp4', target: ${JSON.stringify(ntscMp4)}, name: 'ntsc', scale: 1, withRef: true, audio: false })`);
  const T = j => (j + 0.5) * 1001 / 30000;
  const probe = await js(PROBE(ntscMp4, [279, 280, 281, 282].map(j => [String(j), T(j), Math.round(0.5 * 640), Math.round(0.6 * 360)])));
  const red = ([r, g]) => r > 150 && g < 110;
  const marks = Object.fromEntries(Object.entries(probe.samples).map(([j, px]) => [j, red(px)]));
  check('29.97 fps: frame 140 = video frame 280, in the editor and in the export',
    ntscDoc.exact && ntscDoc.frames === 150 && shown === 280 && !marks[279] && marks[280] && marks[281] && !marks[282] && Math.abs(probe.fps - 29.97) < 0.01,
    { ...ntscDoc, shown, marks, fps: probe.fps, duration: probe.duration });

  // ---------- 9. reopen the saved project ----------
  await js(`__af.open(${JSON.stringify(project)})`);
  await wait(300);
  const inksLoaded = await js('__af.doc.frames.map((f, i) => __t.ink(i))');
  check('project reopens identical', JSON.stringify(inksLoaded) === JSON.stringify(report.inksSaved), { saved: report.inksSaved, loaded: inksLoaded });

  // A picture as reference: loads under the drawing without touching the project size, exports underneath,
  // travels inside the project file.
  const picture = path.join(out, 'reference.png');
  await js(`(async () => {
    const c = document.createElement('canvas'); c.width = 800; c.height = 800;
    const g = c.getContext('2d');
    g.fillStyle = '#d9e8f5'; g.fillRect(0, 0, 800, 800);
    g.fillStyle = '#2a7a4b'; g.fillRect(300, 300, 200, 200);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    await af.write(${JSON.stringify(picture)}, new Uint8Array(await blob.arrayBuffer()));
    return true;
  })()`);
  await js(`__af.loadReference(${JSON.stringify(picture)})`);
  const pic = await js('({ kind: __af.ref.kind, w: __af.doc.width, frames: __af.doc.frames.length, centre: __t.refPixel(640, 360), side: __t.refPixel(100, 360) })');
  const withPic = path.join(out, 'with-picture.artframes');
  await js(`__af.save(${JSON.stringify(withPic)})`);
  const picPng = path.join(out, 'png-picture');
  await js(`__af.exportTo({ kind: 'png', target: ${JSON.stringify(picPng)}, name: 'pic', scale: 0.5, withRef: true })`);
  const firstPic = fs.existsSync(picPng) ? fs.readdirSync(picPng).sort()[0] : null;
  const exported = firstPic ? await js(`(async () => {
    const bmp = await createImageBitmap(new Blob([await af.read(${JSON.stringify(path.join(picPng, firstPic))})]));
    return __t.pixel(bmp, 320, 180);
  })()`) : null;
  await js(`__af.open(${JSON.stringify(withPic)})`);
  const reopened = await js('({ kind: __af.ref && __af.ref.kind, centre: __t.refPixel(640, 360) })');
  const green = px => px && px[1] > px[0] + 50 && px[1] > px[2] + 30;
  check('picture reference: fits, exports underneath, saved inside the project',
    pic.kind === 'image' && pic.w === 1280 && pic.frames === 5 && green(pic.centre) && pic.side[3] === 0 && green(exported) && reopened.kind === 'image' && green(reopened.centre),
    { pic, exported, reopened });

  await js(`__af.open(${JSON.stringify(project)})`);

  // ---------- 10. own reference: a drawing of its own under every frame ----------
  // Tab switches the brush to it; a calligraphic wave drawn there must not touch any frame, must show under the
  // other frames, hide with Shift+R, undo like a stroke, copy to and from frames, export only when asked and
  // travel in the project file.
  await wait(300);
  await measure();
  await key('Home');
  const inksBefore = await js('__af.doc.frames.map((f, i) => __t.ink(i))');
  await key('Tab');
  const mode = await js(`({ edit: __af.editSketch, badge: getComputedStyle(document.getElementById('modeBadge')).display !== 'none',
    button: document.querySelector('#target [data-target=sketch]').classList.contains('on') })`);
  await key('F');
  await key('1');
  await js('__af.setSize(28); true');
  await mouse(Array.from({ length: 70 }, (_, k) => at(0.08 + (0.84 * k) / 69, 0.12 + 0.05 * Math.sin(k / 5))));
  const drawnSketch = await js('__t.sketchInk()');
  const inksAfter = await js('__af.doc.frames.map((f, i) => __t.ink(i))');
  await shot('sketch.png');
  await key('Tab');
  const backToFrames = !(await js('__af.editSketch'));
  await key('Right');
  await key('Right');
  const spot = await js('__t.sketchSpot()');
  const sceneShown = spot && (await js(`__t.scenePixel(${spot[0]}, ${spot[1]})`));
  await key('R', ['shift']);
  const sceneHidden = spot && (await js(`__t.scenePixel(${spot[0]}, ${spot[1]})`));
  await key('R', ['shift']);
  await key('Z', ['control']);
  const sketchUndone = await js('__t.sketchInk()');
  await key('Y', ['control']);
  const sketchRedone = await js('__t.sketchInk()');
  check('own reference: drawn on its own layer, under every frame',
    mode.edit && mode.badge && mode.button && backToFrames && drawnSketch > 3000 && JSON.stringify(inksAfter) === JSON.stringify(inksBefore) &&
      !!spot && Math.max(...sceneShown.slice(0, 3)) < 200 && sceneHidden.slice(0, 3).every(v => v === 255) && sketchUndone === 0 && sketchRedone === drawnSketch,
    { mode, backToFrames, drawnSketch, inksBefore, inksAfter, spot, sceneShown, sceneHidden, sketchUndone, sketchRedone });

  // Frame 1's ball goes into the own reference; then the reference goes into the last frame, under its drawing.
  await key('Home');
  await js("document.getElementById('frameToSketch').click(); true");
  const intoRef = await js("__t.covered(__af.readFrame(0), __af.readLayer('sketch'))");
  await key('End');
  const inkLast = await js('__t.ink(__af.cur)');
  await js("document.getElementById('sketchToFrame').click(); true");
  const intoFrame = await js("({ ink: __t.ink(__af.cur), covered: __t.covered(__af.readLayer('sketch'), __af.readFrame(__af.cur)) })");
  await key('Z', ['control']);
  const restored = await js('__t.ink(__af.cur)');
  check('own reference: frame to reference and back', intoRef > 0.99 && intoFrame.ink > inkLast && intoFrame.covered > 0.99 && restored === inkLast,
    { intoRef, inkLast, intoFrame, restored });

  // Exports leave it out unless asked; the project file keeps it with its opacity.
  const noSketch = path.join(out, 'png-no-sketch');
  const withSketch = path.join(out, 'png-sketch');
  await js(`__af.exportTo({ kind: 'png', target: ${JSON.stringify(noSketch)}, name: 'a', scale: 1, withRef: false })`);
  await js(`__af.exportTo({ kind: 'png', target: ${JSON.stringify(withSketch)}, name: 'a', scale: 1, withRef: false, withSketch: true })`);
  const firstPixel = dir => js(`(async () => {
    const bmp = await createImageBitmap(new Blob([await af.read(${JSON.stringify(path.join(dir, 'a_0001.png'))})]));
    return __t.pixel(bmp, ${spot ? spot.join(', ') : '0, 0'});
  })()`);
  const pxNo = await firstPixel(noSketch);
  const pxYes = await firstPixel(withSketch);
  await js("(() => { const r = document.getElementById('sketchOpacity'); r.value = 35; r.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  const sketchSaved = await js('__t.sketchInk()');
  const ownFile = path.join(out, 'own-reference.artframes');
  await js(`__af.save(${JSON.stringify(ownFile)})`);
  await js(`__af.open(${JSON.stringify(project)})`);
  const plain = await js('__af.sketch');
  await js(`__af.open(${JSON.stringify(ownFile)})`);
  const reopenedSketch = await js('({ ...__af.sketch, ink: __t.sketchInk(), edit: __af.editSketch })');
  check('own reference: exported only when asked, saved in the project',
    pxNo.slice(0, 3).every(v => v === 255) && Math.max(...pxYes.slice(0, 3)) < 80 && !plain.drawn &&
      reopenedSketch.drawn && reopenedSketch.ink === sketchSaved && Math.abs(reopenedSketch.opacity - 0.35) < 1e-6 && reopenedSketch.visible && !reopenedSketch.edit,
    { pxNo, pxYes, plain, sketchSaved, reopened: reopenedSketch });
  await js(`__af.open(${JSON.stringify(project)})`);

  // ---------- 11. the pen's cursor never gets lost ----------
  // The stage hides the system cursor and draws its own ring. Whatever the pen and the tablet driver do, the ring must
  // be back under the pen as soon as it hovers over the sheet: after a stroke, after leaving the hover range, when
  // another pointer (the driver's mouse) leaves the stage, after a stroke released outside, across Tab. And a faded
  // toast must not keep catching the pen.
  await wait(200);
  await measure();
  const penAt = ([x, y], buttons = 0, type = 'mouseMoved') =>
    cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1, pointerType: 'pen', force: buttons ? 0.6 : 0 });
  const mouseAt = ([x, y]) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'mouse' });
  const hover = async pts => {
    for (const p of pts) {
      await penAt(p);
      await wait(12);
    }
    await wait(60);
  };
  const under = async p => {
    const c = await js('__t.cursor()');
    return { shown: c.shown, off: +Math.hypot(c.x - p[0], c.y - p[1]).toFixed(1) };
  };
  const side = await js("(() => { const r = document.getElementById('side').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()");
  const P = at(0.5, 0.5);
  const Q = at(0.62, 0.42);
  const pointer = {};
  await key('B');
  await hover(line(at(0.3, 0.5), P, 8));
  pointer.hover = await under(P);
  await pen(line(P, at(0.56, 0.62), 12).map(p => [...p, 0.6]));
  await hover(line(at(0.56, 0.62), Q, 6));
  pointer.afterStroke = await under(Q);
  await penAt([-30, Q[1]]); // out of the window: like lifting the pen out of hover range
  await wait(100);
  pointer.awayHidden = !(await js('__t.cursor()')).shown;
  await hover(line(at(0.03, 0.42), Q, 8));
  pointer.backInRange = await under(Q);
  await mouseAt(at(0.4, 0.4)); // the driver's mouse is over the stage too...
  await wait(40);
  await hover([P]);
  await mouseAt(side); // ...and leaves it while the pen stays
  await wait(80);
  await hover(line(P, Q, 6));
  pointer.otherPointerLeft = await under(Q);
  await pen(line(Q, side, 14).map(p => [...p, 0.6])); // a stroke that ends over the side panel
  await hover(line(at(0.97, 0.45), P, 8));
  pointer.releasedOutside = await under(P);
  await key('Tab');
  await hover(line(P, Q, 4));
  pointer.ownReference = await under(Q);
  await key('Tab');
  await hover(line(Q, P, 4));
  pointer.backToFrames = await under(P);
  // A clickable toast ("show in folder") fades out; the place where it was must belong to the stage again.
  await js(`__af.exportTo({ kind: 'gif', target: ${JSON.stringify(path.join(out, 'toast.gif'))}, name: 'toast', scale: 0.25, withRef: false })`);
  const toastSpot = await js(`(async () => {
    const t = document.getElementById('toast');
    const r = t.getBoundingClientRect();
    const spot = [r.x + r.width / 2, r.y + r.height / 2];
    for (let k = 0; k < 80 && t.classList.contains('show'); k++) await new Promise(res => setTimeout(res, 100));
    return { spot, faded: !t.classList.contains('show') };
  })()`);
  await hover([toastSpot.spot]);
  pointer.whereToastWas = { ...(await under(toastSpot.spot)), faded: toastSpot.faded };
  const okSeen = v => v.shown && v.off < 3;
  check('pen cursor stays visible',
    ['hover', 'afterStroke', 'backInRange', 'otherPointerLeft', 'releasedOutside', 'ownReference', 'backToFrames', 'whereToastWas'].every(k => okSeen(pointer[k])) &&
      pointer.awayHidden && pointer.whereToastWas.faded,
    pointer);
  await js(`__af.open(${JSON.stringify(project)})`);

  // Donate window from donate.json.
  await js('af.openDonate(); true');
  let donateWin = null;
  for (let k = 0; k < 60 && !donateWin; k++) {
    await wait(100);
    donateWin = BrowserWindow.getAllWindows().find(w => w !== win && w.isVisible());
  }
  if (donateWin) {
    await wait(300);
    fs.writeFileSync(path.join(out, 'donate.png'), (await donateWin.webContents.capturePage()).toPNG());
    const coins = await donateWin.webContents.executeJavaScript("document.querySelectorAll('.coin').length");
    check('donate window', coins >= 1, { coins, size: donateWin.getContentSize() });
    donateWin.destroy();
  } else {
    check('donate window', false, 'did not open');
  }

  // Final picture for the README: the ball with onion skin on its squash frame.
  await key('Home');
  await key('Right');
  await key('Right');
  await wait(500);
  await shot('final.png');

  // Dialogs, for a look at the wording.
  await key('E', ['control']);
  await wait(400);
  await shot('export-dialog.png');
  await key('Escape');
  await key('F1');
  await wait(300);
  await shot('help.png');
  await key('Escape');

  // ---------- 12. a big brush on a 4K sheet stays smooth ----------
  await js('__af.setDoc({ width: 3840, height: 2160, fps: 24 })');
  await wait(300);
  await measure();
  for (const [tool, size] of [['round', 160], ['flat', 220]]) {
    await js(`__af.setTool('${tool}'); __af.setSize(${size}); __af.perf.moves = 0; __af.perf.ms = 0; __af.perf.max = 0;
      window.__frames = []; window.__stop = false;
      (function loop(t) { __frames.push(t); if (!__stop) requestAnimationFrame(loop); })(performance.now()); true`);
    const zigzag = Array.from({ length: 360 }, (_, i) => at(0.05 + 0.9 * (i / 359), 0.5 + 0.35 * Math.sin(i / 9)));
    await mouse(zigzag);
    report[`perf4k_${tool}`] = await js(`(() => {
      __stop = true;
      const d = __frames.slice(1).map((t, i) => t - __frames[i]).sort((a, b) => a - b);
      const p = __af.perf;
      return { frames: d.length, medianMs: +d[d.length >> 1].toFixed(1), p95Ms: +d[Math.floor(d.length * 0.95)].toFixed(1),
               batches: p.moves, avgBatchMs: +(p.ms / p.moves).toFixed(2), maxBatchMs: +p.max.toFixed(1) };
    })()`);
  }
  const pr = report.perf4k_round;
  const pf = report.perf4k_flat;
  check('4K: drawing keeps up with the display', pr.p95Ms < 34 && pf.p95Ms < 34 && pr.avgBatchMs < 4 && pf.avgBatchMs < 4, { round: pr, flat: pf });

  // ---------- demo picture: a bouncing ball drawn with the pen, two ghosts each way ----------
  await js('__af.setDoc({ width: 1920, height: 1080, fps: 24 }); true');
  await js("document.querySelectorAll('.stepper button:last-child').forEach(b => b.click()); true"); // two ghosts each way
  await wait(300);
  await measure();
  await key('B');
  const BALL = [
    [0.13, 0.2, 0.045, 0.08], [0.21, 0.33, 0.042, 0.088], [0.29, 0.55, 0.039, 0.095], [0.36, 0.765, 0.066, 0.06],
    [0.43, 0.55, 0.039, 0.095], [0.51, 0.36, 0.043, 0.085], [0.6, 0.27, 0.045, 0.08], [0.69, 0.31, 0.045, 0.08],
  ];
  for (let i = 0; i < BALL.length; i++) {
    if (i) await key('N');
    await key('2');
    await js('__af.setSize(4); true');
    await mouse(line(at(0.04, 0.87), at(0.96, 0.87), 30));
    await key('1');
    await js('__af.setSize(10); true');
    const [fx, fy, rx, ry] = BALL[i];
    await pen(ring(fx, fy, rx, ry, 64).map(([x, y], k, a) => [x, y, 0.45 + 0.55 * Math.sin((Math.PI * k) / (a.length - 1))]));
    // a highlight, like on a model sheet
    await pen(Array.from({ length: 13 }, (_, k) => {
      const t = Math.PI * (1.08 + (0.32 * k) / 12);
      return [...at(fx + Math.cos(t) * rx * 0.62, fy + Math.sin(t) * ry * 0.62), 0.3 + 0.4 * Math.sin((Math.PI * k) / 12)];
    }));
  }
  await key('Home');
  await key('Right');
  await key('Right');
  await key('Right');
  await wait(500);
  await shot('demo.png');

  // ---------- demo picture: calligraphic loops as the own reference, a ball riding along them ----------
  await js('__af.setDoc({ width: 1920, height: 1080, fps: 24 }); true');
  await wait(300);
  await measure();
  const loops = u => {
    const t = u * Math.PI * 6;
    return [0.12 + 0.76 * u - 0.06 * Math.sin(t), 0.52 - 0.17 * Math.cos(t)];
  };
  await key('Tab');
  await key('F');
  await key('2');
  await js('__af.setSize(40); true');
  await pen(Array.from({ length: 240 }, (_, k) => [...at(...loops(k / 239)), 0.55 + 0.45 * Math.sin((Math.PI * k) / 239)]));
  await key('Tab');
  await key('B');
  await key('1');
  await js('__af.setSize(9); true');
  for (let i = 0; i < 8; i++) {
    if (i) await key('N');
    const [fx, fy] = loops((i + 0.5) / 8);
    await pen(ring(fx, fy, 0.024, 0.043, 48).map(([x, y], k, a) => [x, y, 0.45 + 0.55 * Math.sin((Math.PI * k) / (a.length - 1))]));
  }
  await key('Home');
  for (let k = 0; k < 4; k++) await key('Right');
  await wait(500);
  await shot('own-reference.png');

  report.errors = report.console.filter(l => /^(error|3):/i.test(l) || /Uncaught|TypeError|ReferenceError/.test(l));
  check('no errors in the console', !report.errors.length, report.errors);
  report.failed = Object.entries(report.checks).filter(([, c]) => !c.ok).map(([n]) => n);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  wc.debugger.detach();
  app.exit(report.failed.length ? 1 : 0);
};
