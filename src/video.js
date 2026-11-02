// Video reference: exact frames decoded with WebCodecs through mediabunny. The file is read in byte ranges through
// the main process, so a long video never has to be loaded whole. Paused stepping asks for single frames (cached and
// prefetched), playback decodes sequentially and paces the frames against the caller's clock.
import { ALL_FORMATS, CanvasSink, CustomSource, Input } from '../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs';

const af = window.af;
// NTSC rates are kept exact (30000/1001, not 29.97) so frame times stay on the file's own grid for hours of video.
const STANDARD_FPS = [12, 15, 24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 120];
const CACHE_BYTES = 768 * 1024 * 1024;

const nextFrame = () => new Promise(r => requestAnimationFrame(r));

export async function openInput(file) {
  const stat = await af.stat(file);
  if (!stat) throw new Error('Файл не знайдено');
  const source = new CustomSource({
    getSize: () => stat.size,
    read: (start, end) => af.range(file, start, end),
    prefetchProfile: 'fileSystem',
    maxCacheSize: 64 * 1024 * 1024,
  });
  return new Input({ formats: ALL_FORMATS, source });
}

export async function openVideo(file) {
  const input = await openInput(file);
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('У файлі немає відео');
  if (!(await track.canDecode())) throw new Error('Цей кодек відео не підтримується. Перекодуй у H.264 (MP4).');
  const first = await track.getFirstTimestamp();
  const end = await track.computeDuration();
  // A short clip is counted whole (frames / length); a long one is sampled from its first packets.
  const stats = await track.computePacketStats(240);
  const raw = stats.packetCount < 240 && end > first ? stats.packetCount / (end - first) : stats.averagePacketRate || 30;
  const nearest = STANDARD_FPS.reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));
  const fps = Math.abs(nearest - raw) / raw < 0.005 ? nearest : Math.round(raw * 1000) / 1000;
  const audio = await input.getPrimaryAudioTrack();
  const hasAudio = !!audio && (await audio.canDecode().catch(() => false));
  return new VideoRef({ file, input, track, first, end, fps, hasAudio, width: track.displayWidth, height: track.displayHeight });
}

export class VideoRef {
  constructor(o) {
    Object.assign(this, o);
    this.kind = 'video';
    this.duration = Math.max(0, o.end - o.first);
    this.frameCount = Math.max(1, Math.round(this.duration * o.fps));
    this.cache = new Map(); // tick -> canvas, in insertion order for LRU
    this.want = null;
    this.shownTick = null;
    this.busy = false;
    this.gen = 0; // bumps when the layout changes and cached frames go stale
    this.playGen = 0; // bumps to stop a running playback
    this.onFrame = () => {};
  }

  // Sets the area the video occupies on the sheet: contain-fit into the project frame.
  layout(docW, docH, fps, offset) {
    const s = Math.min(docW / this.width, docH / this.height);
    const w = Math.max(2, Math.round(this.width * s));
    const h = Math.max(2, Math.round(this.height * s));
    this.rect = { x: Math.round((docW - w) / 2), y: Math.round((docH - h) / 2), w, h };
    this.docFps = fps;
    this.offset = offset || 0; // in video frames
    this.sink = new CanvasSink(this.track, { width: w, height: h, fit: 'fill' });
    this.playSink = new CanvasSink(this.track, { width: w, height: h, fit: 'fill', poolSize: 4 });
    this.maxCache = Math.max(16, Math.floor(CACHE_BYTES / (w * h * 4)));
    this.cache.clear();
    this.shownTick = null;
    this.gen++;
  }

  // Timestamp in the file for an animation tick. The small nudge keeps float error from landing on the previous frame.
  time(tick) {
    return this.first + this.offset / this.fps + tick / this.docFps + Math.min(0.25 / this.fps, 0.25 / this.docFps);
  }

  // Video-local seconds for an animation tick (used for the audio element).
  localTime(tick) {
    return this.offset / this.fps + tick / this.docFps;
  }

  ticks() {
    return Math.max(1, Math.ceil((this.duration - this.offset / this.fps) * this.docFps - 1e-6));
  }

  put(tick, canvas) {
    this.cache.delete(tick);
    this.cache.set(tick, canvas);
    while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value);
  }

  show(tick) {
    this.want = tick;
    if (!this.busy) this.pump();
  }

  async pump() {
    this.busy = true;
    try {
      while (this.want !== null && this.want !== this.shownTick) {
        const tick = this.want;
        const gen = this.gen;
        let canvas = this.cache.get(tick);
        if (canvas === undefined) {
          canvas = (await this.sink.getCanvas(this.time(tick)))?.canvas || null;
          if (gen !== this.gen) continue;
          this.put(tick, canvas);
        }
        this.shownTick = tick;
        this.onFrame(canvas);
      }
    } catch (err) {
      af.log('video frame failed:', err.message);
    } finally {
      this.busy = false;
    }
  }

  // Decodes the given ticks in the background so stepping onto them is instant.
  async prefetch(ticks) {
    const missing = [...new Set(ticks)].filter(t => t >= 0 && !this.cache.has(t)).sort((a, b) => a - b);
    if (!missing.length || this.prefetching) return;
    this.prefetching = true;
    const gen = this.gen;
    try {
      let i = 0;
      for await (const wc of this.sink.canvasesAtTimestamps(missing.map(t => this.time(t)))) {
        if (gen !== this.gen || this.busy) break;
        this.put(missing[i++], wc?.canvas || null);
      }
    } catch (err) {
      af.log('video prefetch failed:', err.message);
    } finally {
      this.prefetching = false;
    }
  }

  // clock() returns the playback position in seconds since tick 0. Frames are shown once the clock reaches them.
  async play(fromTick, clock) {
    const gen = ++this.playGen;
    this.shownTick = null;
    // The decoder needs a moment to seek; a cached first frame goes up at once instead of the last one lingering
    // (most visible when a short clip loops back to its start).
    const cached = this.cache.get(fromTick);
    if (cached) this.onFrame(cached);
    const base = this.first + this.offset / this.fps;
    try {
      for await (const wc of this.playSink.canvases(this.time(fromTick))) {
        if (gen !== this.playGen) break;
        const at = wc.timestamp - base;
        while (gen === this.playGen && clock() < at) await nextFrame();
        if (gen !== this.playGen) break;
        if (clock() > at + wc.duration + 0.04) continue; // decoder fell behind, skip to catch up
        this.onFrame(wc.canvas);
      }
    } catch (err) {
      af.log('video playback failed:', err.message);
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
    af.rangeClose(this.file);
  }
}
