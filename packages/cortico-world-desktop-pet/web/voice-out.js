/**
 * Reading Coo's replies aloud. The World sends `{ t: 'speak', id, pieces }` for a bubble whose words
 * came from a turn that was spoken to; each piece is pulled from `GET /api/tts/audio?id=…&i=…` as raw
 * 24 kHz mono PCM and played the moment it arrives, with the next piece already on its way. Nothing is
 * buffered whole: Coo starts talking after the first frame, and `stop()` cuts the sound at once — the
 * person spoke again, typed, or took the bubble away.
 *
 * Speed and volume are the page's: a piece plays at `speed` (the World's setting), and the gain moves
 * while it plays, so dragging the volume slider is heard immediately. A piece that fails leaves the
 * rest unplayed; the bubble still shows the words.
 */

/** The rate the World's synthesis returns; playback resamples nothing. */
const RATE = 24000;

/** A chunk of Int16 PCM as the buffer one source node plays. */
function samplesOf(ctx, bytes) {
  const count = bytes.length >> 1;
  const buffer = ctx.createBuffer(1, count, RATE);
  const data = buffer.getChannelData(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) data[i] = view.getInt16(i * 2, true) / 32768;
  return buffer;
}

/**
 * `onDone(id)` runs when the last piece of a bubble has finished playing — the World marks the turn
 * as no longer reading. `onFail(id)` runs when a piece could not be made at all.
 */
export function createVoiceOut({ onDone, onFail } = {}) {
  let ctx = null;
  let gain = null;
  /** When the next chunk is to start, on the audio clock; 0 when nothing is scheduled. */
  let playAt = 0;
  /** The reply playing now, and what stops it. */
  let playing = null;
  let speed = 1;
  let volume = 1;
  const sources = new Set();

  function audio() {
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      try { ctx = new Ctx(); } catch { return null; }
      gain = ctx.createGain();
      gain.gain.value = volume;
      gain.connect(ctx.destination);
    }
    // a page opened in a tab may start suspended until the person touches it
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }

  /** One chunk at its place on the clock, right after the chunk before it. */
  function play(bytes) {
    const out = ctx;
    if (!out || bytes.length < 2) return;
    const source = out.createBufferSource();
    source.buffer = samplesOf(out, bytes);
    source.playbackRate.value = speed;
    source.connect(gain);
    // a small lead keeps the first chunk from being dropped for arriving a moment late
    const at = Math.max(out.currentTime + 0.04, playAt);
    source.start(at);
    playAt = at + (bytes.length >> 1) / RATE / speed;
    sources.add(source);
    source.onended = () => {
      sources.delete(source);
      // the reply's last chunk has played and no piece is still arriving: nothing is left to hear
      if (!sources.size && playing && !playing.pulling && playAt && out.currentTime >= playAt - 0.05) settle();
    };
  }

  /** The reply ended of its own accord: the World is told so it stops waiting on this bubble. */
  function settle() {
    const done = playing;
    playing = null;
    playAt = 0;
    if (done) onDone?.(done.id);
  }

  function silence() {
    for (const source of sources) { try { source.stop(); } catch { /* not started yet */ } }
    sources.clear();
    playing = null;
    playAt = 0;
  }

  /** Reads the pieces of `id` in order, the next one already asked for while the one before sounds. */
  async function run(id, pieces, controller) {
    // the answer to this request is what the next piece needs; a failure ends the reply, not the page
    let next = fetch(`/api/tts/audio?id=${encodeURIComponent(id)}&i=0`, { signal: controller.signal });
    for (let i = 0; i < pieces; i++) {
      let response;
      try {
        response = await next;
      } catch {
        if (!controller.signal.aborted) { playing = null; onFail?.(id); }
        return;
      }
      next = i + 1 < pieces ? fetch(`/api/tts/audio?id=${encodeURIComponent(id)}&i=${i + 1}`, { signal: controller.signal }) : null;
      if (!response.ok || !response.body) {
        playing = null;
        if (!controller.signal.aborted) onFail?.(id);
        next?.catch(() => {});
        return;
      }
      const reader = response.body.getReader();
      // a chunk may end between the two bytes of a sample: the odd byte waits for the next chunk
      let carry = new Uint8Array(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) {
          void next?.catch(() => {});
          void reader.cancel().catch(() => {});
          return;
        }
        if (done) break;
        const bytes = carry.length ? Uint8Array.from([...carry, ...value]) : value;
        const even = bytes.length - (bytes.length % 2);
        if (even) play(bytes.subarray(0, even));
        carry = bytes.subarray(even);
      }
    }
    if (!playing) return;
    playing.pulling = false;
    // nothing was played (a reply of silence): there is no end of the audio to wait for
    if (!sources.size) settle();
  }

  return {
    /** The World reads bubble `id`, which has `pieces` pieces. A newer reply replaces the one playing. */
    speak(id, pieces) {
      this.stop(false);
      const out = audio();
      const count = Number(pieces);
      if (!out || !id || !(count > 0)) return;
      const controller = new AbortController();
      playing = { id, controller, pulling: true };
      void run(id, count, controller);
    },
    /**
     * Cuts the sound now. `tell` (the default) says so to the World, which then forgets the reply;
     * the page's own end of a reply passes false, having nothing to take back.
     */
    stop(tell = false) {
      const was = playing;
      silence();
      if (tell && was) {
        was.controller.abort();
        fetch('/api/tts/cancel', { method: 'POST' }).catch(() => {});
      } else {
        was?.controller.abort();
      }
    },
    /** `speed`: times the voice's own pace; `volume`: 0–1. */
    configure({ speed: rate, volume: gainValue } = {}) {
      if (typeof rate === 'number' && rate > 0) speed = rate;
      if (typeof gainValue === 'number') {
        volume = Math.min(1, Math.max(0, gainValue));
        if (gain) gain.gain.value = volume;
      }
    },
    /** Whether a reply is being read right now. */
    get active() {
      return playing !== null;
    },
    /** The bubble being read, if any. */
    get reading() {
      return playing?.id ?? null;
    },
  };
}
