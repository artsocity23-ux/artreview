// Export: the shot re-encoded with the notes burned in (drawOverlay, the same renderer as the preview), an end card
// with the list of notes, the original sound, and the notes as markdown beside the video.
// A manual mediabunny pipeline (Output + VideoSampleSource + audio source) because Conversion cannot append the card.
import {
  AudioSampleSink, AudioSampleSource, BufferTarget, CanvasSink, EncodedAudioPacketSource, EncodedPacketSink,
  Mp4OutputFormat, Output, QUALITY_HIGH, VideoSample, VideoSampleSource, canEncodeAudio, getFirstEncodableVideoCodec,
} from '../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs';
import { nNotes, notesMarkdown, notesText, startOf, timecode } from './notes.js';
import { FONT_FAMILY, drawOverlay, wrapText } from './overlay.js';
import { openInput } from './video.js';

export { notesText, notesMarkdown };

const ar = window.ar;
const COPY_AUDIO = ['aac', 'opus', 'mp3']; // fit MP4 as they are
const abortError = () => new DOMException('Експорт скасовано', 'AbortError');

const pad2 = v => String(v).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
}

function joinPath(dir, name) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

// Output size: the source, long side capped by maxSize (0 = original), even dimensions for the encoder.
export function exportSize(width, height, maxSize) {
  const cap = +maxSize > 0 ? +maxSize : Infinity;
  const s = Math.min(1, cap / Math.max(width, height));
  const even = v => Math.max(2, Math.round(v * s) - (Math.round(v * s) % 2));
  return { width: even(width), height: even(height) };
}

/**
 * review: the review object; video: the opened VideoRef; settings: the app settings.
 * -> { file, mdFile, text, width, height, frames, seconds, audio: bool, codec }
 */
export async function runExport(review, video, settings, { onProgress, signal } = {}) {
  const check = () => {
    if (signal?.aborted) throw abortError();
  };
  check();
  const outDir = settings.outDir || (await ar.defaultOutDir());
  const base = (review.video?.name || video.name || 'video').replace(/\.[^.]+$/, '');
  const file = joinPath(outDir, `${base}_notes_${stamp()}.mp4`);
  const mdFile = file.replace(/\.mp4$/, '.md');
  const { width: W, height: H } = exportSize(video.width, video.height, settings.maxSize);
  const fps = video.fps;
  const start = startOf(review, settings);

  const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: W, height: H, frameRate: fps });
  if (!codec) throw new Error('У системі немає потрібного відеокодера');

  const input = await openInput(video.file);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  let started = false;
  try {
    const vtrack = await input.getPrimaryVideoTrack();
    const first = await vtrack.getFirstTimestamp();
    const videoEnd = video.end - first; // output seconds where the picture ends and the end card begins
    const videoSource = new VideoSampleSource({ codec, quality: QUALITY_HIGH, keyFrameInterval: 2 });
    // No frameRate here: mediabunny would snap every timestamp to a 1/fps grid, and fps is only an estimate, so a
    // variable-rate phone clip would get frames piled on one timestamp. The default fine timescale keeps the
    // source's own timestamps.
    output.addVideoTrack(videoSource);
    const audio = settings.audio !== false ? await prepareAudio(input, output) : null;
    await output.start();
    started = true;

    const cardSeconds = settings.endCard !== false ? Math.max(3, review.notes.length / 3) : 0;
    const cardFrames = Math.round(cardSeconds * fps);
    const total = video.frameCount + cardFrames;
    let done = 0;
    let failed = null;
    const progress = () => onProgress?.(Math.min(1, done / total));

    // Video and audio are fed side by side so the muxer can interleave them without buffering one whole track.
    const pictures = (async () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
      const ctx = canvas.getContext('2d');
      const sink = new CanvasSink(vtrack, { width: W, height: H, fit: 'fill', poolSize: 2 }); // rotation applied by default
      let end = 0;
      for await (const wc of sink.canvases()) {
        if (failed) return;
        check();
        // The note shown on a video frame is the one at the middle of that frame (frame-rate rounding safe).
        const dur = wc.duration || 1 / fps;
        const f = Math.max(0, Math.min(video.frameCount - 1, Math.floor((wc.timestamp - first + dur / 2) * fps)));
        ctx.drawImage(wc.canvas, 0, 0, W, H);
        drawOverlay(ctx, W, H, review, f, { hud: settings.hud !== false, timecode: timecode(f, fps), frameLabel: String(f + start), preview: false });
        const ts = Math.max(0, wc.timestamp - first);
        const sample = new VideoSample(canvas, { timestamp: ts, duration: dur });
        await videoSource.add(sample);
        sample.close();
        end = Math.max(end, ts + dur);
        done++;
        progress();
      }
      if (cardFrames) {
        drawEndCard(ctx, W, H, review, settings);
        const t0 = Math.max(end, videoEnd);
        for (let i = 0; i < cardFrames; i++) {
          if (failed) return;
          check();
          const sample = new VideoSample(canvas, { timestamp: t0 + i / fps, duration: 1 / fps });
          await videoSource.add(sample);
          sample.close();
          done++;
          progress();
        }
      }
      videoSource.close();
    })();
    const sound = audio ? audio.feed(first, videoEnd, check, () => failed) : Promise.resolve(false);
    let audioOk;
    try {
      [, audioOk] = await Promise.all([
        pictures.catch(err => { failed = err; throw err; }),
        sound.catch(err => {
          if (err?.name === 'AbortError') { failed = err; throw err; }
          ar.log('export audio failed:', err.message);
          return false;
        }),
      ]);
    } catch (err) {
      failed = failed || err;
      throw failed;
    }
    check();
    await output.finalize();
    check(); // finalizing a long export takes seconds; a cancel pressed meanwhile must not write the file
    const bytes = new Uint8Array(output.target.buffer);
    await ar.write(file, bytes);
    check();
    const info = { file, width: W, height: H };
    await ar.write(mdFile, new TextEncoder().encode(notesMarkdown(review, settings, info)));
    onProgress?.(1);
    return {
      file,
      mdFile,
      text: notesText(review, settings),
      width: W,
      height: H,
      frames: total,
      seconds: video.frameCount / fps + cardSeconds,
      audio: !!audioOk,
      codec,
    };
  } catch (err) {
    if (started) await output.cancel().catch(() => {});
    throw err;
  } finally {
    input.dispose?.();
  }
}

// Audio: copy the packets when MP4 can hold the codec, otherwise decode and re-encode to AAC (Opus as a last resort).
// Returns null when the file has no usable sound, so the export simply goes without it.
async function prepareAudio(input, output) {
  const track = await input.getPrimaryAudioTrack().catch(() => null);
  if (!track) return null;
  const codec = await track.getCodec();
  const supported = output.format.getSupportedAudioCodecs();
  if (codec && COPY_AUDIO.includes(codec) && supported.includes(codec)) {
    const config = await track.getDecoderConfig();
    const source = new EncodedAudioPacketSource(codec);
    output.addAudioTrack(source);
    return {
      async feed(first, end, check, failed) {
        const sink = new EncodedPacketSink(track);
        let meta = config ? { decoderConfig: config } : undefined;
        let any = false;
        for await (const packet of sink.packets()) {
          if (failed()) return false;
          check();
          const ts = packet.timestamp - first;
          if (ts >= end) break; // the end card is silent
          if (ts < 0) continue;
          await source.add(packet.clone({ timestamp: ts }), meta);
          meta = undefined;
          any = true;
        }
        source.close();
        return any;
      },
    };
  }
  if (!(await track.canDecode().catch(() => false))) return null;
  const numberOfChannels = await track.getNumberOfChannels();
  const sampleRate = await track.getSampleRate();
  let target = null;
  for (const c of ['aac', 'opus']) {
    if (supported.includes(c) && (await canEncodeAudio(c, { numberOfChannels, sampleRate, quality: QUALITY_HIGH }).catch(() => false))) {
      target = c;
      break;
    }
  }
  if (!target) return null;
  const source = new AudioSampleSource({ codec: target, quality: QUALITY_HIGH });
  output.addAudioTrack(source);
  return {
    async feed(first, end, check, failed) {
      const sink = new AudioSampleSink(track);
      let any = false;
      for await (const sample of sink.samples(first, first + end)) {
        if (failed()) {
          sample.close();
          return false;
        }
        check();
        const ts = sample.timestamp - first;
        if (ts < 0) {
          sample.close();
          continue;
        }
        sample.setTimestamp(ts);
        await source.add(sample);
        sample.close();
        any = true;
      }
      source.close();
      return any;
    },
  };
}

// ---------- end card ----------

function cardLayout(ctx, W, H, review, settings, size, cols, truncate = false) {
  const fps = review.video?.fps || 25;
  const s = startOf(review, settings);
  const margin = Math.round(Math.min(W, H) * 0.07);
  const title = Math.round(size * 1.45);
  const gapX = Math.round(size * 1.6);
  const colW = (W - 2 * margin - gapX * (cols - 1)) / cols;
  const line = Math.round(size * 1.32);
  const dot = size * 0.62;
  const textX = dot * 2 + size * 0.6;
  const top = margin + title * 1.9;
  const bottom = H - margin;
  const rows = [];
  let col = 0;
  let y = top;
  let fits = true;
  let more = 0;
  review.notes.forEach((n, i) => {
    ctx.font = `600 ${size}px ${FONT_FAMILY}`;
    const head = `${i + 1}.  ${timecode(n.in, fps)}  ·  ${n.out > n.in ? `кадр ${n.in + s}–${n.out + s}` : `кадр ${n.in + s}`}`;
    ctx.font = `${size}px ${FONT_FAMILY}`;
    let lines = wrapText(ctx, (n.text || '').trim() || '(без тексту)', colW - textX);
    const h = line * (1 + lines.length) + size * 0.7;
    // The last column keeps a line free for "and N more" when the list is cut.
    const limit = () => (truncate && col === cols - 1 ? bottom - line : bottom);
    if (y + h > limit() && y > top) {
      col++;
      y = top;
    }
    if (col >= cols || y + h > limit()) {
      fits = false;
      if (!truncate) return;
      if (col >= cols) {
        more++;
        return;
      }
      lines = lines.slice(0, Math.max(0, Math.floor((limit() - y) / line) - 1)); // a row taller than a column
    }
    rows.push({ n, head, lines, x: margin + col * (colW + gapX), y, h });
    y += h;
  });
  return { rows, fits, more, margin, title, line, dot, textX, size, moreX: margin + (cols - 1) * (colW + gapX), moreY: bottom - line };
}

// Dark summary card: title, then the numbered list (colour dot, number, timecode / frames, text).
// Too many notes: a smaller font, then two columns; past that the list is cut (the message text has all of it).
function drawEndCard(ctx, W, H, review, settings) {
  const base = Math.max(14, Math.round(Math.min(W, H) * 0.042));
  const min = Math.max(10, Math.round(Math.min(W, H) * 0.022));
  let L = null;
  outer: for (const cols of [1, 2]) {
    for (let size = base; size >= min; size = Math.floor(size * 0.9)) {
      L = cardLayout(ctx, W, H, review, settings, size, cols);
      if (L.fits) break outer;
      if (size === min) break;
      if (Math.floor(size * 0.9) < min) size = Math.ceil(min / 0.9);
    }
  }
  if (!L.fits) L = cardLayout(ctx, W, H, review, settings, min, 2, true);
  ctx.save();
  ctx.fillStyle = '#15171c';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${L.title}px ${FONT_FAMILY}`;
  ctx.fillText(`${review.video?.name || 'відео'} — нотатки`, L.margin, L.margin);
  ctx.fillStyle = '#ff5a4e';
  ctx.fillRect(L.margin, L.margin + L.title * 1.3, Math.round(L.title * 2), Math.max(2, Math.round(L.title * 0.09)));
  if (!review.notes.length) {
    ctx.fillStyle = '#8b91a0';
    ctx.font = `${L.size}px ${FONT_FAMILY}`;
    ctx.fillText('Нотаток немає', L.margin, L.margin + L.title * 1.9);
  }
  for (const r of L.rows) {
    ctx.beginPath();
    ctx.arc(r.x + L.dot, r.y + L.line * 0.45, L.dot, 0, Math.PI * 2);
    ctx.fillStyle = r.n.color;
    ctx.fill();
    ctx.font = `600 ${L.size}px ${FONT_FAMILY}`;
    ctx.fillStyle = '#e7e9ee';
    ctx.fillText(r.head, r.x + L.textX, r.y);
    ctx.font = `${L.size}px ${FONT_FAMILY}`;
    ctx.fillStyle = '#c9cdd6';
    r.lines.forEach((l, k) => {
      const y = r.y + L.line * (k + 1);
      ctx.fillText(l, r.x + L.textX, y);
    });
  }
  if (L.more) {
    ctx.font = `italic ${L.size}px ${FONT_FAMILY}`;
    ctx.fillStyle = '#8b91a0';
    ctx.fillText(`…і ще ${nNotes(L.more)} (усі — у тексті)`, L.moreX + L.textX, L.moreY);
  }
  ctx.restore();
}
