// Demo GIFs for the README: `electron . --demo <outdir>`. Drives the real app with mouse and pen events at a human
// pace, like the self-test, records the window with capturePage about 12 times a second and writes looping GIFs.
// Each GIF has one palette, and every frame after the first keeps only the pixels that changed (the rest is
// transparent over the previous frame), so the still parts of the window cost nothing. A small caption at the bottom
// of the stage names the key being pressed; everything else on screen is the app itself.
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const wait = ms => new Promise(r => setTimeout(r, ms));
// Runs fn(i) for i < n, one every `ms` by the clock: Windows timers fire in ~16 ms steps, so plain waits add up.
async function paced(n, ms, fn) {
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await fn(i);
    const left = t0 + (i + 1) * ms - Date.now();
    if (left > 1) await wait(left);
  }
}

const WINDOW = [1100, 700]; // content size of the recorded window
const WIDTH = 800; // GIF width
const STEP = 66; // ms between captures, about 15 a second
const END_HOLD = 1200; // ms the last frame stays before the GIF loops

// A ball rolling and bouncing over a meadow, 1 s at 24 fps: something to doodle on.
const MAKE_VIDEO = file => `(async () => {
  const mb = await import('./node_modules/mediabunny/dist/bundles/mediabunny.min.mjs');
  const W = 640, H = 360, FPS = 24, N = 24;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
  const codec = await mb.getFirstEncodableVideoCodec(['avc', 'vp9'], { width: W, height: H });
  const video = new mb.CanvasSource(c, { codec, quality: mb.QUALITY_VERY_HIGH, keyFrameInterval: 0.5 });
  output.addVideoTrack(video, { frameRate: FPS });
  await output.start();
  for (let i = 0; i < N; i++) {
    // Flat colours: a GIF palette would cut a gradient sky into stripes.
    g.fillStyle = '#8ec3ea'; g.fillRect(0, 0, W, 270);
    g.fillStyle = '#ffffff';
    for (const [cx, cy, s] of [[110, 70, 1], [470, 50, 1.3], [330, 120, 0.8]]) {
      g.beginPath(); g.ellipse(cx, cy, 46 * s, 16 * s, 0, 0, Math.PI * 2); g.ellipse(cx + 22 * s, cy - 12 * s, 26 * s, 18 * s, 0, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#6f9e57'; g.fillRect(0, 270, W, H - 270);
    const x = 160 + i * 13, y = 234 - 70 * Math.abs(Math.sin(i * Math.PI / 12)); // as videoBall() below
    g.fillStyle = 'rgba(0,0,0,.18)'; g.beginPath(); g.ellipse(x, 272, 30, 6, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f2c037'; g.beginPath(); g.arc(x, y, 36, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#3b2a12';
    g.beginPath(); g.arc(x - 12, y - 8, 4.5, 0, Math.PI * 2); g.arc(x + 12, y - 8, 4.5, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#3b2a12'; g.lineWidth = 3.5; g.lineCap = 'round';
    g.beginPath(); g.arc(x, y + 4, 14, 0.2 * Math.PI, 0.8 * Math.PI); g.stroke();
    await video.add(i / FPS, 1 / FPS);
  }
  await output.finalize();
  await af.write(${JSON.stringify(file)}, new Uint8Array(output.target.buffer));
  return true;
})()`;
// The ball's centre in the video above, in video pixels, at frame i.
const videoBall = i => [160 + i * 13, 234 - 70 * Math.abs(Math.sin((i * Math.PI) / 12))];

// Captures the window while a scene plays, then turns the captures into a GIF.
function recorder(wc) {
  let frames = [];
  let on = false;
  let loop = null;
  return {
    start() {
      frames = [];
      on = true;
      loop = (async () => {
        while (on) {
          const t = Date.now();
          const img = (await wc.capturePage()).resize({ width: WIDTH, quality: 'best' });
          const { width, height } = img.getSize();
          frames.push({ t, width, height, bgra: img.toBitmap() });
          const left = STEP - (Date.now() - t);
          if (left > 0) await wait(left);
        }
      })();
    },
    async stop() {
      on = false;
      await loop;
      return frames;
    },
  };
}

function writeGif(frames, file) {
  const { width, height } = frames[0];
  const rgba = frames.map(f => {
    const px = new Uint8Array(f.bgra.length);
    for (let k = 0; k < px.length; k += 4) {
      px[k] = f.bgra[k + 2];
      px[k + 1] = f.bgra[k + 1];
      px[k + 2] = f.bgra[k];
      px[k + 3] = 255;
    }
    return px;
  });
  // One palette from a spread of frames; the last entry is kept free for "unchanged".
  const picks = Array.from({ length: Math.min(12, rgba.length) }, (_, i) => rgba[Math.floor((i * (rgba.length - 1)) / Math.max(1, Math.min(12, rgba.length) - 1))]);
  const sample = new Uint8Array(picks.reduce((n, p) => n + p.length, 0));
  picks.reduce((o, p) => (sample.set(p, o), o + p.length), 0);
  const palette = quantize(sample, 255);
  while (palette.length < 255) palette.push([0, 0, 0]);
  palette.push([255, 0, 255]);
  const CLEAR = 255;

  // Delays from the real capture times, rounded on the running clock so the GIF keeps the real pace.
  const cs = ms => Math.round(ms / 10);
  const t0 = frames[0].t;
  const at = i => (i < frames.length ? frames[i].t - t0 : frames[frames.length - 1].t - t0 + END_HOLD);
  const kept = [];
  let prev = null;
  for (let i = 0; i < frames.length; i++) {
    const idx = applyPalette(rgba[i], palette);
    const end = cs(at(i + 1));
    if (prev) {
      const diff = new Uint8Array(idx.length);
      let changed = 0;
      for (let k = 0; k < idx.length; k++) {
        if (idx[k] === prev[k]) diff[k] = CLEAR;
        else {
          diff[k] = idx[k];
          changed++;
        }
      }
      if (!changed) {
        kept[kept.length - 1].end = end;
        continue;
      }
      kept.push({ data: diff, start: kept[kept.length - 1].end, end });
    } else {
      kept.push({ data: idx, start: 0, end });
    }
    prev = idx;
  }
  const gif = GIFEncoder();
  kept.forEach((k, i) => {
    const delay = Math.max(2, k.end - k.start) * 10;
    if (i === 0) gif.writeFrame(k.data, width, height, { palette, delay });
    else gif.writeFrame(k.data, width, height, { delay, transparent: true, transparentIndex: CLEAR, dispose: 1 });
  });
  gif.finish();
  fs.writeFileSync(file, gif.bytes());
  // What the last frame must look like once a viewer has stacked them all, to check the encoding against.
  const last = new Uint8Array(prev.length * 3);
  prev.forEach((c, k) => last.set(palette[c], k * 3));
  return {
    info: {
      file: path.basename(file), width, height, captured: frames.length, captureFps: +((frames.length - 1) / ((frames[frames.length - 1].t - t0) / 1000)).toFixed(1),
      frames: kept.length, seconds: +(kept[kept.length - 1].end / 100).toFixed(1), mb: +(fs.statSync(file).size / 1048576).toFixed(2),
    },
    last,
  };
}

module.exports = async function demo({ win, out }) {
  fs.mkdirSync(out, { recursive: true });
  const wc = win.webContents;
  const js = code => wc.executeJavaScript(code);
  await new Promise(r => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
  win.unmaximize();
  win.setContentSize(...WINDOW);
  win.center();
  await wait(1200);
  win.focus();
  wc.focus();
  wc.debugger.attach('1.3');
  const cdp = (method, params) => wc.debugger.sendCommand(method, params);
  const rec = recorder(wc);
  const report = {};

  // The caption: what is being pressed, at the bottom of the stage.
  await js(`(() => {
    const el = document.createElement('div');
    el.id = 'demoKey';
    el.style.cssText = 'position:absolute;left:50%;bottom:16px;transform:translateX(-50%);z-index:5;padding:7px 14px;border-radius:9px;' +
      'background:rgba(21,23,28,.9);box-shadow:0 0 0 1px rgba(255,255,255,.14);color:#e7e9ee;font:600 17px/1.2 "Segoe UI",sans-serif;' +
      'white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .15s';
    document.getElementById('stage').append(el);
    return true;
  })()`);
  const caption = text => js(`(() => {
    const el = document.getElementById('demoKey');
    if (${JSON.stringify(!!text)}) el.innerHTML = ${JSON.stringify(text || '')};
    el.style.opacity = ${text ? 1 : 0};
    return true;
  })()`);
  const kbd = k => `<kbd style="font-size:15px;padding:3px 7px;margin:0 8px 0 0">${k}</kbd>`;

  const key = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await wait(60);
  };
  let rect;
  const measure = async () => {
    rect = await js("(() => { const r = document.getElementById('sheet').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()");
  };
  const at = (fx, fy) => [rect.x + rect.w * fx, rect.y + rect.h * fy];

  // The pen: hover glides to the start, then the stroke with pressure, one point every `ms`. Moves are sent on
  // time without waiting for each answer (a DevTools round trip is about as long as the step); they stay in order.
  let pos = null;
  // Press and release name the left button; a hover move has none.
  const ev = (type, [x, y, force = 0.5], buttons) =>
    cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1, pointerType: 'pen', force });
  const moves = async (n, ms, point, buttons) => {
    const sent = [];
    await paced(n, ms, i => { sent.push(ev('mouseMoved', point(i), buttons)); });
    await Promise.all(sent);
  };
  const glide = async to => {
    const from = pos || [to[0] - 40, to[1] + 30];
    const ms = Math.min(280, Math.max(90, Math.hypot(to[0] - from[0], to[1] - from[1]) * 0.9));
    const n = Math.max(2, Math.round(ms / 16));
    await moves(n, 16, i => {
      const s = (i + 1) / n;
      const e = s * s * (3 - 2 * s);
      return [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e, 0];
    }, 0);
    pos = to;
  };
  const pen = async (pts, ms = 12) => {
    await glide(pts[0]);
    await ev('mousePressed', pts[0], 1);
    await moves(pts.length - 1, ms, i => pts[i + 1], 1);
    await ev('mouseReleased', pts[pts.length - 1], 0);
    pos = pts[pts.length - 1].slice(0, 2);
    await wait(80);
  };
  const ring = (fx, fy, rx, ry, n = 40) => Array.from({ length: n + 1 }, (_, i) => {
    const t = -Math.PI / 2 + (i / n) * Math.PI * 2.06;
    return [...at(fx + Math.cos(t) * rx, fy + Math.sin(t) * ry), 0.4 + 0.6 * Math.sin((Math.PI * i) / n)];
  });
  const line = (a, b, n = 30) => Array.from({ length: n + 1 }, (_, i) => [...at(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n), 0.8]);
  const clickStep = step => js(`document.querySelector('#stepSeg [data-step="${step}"]').click(); true`);
  const fresh = async (width, height, fps) => {
    await js(`__af.setDoc({ width: ${width}, height: ${height}, fps: ${fps} }); true`);
    await wait(400);
    await measure();
    pos = null;
  };
  const record = async (name, scene) => {
    rec.start();
    await scene();
    await caption(null);
    await wait(250);
    const frames = await rec.stop();
    const gif = writeGif(frames, path.join(out, `${name}.gif`));
    report[name] = gif.info;
    // DEMO_PEEK=1 also saves a few stills to look at without a GIF viewer: captures, and the same moments decoded
    // back from the GIF (WebCodecs ImageDecoder composites the partial frames, so this checks the encoding too).
    if (process.env.DEMO_PEEK) {
      for (const q of [0.15, 0.35, 0.55, 0.75, 0.92]) {
        const f = frames[Math.floor(q * (frames.length - 1))];
        fs.writeFileSync(path.join(out, `${name}-${Math.round(q * 100)}.png`), nativeImage.createFromBitmap(f.bgra, { width: f.width, height: f.height }).toPNG());
      }
      await js(`(async () => {
        const dec = new ImageDecoder({ data: await af.read(${JSON.stringify(path.join(out, `${name}.gif`))}), type: 'image/gif' });
        await dec.tracks.ready;
        const n = dec.tracks.selectedTrack.frameCount;
        for (const q of [0.15, 0.35, 0.55, 0.75, 0.92]) {
          const { image } = await dec.decode({ frameIndex: Math.floor(q * (n - 1)) });
          const c = new OffscreenCanvas(image.displayWidth, image.displayHeight);
          c.getContext('2d').drawImage(image, 0, 0);
          image.close();
          const png = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
          await af.write(${JSON.stringify(path.join(out, name))} + '-gif-' + Math.round(q * 100) + '.png', png);
        }
        const { image } = await dec.decode({ frameIndex: n - 1 });
        const c = new OffscreenCanvas(image.displayWidth, image.displayHeight);
        const g = c.getContext('2d');
        g.drawImage(image, 0, 0);
        image.close();
        await af.write(${JSON.stringify(path.join(out, `${name}-last.rgba`))}, new Uint8Array(g.getImageData(0, 0, c.width, c.height).data.buffer));
        return true;
      })()`);
      const raw = fs.readFileSync(path.join(out, `${name}-last.rgba`));
      let off = 0;
      for (let k = 0; k < gif.last.length / 3; k++) {
        for (let ch = 0; ch < 3; ch++) if (Math.abs(raw[k * 4 + ch] - gif.last[k * 3 + ch]) > 2) { off++; break; }
      }
      report[name].lastFrameMismatch = off; // pixels where the decoded GIF differs from what was encoded
      fs.rmSync(path.join(out, `${name}-last.rgba`));
    }
  };

  // ---------- 1. a bouncing ball, frame by frame, with the onion skin; then it plays ----------
  await fresh(1280, 720, 12);
  await js("document.querySelector('.stepper[data-key=prev] button:last-child').click(); true"); // two ghosts back
  await key('Tab'); // the ground goes on the own reference, so it stays under every frame
  await js('__af.setSize(5); true');
  await pen(line([0.05, 0.87], [0.95, 0.87]), 4);
  await key('Tab');
  await key('B');
  await key('1');
  await js('__af.setSize(9); true');
  await wait(300);
  const BALL = [
    [0.14, 0.22, 0.045, 0.08], [0.25, 0.42, 0.043, 0.085], [0.35, 0.69, 0.039, 0.093], [0.43, 0.815, 0.066, 0.052],
    [0.52, 0.59, 0.041, 0.09], [0.62, 0.41, 0.044, 0.082], [0.73, 0.33, 0.045, 0.08],
  ];
  await record('ball', async () => {
    await wait(500);
    for (let i = 0; i < BALL.length; i++) {
      if (i) {
        await caption(`${kbd('N')}новий кадр`);
        await wait(250);
        await key('N');
        await wait(150);
      }
      await pen(ring(...BALL[i]));
    }
    await caption(null);
    await wait(300);
    await caption(`${kbd('Enter')}грати`);
    await wait(400);
    await key('Enter');
    await wait(2600);
    await key('Enter');
    await wait(150);
  });

  // ---------- 2. calligraphy on the own reference, then a ball riding along it ----------
  await fresh(1280, 720, 12);
  const loops = u => {
    const t = u * Math.PI * 6;
    return [0.12 + 0.76 * u - 0.06 * Math.sin(t), 0.52 - 0.17 * Math.cos(t)];
  };
  await record('own-reference', async () => {
    await wait(500);
    await caption(`${kbd('Tab')}малюю свій референс`);
    await wait(450);
    await key('Tab');
    await key('F');
    await key('2');
    await js('__af.setSize(40); true');
    await wait(300);
    await pen(Array.from({ length: 200 }, (_, k) => [...at(...loops(k / 199)), 0.55 + 0.45 * Math.sin((Math.PI * k) / 199)]), 12);
    await wait(400);
    await caption(`${kbd('Tab')}назад до кадрів`);
    await wait(450);
    await key('Tab');
    await key('B');
    await key('1');
    await js('__af.setSize(9); true');
    await wait(300);
    await caption(`анімую поверх, ${kbd('N')}новий кадр`);
    const n = 7;
    for (let i = 0; i < n; i++) {
      if (i) await key('N');
      const [fx, fy] = loops((i + 0.5) / n);
      await pen(ring(fx, fy, 0.026, 0.046, 32), 11);
    }
    await caption(`${kbd('Enter')}грати`);
    await wait(400);
    await key('Enter');
    await wait(2500);
    await key('Enter');
    await wait(150);
  });

  // ---------- 3. a party hat doodled over a video, frame by frame ----------
  const video = path.join(out, 'ball.mp4');
  await js(MAKE_VIDEO(video));
  await fresh(1280, 720, 24);
  await clickStep(3);
  await record('video', async () => {
    await wait(400);
    await caption(`${kbd('Ctrl+I')}відео під кадри`);
    await wait(600);
    await js(`__af.loadReference(${JSON.stringify(video)})`);
    await measure();
    pos = null;
    await wait(1000);
    await key('3');
    await js('__af.setSize(6); true');
    await caption(`малюю на кадрі, ${kbd('→')}наступний`);
    const frames = await js('__af.doc.frames.length');
    for (let i = 0; i < frames; i++) {
      if (i) await key('Right');
      const [bx, by] = videoBall(3 * i + 1);
      const p = (dx, dy) => [(bx + dx) / 640, (by + dy) / 360];
      const hat = [p(-27, -26), p(-4, -92), p(25, -27), p(-27, -26)];
      const pts = [];
      for (let s = 0; s < hat.length - 1; s++) pts.push(...line(hat[s], hat[s + 1], 8).slice(s ? 1 : 0));
      await pen(pts, 11);
      await pen(ring(...p(-4, -97), 9 / 640, 9 / 360, 14), 10);
    }
    await caption(`${kbd('Enter')}грати разом із відео`);
    await key('Home');
    await wait(400);
    await key('Enter');
    await wait(2600);
    await key('Enter');
    await wait(150);
  });

  fs.rmSync(video, { force: true });
  fs.writeFileSync(path.join(out, 'demo.json'), JSON.stringify(report, null, 2));
  wc.debugger.detach();
  await wait(300);
  app.exit(0);
};
