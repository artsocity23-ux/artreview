// Tracking worker: one BoxTracker per running track, so the UI thread never waits on the flow maths.
// Messages in:  { type: 'start', id, gray, width, height, box } | { type: 'frame', id, gray } | { type: 'stop', id }
// Messages out: { type: 'result', id, box, quality, lost } for every 'frame' (box in pixels of the gray frame).
import { BoxTracker } from './tracker.js';

const trackers = new Map();

// gray may arrive as a transferred ArrayBuffer or as a typed array over one.
const asGray = g => (g instanceof Uint8Array ? g : ArrayBuffer.isView(g) ? new Uint8Array(g.buffer, g.byteOffset, g.byteLength) : new Uint8Array(g));

self.onmessage = e => {
  const m = e.data || {};
  if (m.type === 'start') {
    try {
      trackers.set(m.id, new BoxTracker(asGray(m.gray), m.width, m.height, m.box));
    } catch (err) {
      // A bad start answers every following frame as lost (with the reason), so the driver never hangs.
      trackers.set(m.id, { error: String((err && err.message) || err) });
    }
  } else if (m.type === 'frame') {
    const t = trackers.get(m.id);
    let r;
    if (!t || t.error) r = { box: null, quality: 0, lost: true, error: t ? t.error : 'немає трекера' };
    else {
      try {
        r = t.update(asGray(m.gray));
      } catch (err) {
        r = { box: null, quality: 0, lost: true, error: String((err && err.message) || err) };
      }
    }
    self.postMessage({ type: 'result', id: m.id, ...r });
  } else if (m.type === 'stop') {
    trackers.delete(m.id);
  }
};
