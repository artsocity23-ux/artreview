// Drawing benchmark: `electron . --bench <outdir>`. Runs with vsync and the frame-rate limit off, so frames come as
// fast as the renderer can make them, on a heavy sheet: 3840x2160, a full-size picture reference at 50 %, five
// drawings with two onion ghosts each way. Draws the same zigzags with a 160 px round and a 220 px flat brush at
// "fit" zoom and at 100 %, and switches frames back and forth. Uses only the __af calls every version has, so the
// same file can measure an older build. Writes bench.json.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const wait = ms => new Promise(r => setTimeout(r, ms));

module.exports = async function bench({ win, out }) {
  fs.mkdirSync(out, { recursive: true });
  const wc = win.webContents;
  const js = code => wc.executeJavaScript(code);
  await new Promise(r => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
  await wait(1200);
  win.focus();
  wc.focus();
  const key = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await wait(120);
  };
  let rect;
  const measure = async () => {
    rect = await js("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()");
  };
  const at = (fx, fy) => [Math.round(rect.x + rect.w * fx), Math.round(rect.y + rect.h * fy)];
  const drag = async (pts, gap) => {
    wc.sendInputEvent({ type: 'mouseDown', x: pts[0][0], y: pts[0][1], button: 'left', clickCount: 1 });
    for (const [x, y] of pts.slice(1)) {
      wc.sendInputEvent({ type: 'mouseMove', x, y, button: 'left', modifiers: ['leftButtonDown'] });
      await wait(gap);
    }
    const [x, y] = pts[pts.length - 1];
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await wait(200);
  };
  const zigzag = (n, amp) => Array.from({ length: n }, (_, i) => at(0.08 + 0.84 * (i / (n - 1)), 0.5 + amp * Math.sin(i / 7)));

  const startFrames = () => js(`window.__f = []; window.__stop = false;
    (function loop(t) { __f.push(t); if (!__stop) requestAnimationFrame(loop); })(performance.now()); true`);
  const stopFrames = () => js(`(() => {
    __stop = true;
    const d = __f.slice(1).map((t, i) => t - __f[i]).sort((a, b) => a - b);
    const q = p => +d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(2);
    const avg = d.reduce((a, b) => a + b, 0) / d.length;
    return { frames: d.length, fps: Math.round(1000 / avg), medianMs: q(0.5), p95Ms: q(0.95), worstMs: +d[d.length - 1].toFixed(1) };
  })()`);

  const result = { version: await js('document.getElementById("gl") ? "gpu" : "canvas2d"'), when: new Date().toISOString() };

  // The heavy sheet.
  await js('__af.setDoc({ width: 3840, height: 2160, fps: 24 }); true');
  await wait(300);
  const picture = path.join(out, 'bench-photo.png');
  await js(`(async () => {
    const c = document.createElement('canvas'); c.width = 3840; c.height = 2160;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 3840, 2160);
    grad.addColorStop(0, '#6b8fb5'); grad.addColorStop(1, '#e8c39e');
    g.fillStyle = grad; g.fillRect(0, 0, 3840, 2160);
    for (let i = 0; i < 400; i++) {
      g.fillStyle = 'hsl(' + (i * 37 % 360) + ',45%,' + (30 + i % 40) + '%)';
      g.beginPath(); g.arc((i * 997) % 3840, (i * 613) % 2160, 20 + (i * 7) % 120, 0, Math.PI * 2); g.fill();
    }
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    await af.write(${JSON.stringify(picture)}, new Uint8Array(await blob.arrayBuffer()));
    return true;
  })()`);
  await js(`__af.loadReference(${JSON.stringify(picture)})`);
  await js("document.querySelectorAll('.stepper button:last-child').forEach(b => b.click()); true"); // two ghosts each way
  await measure();
  await key('B');
  await js('__af.setSize(40); true');
  for (let i = 0; i < 5; i++) {
    if (i) await key('N');
    await drag(Array.from({ length: 40 }, (_, k) => at(0.2 + 0.12 * i + 0.1 * Math.cos(k / 6), 0.5 + 0.25 * Math.sin(k / 6))), 4);
  }
  await key('Left');
  await key('Left');
  await wait(500);

  const scenario = async (name, tool, size) => {
    await js(`__af.setTool('${tool}'); __af.setSize(${size}); true`);
    await wait(300);
    await startFrames();
    await drag(zigzag(600, 0.3), 2);
    result[name] = await stopFrames();
    await key('Z', ['control']);
    await wait(300);
  };
  await scenario('fitRound160', 'round', 160);
  await scenario('fitFlat220', 'flat', 220);
  await key('1', ['control']); // 100 %: one document pixel per screen pixel
  await wait(400);
  await scenario('fullRound160', 'round', 160);
  await key('0');
  await wait(400);

  // Flipping between drawings (with ghosts and the picture underneath): time until the new frame is on screen.
  const flips = await js(`(async () => {
    const next = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const d = [];
    for (let k = 0; k < 40; k++) {
      const t = performance.now();
      __af.go(k % 5);
      await next();
      d.push(performance.now() - t);
    }
    d.sort((a, b) => a - b);
    return { medianMs: +d[20].toFixed(2), worstMs: +d[39].toFixed(2) };
  })()`);
  result.flip = flips;
  result.inputBatchMs = await js('+(__af.perf.ms / Math.max(1, __af.perf.moves)).toFixed(3)');
  if (result.version === 'gpu') {
    // GPU time for one full redraw of the sheet at 100 %: wait for the GPU to finish every frame.
    await key('1', ['control']);
    await wait(300);
    result.gpuRedrawMs = await js(`(async () => {
      __af.gpu.sync = true;
      const p = __af.perf; p.renders = 0; p.renderMs = 0; p.renderMax = 0;
      for (let k = 0; k < 60; k++) { __af.go(k % 5); await new Promise(r => requestAnimationFrame(r)); }
      __af.gpu.sync = false;
      return { avg: +(p.renderMs / p.renders).toFixed(2), worst: +p.renderMax.toFixed(2) };
    })()`);
  }
  result.contextLost = await js('!!(__af.gpu && __af.gpu.lost)');
  fs.writeFileSync(path.join(out, 'bench.json'), JSON.stringify(result, null, 2));
  fs.rmSync(picture, { force: true });
  await wait(300);
  app.exit(0);
};
