// Export: PNG sequence, GIF, MP4 and WebM, either the animation alone or composited over the reference.
// Every picture is composited on the GPU (src.render) and comes back as RGBA rows that go straight to the GIF
// quantiser or the video encoder. Over a video the video drives the timing: MP4/WebM keep its own frame rate and its
// sound (copied when the container allows it, re-encoded otherwise), PNG and GIF take one picture per animation tick.
import { GIFEncoder, applyPalette, quantize } from '../node_modules/gifenc/dist/gifenc.esm.js';
import {
  BufferTarget, CanvasSink, Conversion, Mp4OutputFormat, Output, QUALITY_HIGH, VideoSample, VideoSampleSource,
  WebMOutputFormat, getFirstEncodableVideoCodec,
} from '../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs';
import { openInput } from './video.js';

const af = window.af;
const tick = () => new Promise(r => setTimeout(r, 0));

async function videoCodec(kind, width, height) {
  const list = kind === 'mp4' ? ['avc', 'hevc', 'vp9', 'av1'] : ['vp9', 'vp8', 'av1'];
  const codec = await getFirstEncodableVideoCodec(list, { width, height });
  if (!codec) throw new Error('У системі немає потрібного відеокодера');
  return codec;
}

const outputFormat = kind => (kind === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat());

const rgbaSample = (px, W, H, timestamp, duration) =>
  new VideoSample(px, { format: 'RGBX', codedWidth: W, codedHeight: H, timestamp, duration });

class Cancelled extends Error {}

// src: { width, height, fps, frames, ticks (start tick per frame + total), frameAtTick(t), video, image,
//        render(W, H, { frame, under, image, paper }) -> RGBA, unpremultiply(px) }
// job: { kind: 'png' | 'gif' | 'mp4' | 'webm', target, name, scale, withRef, withSketch, transparent, audio }
export async function runExport(src, job, progress, cancel) {
  const even = job.kind === 'mp4' || job.kind === 'webm';
  const fit = n => {
    const v = Math.max(2, Math.round(n * job.scale));
    return even ? v - (v % 2) : v;
  };
  const W = fit(src.width);
  const H = fit(src.height);
  const video = job.withRef && src.video ? src.video : null;
  const image = job.withRef && !video && src.image;
  const paper = !(job.transparent && job.kind === 'png');
  const check = () => {
    if (cancel.requested) throw new Cancelled();
  };
  const sketch = !!job.withSketch;
  const picture = (frame, under) => src.render(W, H, { frame, under, image, paper, sketch });

  // Ticks to render: the animation, or the whole video at the animation's frame rate.
  const total = video ? video.ticks() : src.ticks[src.frames.length];
  const frameAt = t => (t < src.ticks[src.frames.length] ? src.frames[src.frameAtTick(t)] : null);

  async function* pictures() {
    if (!video) {
      for (let t = 0; t < total; t++) yield { t, frame: frameAt(t), under: null };
      return;
    }
    const r = video.rect;
    const sink = new CanvasSink(video.track, {
      width: Math.max(2, Math.round((r.w * W) / src.width)),
      height: Math.max(2, Math.round((r.h * H) / src.height)),
      fit: 'fill',
    });
    const times = Array.from({ length: total }, (_, t) => video.time(t));
    let t = 0;
    for await (const wc of sink.canvasesAtTimestamps(times)) {
      yield { t, frame: frameAt(t), under: wc?.canvas || null };
      t++;
    }
  }

  try {
    if (job.kind === 'png') {
      const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
      const ctx = canvas.getContext('2d');
      let last = null;
      let bytes = null;
      for await (const { t, frame, under } of pictures()) {
        check();
        if (under || frame !== last || !bytes) {
          const px = picture(frame, under);
          if (!paper) src.unpremultiply(px);
          ctx.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), W, H), 0, 0);
          bytes = new Uint8Array(await (await new Promise(r => canvas.toBlob(r, 'image/png'))).arrayBuffer());
          last = frame;
        }
        await af.writeIn(job.target, `${job.name}_${String(t + 1).padStart(4, '0')}.png`, bytes);
        progress((t + 1) / total);
      }
      return { file: job.target, count: total };
    }

    if (job.kind === 'gif') {
      const gif = GIFEncoder();
      const ms = t => Math.round((t * 1000) / src.fps / 10) * 10; // GIF delays are centiseconds; round the timeline, not each delay
      let count = 0;
      const add = (px, from, to) => {
        const palette = quantize(px, 256);
        gif.writeFrame(applyPalette(px, palette), W, H, { palette, delay: Math.max(20, ms(to) - ms(from)) });
        count++;
      };
      if (video) {
        for await (const { t, frame, under } of pictures()) {
          check();
          add(picture(frame, under), t, t + 1);
          progress((t + 1) / total);
          await tick();
        }
      } else {
        // One GIF frame per drawing, held as long as it is exposed.
        for (let i = 0; i < src.frames.length; i++) {
          check();
          add(picture(src.frames[i], null), src.ticks[i], src.ticks[i + 1]);
          progress((i + 1) / src.frames.length);
          await tick();
        }
      }
      gif.finish();
      await af.write(job.target, gif.bytes());
      return { file: job.target, count };
    }

    // MP4 / WebM
    const codec = await videoCodec(job.kind, W, H);
    if (video) return await overVideo(src, job, { W, H, codec, video, frameAt, progress, cancel });

    const output = new Output({ format: outputFormat(job.kind), target: new BufferTarget() });
    const source = new VideoSampleSource({ codec, quality: QUALITY_HIGH, keyFrameInterval: 2 });
    output.addVideoTrack(source, { frameRate: src.fps });
    await output.start();
    for (let t = 0; t < total; t++) {
      if (cancel.requested) {
        await output.cancel();
        throw new Cancelled();
      }
      const sample = rgbaSample(picture(frameAt(t), null), W, H, t / src.fps, 1 / src.fps);
      await source.add(sample);
      sample.close();
      progress((t + 1) / total);
    }
    await output.finalize();
    await af.write(job.target, new Uint8Array(output.target.buffer));
    return { file: job.target, count: total, codec };
  } catch (err) {
    if (err instanceof Cancelled) return { cancelled: true };
    throw err;
  }
}

// Re-encodes the reference video with the drawings painted over every frame; its audio track rides along.
async function overVideo(src, job, { W, H, codec, video, frameAt, progress, cancel }) {
  const input = await openInput(video.file);
  const output = new Output({ format: outputFormat(job.kind), target: new BufferTarget() });
  const r = video.rect;
  // The decoded frame is drawn with its rotation applied, at the size it takes in the export.
  const sub = Object.assign(document.createElement('canvas'), {
    width: Math.max(2, Math.round((r.w * W) / src.width)),
    height: Math.max(2, Math.round((r.h * H) / src.height)),
  });
  const subCtx = sub.getContext('2d');
  const start = video.first + video.offset / video.fps;
  let t0 = null;
  const conversion = await Conversion.init({
    input,
    output,
    tracks: 'primary',
    trim: { start },
    showWarnings: false,
    video: {
      codec,
      quality: QUALITY_HIGH,
      allowTransformationMetadata: false,
      processedWidth: W,
      processedHeight: H,
      process: sample => {
        // The drawing shown on a video frame is the one exposed at the middle of that frame. Sampling the middle
        // keeps 29.97 vs 30000/1001 style rounding from sliding a drawing onto the neighbouring frame.
        if (t0 === null) t0 = sample.timestamp;
        const t = Math.floor((sample.timestamp - t0 + (sample.duration || 1 / video.fps) / 2) * src.fps);
        sample.drawWithFit(subCtx, { fit: 'fill' });
        const px = src.render(W, H, { frame: frameAt(t), under: sub, sketch: !!job.withSketch });
        return rgbaSample(px, W, H, sample.timestamp, sample.duration);
      },
    },
    audio: job.audio ? {} : { discard: true },
  });
  if (!conversion.isValid) throw new Error('Не вдалося підготувати конвертацію відео');
  const audioLost = job.audio && video.hasAudio && conversion.discardedTracks.some(d => d.track.type === 'audio');
  conversion.onProgress = p => progress(p);
  cancel.abort = () => conversion.cancel();
  try {
    await conversion.execute();
  } catch (err) {
    if (cancel.requested) return { cancelled: true };
    throw err;
  } finally {
    input.dispose?.();
  }
  await af.write(job.target, new Uint8Array(output.target.buffer));
  return { file: job.target, codec, audio: job.audio && video.hasAudio && !audioLost, audioLost };
}
