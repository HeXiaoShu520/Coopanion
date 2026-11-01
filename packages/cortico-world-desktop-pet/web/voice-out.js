/**
 * Reading Coo's replies aloud, in the order they were said. The World sends `{ t: 'speak', id, pieces }`
 * for each bubble of a turn that was spoken to; a reply joins a queue and the one playing finishes
 * first, so a turn of several bubbles is heard whole, bubble after bubble, instead of each new one
 * cutting off the last. Each piece is pulled from `GET /api/tts/audio?id=…&i=…` as raw 24 kHz mono
 * PCM and played the moment it arrives, with the next piece already on its way. Nothing is buffered
 * whole: Coo starts talking after the first frame. A reply the page lets go before playing it out — the
 * sound stopped, its bubble taken away — is reported as finished, so the World stops waiting for it.
 *
 * What is heard is also what the body shows: every tenth of a second of sound reports its level
 * (`onVoice`) and, while that slice carries a voice, opens the mouth (`onTalk`), so the light and the
 * mouth follow the words read instead of a clock of their own.
 *
 * Speed and volume are the page's: a piece plays at `speed` (the World's setting), and the gain moves
 * while it plays, so dragging the volume slider is heard immediately. A piece that fails, before it
 * starts or halfway through, leaves the rest of its reply unplayed; the bubble still shows the words,
 * and the replies behind it still play. A page that cannot make sound reports each reply as failed
 * instead of holding it.
 */

/** The rate the World's synthesis returns; playback resamples nothing. */
const RATE = 24000;

/** Seconds of sound one level reading covers. */
const LEVEL_S = .1;

/** dBFS under which a slice is silence: no mouth moves and the light goes dim. */
const MOUTH_DB = -40;

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
 * `onDone(id)` runs when the page is done with a reply: its last piece played, or it was let go before
 * that — the sound stopped, its bubble taken away. The World then stops waiting for it.
 * `onFail(id)` runs when a reply could not be played at all: a piece that could not be made, or a page
 * with no sound. `onPiece(id)` runs as each later piece arrives, so the page can start its breath over
 * with the sentence being read.
 * `onVoice(db)` carries the level of the sound as it is heard, `onTalk()` an open mouth for a slice
 * that has a voice in it.
 */
export function createVoiceOut({ onDone, onFail, onPiece, onVoice, onTalk } = {}) {
  let ctx = null;
  let gain = null;
  /** When the next chunk is to start, on the audio clock; 0 when nothing is scheduled. */
  let playAt = 0;
  /** The reply playing now, and what stops it. */
  let playing = null;
  /** The replies waiting their turn, oldest first. */
  const waiting = [];
  let speed = 1;
  let volume = 1;
  const sources = new Set();
  /** Level readings booked on the clock for sound not heard yet. */
  const readings = new Set();

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

  function later(fn, ms) {
    const timer = setTimeout(() => { readings.delete(timer); fn(); }, Math.max(0, ms));
    readings.add(timer);
  }

  function clearReadings() {
    for (const timer of readings) clearTimeout(timer);
    readings.clear();
  }

  /**
   * The level of each LEVEL_S slice of `bytes`, reported as the clock reaches it from `from`: the
   * sound already on its way, so the light moves with the voice rather than with the network.
   */
  function follow(bytes, from) {
    if (!onVoice && !onTalk) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = bytes.length >> 1;
    const slice = Math.max(1, Math.round(RATE * LEVEL_S * speed));
    for (let start = 0; start < count; start += slice) {
      const end = Math.min(count, start + slice);
      let sum = 0;
      for (let i = start; i < end; i++) { const v = view.getInt16(i * 2, true) / 32768; sum += v * v; }
      const rms = Math.sqrt(sum / (end - start));
      const db = rms > 0 ? 20 * Math.log10(rms) : -100;
      const ms = (from + start / RATE / speed - ctx.currentTime) * 1000;
      // a slice already behind the clock has been heard while the page was busy; reporting it now would lag
      if (ms < -LEVEL_S * 1000) continue;
      later(() => {
        onVoice?.(db);
        if (db > MOUTH_DB) onTalk?.();
      }, ms);
    }
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
    follow(bytes, at);
    sources.add(source);
    source.onended = () => {
      sources.delete(source);
      // the reply's last chunk has played and no piece is still arriving: nothing is left to hear
      if (!sources.size && playing && !playing.pulling && playAt && out.currentTime >= playAt - 0.05) settle();
    };
  }

  /** The reply ended of its own accord: the next one waiting starts, and the World hears of this one. */
  function settle() {
    const done = playing;
    playing = null;
    playAt = 0;
    clearReadings();
    if (done) onDone?.(done.id);
    pump();
  }

  /** A piece of `id` could not be made: the reply stops here, the ones behind it still play. */
  function fail(id, controller) {
    if (playing?.id !== id) return;
    playing = null;
    playAt = 0;
    silence();
    if (!controller.signal.aborted) onFail?.(id);
    pump();
  }

  function silence() {
    for (const source of sources) { try { source.stop(); } catch { /* not started yet */ } }
    sources.clear();
    clearReadings();
    playing = null;
    playAt = 0;
  }

  /** Starts the reply at the head of the queue, unless one is playing. */
  function pump() {
    while (!playing && waiting.length) {
      const next = waiting.shift();
      if (!audio()) { onFail?.(next.id); continue; }
      const controller = new AbortController();
      playing = { id: next.id, controller, pulling: true };
      void run(next.id, next.pieces, controller);
    }
  }

  /** Reads the pieces of `id` in order, the next one already asked for while the one before sounds. */
  async function run(id, pieces, controller) {
    // a reply starts its own breath of light, and each later sentence starts it over
    onPiece?.(id);
    // the answer to this request is what the next piece needs; a failure ends the reply, not the page
    let next = fetch(`/api/tts/audio?id=${encodeURIComponent(id)}&i=0`, { signal: controller.signal });
    for (let i = 0; i < pieces; i++) {
      if (i) onPiece?.(id);
      let response;
      try {
        response = await next;
      } catch {
        fail(id, controller);
        return;
      }
      next = i + 1 < pieces ? fetch(`/api/tts/audio?id=${encodeURIComponent(id)}&i=${i + 1}`, { signal: controller.signal }) : null;
      if (!response.ok || !response.body) {
        fail(id, controller);
        next?.catch(() => {});
        return;
      }
      const reader = response.body.getReader();
      // a chunk may end between the two bytes of a sample: the odd byte waits for the next chunk
      let carry = new Uint8Array(0);
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch {
          // the piece was cut mid-flight: by the person stopping it, or by synthesis failing in the World
          fail(id, controller);
          next?.catch(() => {});
          return;
        }
        if (controller.signal.aborted) {
          void next?.catch(() => {});
          void reader.cancel().catch(() => {});
          return;
        }
        if (chunk.done) break;
        const bytes = carry.length ? Uint8Array.from([...carry, ...chunk.value]) : chunk.value;
        const even = bytes.length - (bytes.length % 2);
        if (even) play(bytes.subarray(0, even));
        carry = bytes.subarray(even);
      }
    }
    if (playing?.id !== id) return;
    playing.pulling = false;
    // nothing was played (a reply of silence): there is no end of the audio to wait for
    if (!sources.size) settle();
  }

  return {
    /**
     * The World reads bubble `id`, which has `pieces` pieces. It plays now or after the replies
     * already waiting; nothing playing is cut off, and the same bubble is read once.
     */
    speak(id, pieces) {
      const count = Number(pieces);
      if (!id || !(count > 0)) return;
      // a page with no sound at all says so, as it does for a reply that waited its turn: the World
      // would otherwise wait for an end that never comes
      if (!audio()) { onFail?.(id); return; }
      if (playing?.id === id || waiting.some((w) => w.id === id)) return;
      waiting.push({ id, pieces: count });
      pump();
    },
    /**
     * Cuts the sound now and drops what waited behind it. Every reply it lets go is reported finished:
     * nothing of them is left in the page's hands to report later.
     */
    stop() {
      const was = playing;
      const dropped = (was ? [was.id] : []).concat(waiting.map((w) => w.id));
      waiting.length = 0;
      silence();
      was?.controller.abort();
      for (const id of dropped) onDone?.(id);
    },
    /** Bubble `id` went away: its sound and its place in the queue go with it, the rest still plays. */
    drop(id) {
      const at = waiting.findIndex((w) => w.id === id);
      if (at >= 0) {
        waiting.splice(at, 1);
        onDone?.(id);
        return;
      }
      if (playing?.id !== id) return;
      const was = playing;
      silence();
      was.controller.abort();
      onDone?.(id);
      pump();
    },
    /** Whether `id` is being read now or waiting its turn. */
    holds(id) {
      return playing?.id === id || waiting.some((w) => w.id === id);
    },
    /** `speed`: times the voice's own pace; `volume`: 0–1. */
    configure({ speed: rate, volume: gainValue } = {}) {
      if (typeof rate === 'number' && rate > 0) speed = rate;
      if (typeof gainValue === 'number') {
        volume = Math.min(1, Math.max(0, gainValue));
        if (gain) gain.gain.value = volume;
      }
    },
    /** Whether a reply is being read now, or waits to be. */
    get active() {
      return playing !== null || waiting.length > 0;
    },
    /** The bubble being read, if any. */
    get reading() {
      return playing?.id ?? null;
    },
  };
}
