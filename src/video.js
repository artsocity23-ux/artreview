// The shot: exact frames decoded with WebCodecs through mediabunny. The file is read in byte ranges through the main
// process, so a long video never has to be loaded whole. Paused stepping asks for single frames (cached and
// prefetched), playback decodes sequentially and paces the frames against the caller's clock.
// Frames are the video's own frames, 0-based: frame f starts at first + f / fps.
import { ALL_FORMATS, CanvasSink, CustomSource, Input } from '../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs';

const ar = window.ar;
// NTSC rates are kept exact (30000/1001, not 29.97) so frame times stay on the file's own grid for hours of video.
const STANDARD_FPS = [12, 15, 24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 120];
const CACHE_BYTES = 512 * 1024 * 1024;
const UNSUPPORTED = 'Цей кодек не підтримується. Перекодуй у H.264 (MP4).';

const nextFrame = () => new Promise(r => requestAnimationFrame(r));

export async function openInput(file) {
  const stat = await ar.stat(file);
  if (!stat) throw new Error('Файл не знайдено');
  const source = new CustomSource({
    getSize: () => stat.size,
    read: (start, end) => ar.range(file, start, end),
    prefetchProfile: 'fileSystem',
    maxCacheSize: 64 * 1024 * 1024,
  });
  const input = new Input({ formats: ALL_FORMATS, source });
  input.fileSize = stat.size;
  return input;
}

export async function openVideo(file) {
  const input = await openInput(file);
  let track;
  try {
    track = await input.getPrimaryVideoTrack();
  } catch {
    throw new Error('Не вдалося прочитати файл: це не відео або формат не підтримується');
  }
  if (!track) throw new Error('У файлі немає відео');
  if (!(await track.canDecode())) throw new Error(UNSUPPORTED);
  const first = await track.getFirstTimestamp();
  let end = await track.computeDuration();
  // A long clip is sampled from its first packets. A short one is measured whole from its timestamps: N frames span
  // N - 1 intervals. Frames / (end - first) would be off by a frame, because WebM files from browsers and recorders
  // often give the last frame no duration, and then preview and export frames drift apart.
  const stats = await track.computePacketStats(240);
  let raw = stats.packetCount < 240 && end > first ? stats.packetCount / (end - first) : stats.averagePacketRate || 30;
  let whole = 0;
  if (stats.packetCount < 240 && stats.packetCount >= 3) {
    const m = await track.computeFrameRateMetrics({ targetPacketCount: Infinity }).catch(() => null);
    if (m?.averageFrameRate > 0 && Number.isFinite(m.averageFrameRate)) {
      raw = m.averageFrameRate;
      whole = stats.packetCount;
    }
  }
  const nearest = STANDARD_FPS.reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));
  const fps = Math.abs(nearest - raw) / raw < 0.005 ? nearest : Math.round(raw * 1000) / 1000;
  if (whole) end = Math.max(end, first + whole / fps); // the last frame counts even when its duration is 0
  const audio = await input.getPrimaryAudioTrack().catch(() => null);
  const hasAudio = !!audio && (await audio.canDecode().catch(() => false));
  // Display size: rotation (phone videos) and pixel aspect already applied, so the picture shows upright.
  const width = await track.getDisplayWidth();
  const height = await track.getDisplayHeight();
  const name = file.split(/[\\/]/).pop();
  return new VideoRef({ file, name, size: input.fileSize, input, track, first, end, fps, hasAudio, width, height });
}

export class VideoRef {
  constructor(o) {
    Object.assign(this, o);
    this.duration = Math.max(0, o.end - o.first);
    this.frameCount = Math.max(1, Math.round(this.duration * o.fps));
    this.cache = new Map(); // frame -> canvas, in insertion order for LRU
    this.want = null;
    this.shown = null;
    this.busy = false;
    this.gen = 0; // bumps when the size changes and cached frames go stale
    this.playGen = 0; // bumps to stop a running playback
    this.onFrame = () => {};
  }

  // Decode size for the preview (the picture's size on screen, in device pixels; never above the source).
  layout(w, h) {
    w = Math.max(2, Math.min(this.width, Math.round(w)));
    h = Math.max(2, Math.min(this.height, Math.round(h)));
    if (this.sink && w === this.w && h === this.h) return false;
    this.w = w;
    this.h = h;
    this.sink = new CanvasSink(this.track, { width: w, height: h, fit: 'fill' });
    this.playSink = new CanvasSink(this.track, { width: w, height: h, fit: 'fill', poolSize: 4 });
    this.maxCache = Math.max(16, Math.floor(CACHE_BYTES / (w * h * 4)));
    this.cache.clear();
    this.shown = null;
    this.gen++;
    return true;
  }

  // Timestamp in the file for frame f. The quarter-frame nudge keeps float error from landing on the previous frame.
  time(f) {
    return this.first + (f + 0.25) / this.fps;
  }

  // Frame index of a decoded frame: the frame whose span holds the middle of the sample.
  frameOf(timestamp, duration) {
    const f = Math.floor((timestamp - this.first + (duration || 1 / this.fps) / 2) * this.fps);
    return Math.max(0, Math.min(this.frameCount - 1, f));
  }

  put(f, canvas) {
    this.cache.delete(f);
    this.cache.set(f, canvas);
    while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value);
  }

  show(f) {
    this.want = f;
    if (!this.busy) this.pump();
  }

  async pump() {
    this.busy = true;
    try {
      while (this.want !== null && this.want !== this.shown) {
        const f = this.want;
        const gen = this.gen;
        let canvas = this.cache.get(f);
        if (canvas === undefined) {
          canvas = (await this.sink.getCanvas(this.time(f)))?.canvas || null;
          if (gen !== this.gen) continue;
          this.put(f, canvas);
        }
        this.shown = f;
        this.onFrame(canvas, f);
      }
    } catch (err) {
      ar.log('video frame failed:', err.message);
    } finally {
      this.busy = false;
    }
  }

  // Decodes the given frames in the background so stepping onto them is instant.
  async prefetch(frames) {
    const missing = [...new Set(frames)].filter(f => f >= 0 && f < this.frameCount && !this.cache.has(f)).sort((a, b) => a - b);
    if (!missing.length || this.prefetching || !this.sink) return;
    this.prefetching = true;
    const gen = this.gen;
    try {
      let i = 0;
      for await (const wc of this.sink.canvasesAtTimestamps(missing.map(f => this.time(f)))) {
        if (gen !== this.gen || this.busy) break;
        this.put(missing[i++], wc?.canvas || null);
      }
    } catch (err) {
      ar.log('video prefetch failed:', err.message);
    } finally {
      this.prefetching = false;
    }
  }

  // clock() returns the playback position in seconds since frame 0. Frames are shown once the clock reaches them.
  async play(from, clock) {
    const gen = ++this.playGen;
    this.shown = null;
    // The decoder needs a moment to seek; a cached first frame goes up at once instead of the last one lingering.
    const cached = this.cache.get(from);
    if (cached) this.onFrame(cached, from);
    try {
      for await (const wc of this.playSink.canvases(this.time(from))) {
        if (gen !== this.playGen) break;
        const at = wc.timestamp - this.first;
        while (gen === this.playGen && clock() < at) await nextFrame();
        if (gen !== this.playGen) break;
        if (clock() > at + wc.duration + 0.04) continue; // decoder fell behind, skip to catch up
        this.onFrame(wc.canvas, this.frameOf(wc.timestamp, wc.duration));
      }
    } catch (err) {
      ar.log('video playback failed:', err.message);
    }
  }

  stop() {
    this.playGen++;
  }

  dispose() {
    this.gen++;
    this.playGen++;
    this.cache.clear();
    try {
      this.input.dispose?.();
    } catch {
      // already gone
    }
    ar.rangeClose(this.file);
  }
}
