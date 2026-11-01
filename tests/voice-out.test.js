/**
 * The page's reader of replies: a turn's bubbles are heard whole and in the order they were said,
 * a newer reply waits instead of cutting the one playing off, and a bubble taken away leaves the
 * replies behind it playing. The audio clock and the network are the test's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVoiceOut } from '../packages/cortico-world-desktop-pet/web/voice-out.js';

/** The audio clock the reader schedules on, with what it started in the order it started it. */
class FakeContext {
  currentTime = 0;
  state = 'running';
  destination = {};
  started = [];
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  createBuffer(channels, count) { return { getChannelData: () => new Float32Array(count) }; }
  createBufferSource() {
    const source = {
      buffer: null, playbackRate: { value: 1 }, onended: null, at: 0,
      connect() {}, start(at) { source.at = at; ctx.started.push(source); }, stop() {},
    };
    return source;
  }
  resume() {}
}

/** One turn of the event loop past the fetch and the stream read it walks through. */
const tick = () => new Promise((resolve) => { setTimeout(resolve, 5); });
const RATE = 24000;
/** A tenth of a second of silence, as the World's PCM. */
const silence = () => new Uint8Array(RATE * .1 * 2);
const pcm = (bytes) => new Response(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), { status: 200 });
/** A piece that breaks halfway: one chunk is heard, and the pull after it errors as an interrupted stream does. */
const cut = (bytes) => {
  let left = 1;
  return new Response(new ReadableStream({
    pull(c) { if (left-- > 0) c.enqueue(bytes); else c.error(new Error('synthesis failed')); },
  }), { status: 200 });
};

let ctx, requests, original;
beforeEach(() => {
  ctx = new FakeContext();
  original = { window: globalThis.window, fetch: globalThis.fetch };
  globalThis.window = { AudioContext: function AudioContext() { return ctx; } };
  requests = [];
  globalThis.fetch = async (url) => { requests.push(String(url)); return pcm(silence()); };
});
afterEach(() => {
  if (original.window === undefined) delete globalThis.window;
  else globalThis.window = original.window;
  globalThis.fetch = original.fetch;
});

describe('reading replies aloud', () => {
  it('plays a turn\'s bubbles one after the other, each whole, instead of cutting each other off', async () => {
    const done = [];
    const voice = createVoiceOut({ onDone: (id) => done.push(id) });

    voice.speak('a', 1);
    await tick();
    expect(voice.reading).toBe('a');
    expect(ctx.started).toHaveLength(1);

    // the next bubble of the same turn arrives while the first is still sounding: it waits
    voice.speak('b', 1);
    await tick();
    expect(requirementsOf(requests, 'b')).toHaveLength(0);
    expect(ctx.started).toHaveLength(1);
    expect(voice.reading).toBe('a');

    // the first has played out; only then does the second start, and the World hears of each
    ctx.currentTime = 1;
    ctx.started[0].onended();
    await tick();
    expect(done).toEqual(['a']);
    expect(voice.reading).toBe('b');
    expect(ctx.started).toHaveLength(2);

    ctx.currentTime = 2;
    ctx.started[1].onended();
    await tick();
    expect(done).toEqual(['a', 'b']);
    expect(voice.active).toBe(false);
  });

  it('holds a bubble that is playing or still waiting its turn', async () => {
    const voice = createVoiceOut();
    voice.speak('a', 1);
    await tick();
    voice.speak('b', 1);
    expect(voice.holds('a')).toBe(true);
    expect(voice.holds('b')).toBe(true);
    expect(voice.holds('c')).toBe(false);
  });

  it('drops a bubble taken away and lets the replies behind it play', async () => {
    const done = [];
    const voice = createVoiceOut({ onDone: (id) => done.push(id) });
    voice.speak('a', 1);
    await tick();
    voice.speak('b', 1);
    voice.speak('c', 1);
    voice.drop('b');
    expect(voice.holds('b')).toBe(false);

    ctx.currentTime = 1;
    ctx.started[0].onended();
    await tick();
    expect(voice.reading).toBe('c');
    expect(requirementsOf(requests, 'b')).toHaveLength(0);
  });

  it('stops the sound, the queue behind it and the World\'s wait for both', async () => {
    const done = [];
    const voice = createVoiceOut({ onDone: (id) => done.push(id) });
    voice.speak('a', 1);
    await tick();
    voice.speak('b', 1);
    voice.stop();
    expect(voice.active).toBe(false);
    expect(voice.reading).toBe(null);
    // nothing of the turn is left in the page's hands: the World hears of each reply it let go
    expect(done).toEqual(['a', 'b']);

    // a source the stop silenced does not report a reply that ended a second time
    ctx.currentTime = 1;
    ctx.started[0].onended();
    await tick();
    expect(done).toEqual(['a', 'b']);
  });

  it('reports the bubble it takes away, playing or waiting, so no turn is left reading', async () => {
    const done = [];
    const voice = createVoiceOut({ onDone: (id) => done.push(id) });
    voice.speak('a', 1);
    await tick();
    voice.speak('b', 1);
    // a reply taken away before its turn will never play, and nothing else would say so
    voice.drop('b');
    expect(done).toEqual(['b']);
    expect(voice.holds('b')).toBe(false);
    // the one playing is reported the moment its sound is cut
    voice.drop('a');
    expect(done).toEqual(['b', 'a']);
    expect(voice.active).toBe(false);
  });

  it('reports a reply a page without sound cannot read, instead of leaving the World waiting', () => {
    globalThis.window = {};
    const failed = [];
    const voice = createVoiceOut({ onFail: (id) => failed.push(id) });
    voice.speak('a', 1);
    expect(failed).toEqual(['a']);
    expect(voice.active).toBe(false);
    expect(requests).toEqual([]);
  });

  it('ends a reply whose piece was cut halfway, and still plays the one behind it', async () => {
    const done = [], failed = [];
    let asked = 0;
    // the first piece breaks after its one chunk; anything behind it arrives whole
    globalThis.fetch = async () => (++asked === 1 ? cut(silence()) : pcm(silence()));
    const voice = createVoiceOut({ onDone: (id) => done.push(id), onFail: (id) => failed.push(id) });

    voice.speak('a', 1);
    await tick();
    expect(ctx.started).toHaveLength(1);
    await tick();
    // what was cut short ends its reply rather than leaving it hanging: the World hears, so it stops waiting
    expect(failed).toEqual(['a']);
    expect(done).toEqual([]);
    expect(voice.reading).toBe(null);

    // the reply behind the broken one is not held up by it
    voice.speak('b', 1);
    await tick();
    expect(voice.reading).toBe('b');
    expect(ctx.started).toHaveLength(2);
  });
});

/** The piece requests the reader made for bubble `id`. */
function requirementsOf(urls, id) {
  return urls.filter((url) => url.includes(`id=${encodeURIComponent(id)}`));
}
