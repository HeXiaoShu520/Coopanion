/**
 * The Doubao synthesizer against a socket of our own: what one piece asks for, how its audio comes
 * back, what the cache keeps, and how an interruption cuts it short. No network, no sound card.
 */
import { describe, expect, it } from 'vitest';
import type { Logger } from 'cortico/core/types.ts';
import { petText } from '../../src/i18n/index.ts';
import { TTS_RESOURCE, TTS_URL } from '../../src/voice/protocol.ts';
import { DoubaoTts, type PieceCache, type TtsOptions } from '../../src/voice/doubao-tts.ts';
import type { SocketHandlers, SpeechSocket } from '../../src/voice/socket.ts';

const t = petText('zh').doubao;

/** The cache is read before the socket opens: one turn of the event loop before it is there. */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const be32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
};
const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

/** One frame as the service sends it: header, payload size, payload. */
function frame(type: number, flags: number, serialization: number, payload: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(0x11, (type << 4) | flags, serialization << 4, 0), be32(payload.length), payload]);
}
/** A piece of the voice, raw PCM16 as the service streams it. */
const audioFrame = (pcm: Uint8Array): Uint8Array => frame(0xb, 0, 0, pcm);
/** The empty object that ends the stream. */
const endFrame = (): Uint8Array => frame(0x9, 0, 0x1, utf8('{}'));
const errorFrame = (code: number, message: string): Uint8Array =>
  concat([Uint8Array.of(0x11, 0xf0, 0x10, 0), be32(code), be32(utf8(message).length), utf8(message)]);

/** A logger that keeps what was warned about; the engine writes every failure there. */
interface QuietLog extends Logger { readonly warnings: string[] }
function quiet(): QuietLog {
  const warnings: string[] = [];
  const log: QuietLog = {
    warnings,
    trace() {}, debug() {}, info() {}, error() {}, emit() {},
    warn: (msg: string) => { warnings.push(msg); },
    child: () => log,
  };
  return log;
}

/** The pieces made before, kept in memory; a read of it is what a repeated line costs. */
class MemoryCache implements PieceCache {
  readonly made = new Map<string, Uint8Array>();
  async read(key: string): Promise<Uint8Array | null> {
    return this.made.get(key) ?? null;
  }
  write(key: string, pcm: Uint8Array): Promise<void> {
    this.made.set(key, pcm);
    return Promise.resolve();
  }
}

/** The socket the synthesizer thinks it opened; the service's replies are the test's to hand over. */
class FakeSocket implements SpeechSocket {
  readonly sent: Uint8Array[] = [];
  closed = false;
  constructor(private readonly handlers: SocketHandlers) {}
  send(data: Uint8Array): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  connect(): void { this.handlers.open(); }
  audio(pcm: Uint8Array): void { this.handlers.message(audioFrame(pcm)); }
  end(): void { this.handlers.message(endFrame()); }
  fail(code: number, message: string): void { this.handlers.message(errorFrame(code, message)); }
  drop(): void { this.handlers.close(); }
}

interface Harness {
  tts: DoubaoTts;
  cache: MemoryCache;
  log: QuietLog;
  /** The socket of the session opened last. */
  socket(index?: number): FakeSocket;
  urls: string[];
  headers: Array<Record<string, string>>;
  opened: () => number;
}

function harness(over: Partial<TtsOptions> = {}): Harness {
  const opened: FakeSocket[] = [];
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const log = quiet();
  const cache = new MemoryCache();
  const tts = new DoubaoTts({
    config: () => ({ voice: 'zh_female_vv_uranus_bigtts' }),
    key: () => 'key-1',
    cacheDir: () => '',
    text: () => petText('zh'),
    log,
    cache,
    open: (url, sent, handlers) => {
      const socket = new FakeSocket(handlers);
      opened.push(socket);
      urls.push(url);
      headers.push(sent);
      return socket;
    },
    ...over,
  });
  return { tts, cache, log, urls, headers, opened: () => opened.length, socket: (index = -1) => opened.at(index)! };
}

const bodyOf = (frame: Uint8Array): Record<string, unknown> => JSON.parse(new TextDecoder().decode(frame.subarray(8))) as Record<string, unknown>;

/** Two chunks of the voice, as they come back. */
const FIRST = Uint8Array.from([1, 0, 2, 0]);
const SECOND = Uint8Array.from([3, 0, 4, 0]);

describe('one piece', () => {
  it('will not synthesize without a key, and says so instead of connecting', async () => {
    const h = harness({ key: () => '' });
    expect(h.tts.problem()).toBe(t.noKey);
    const chunks: Uint8Array[] = [];
    expect(await h.tts.speak('你好。', (pcm) => chunks.push(pcm))).toBe(t.noKey);
    expect(await h.tts.preview('你好。')).toEqual({ pcm: new Uint8Array(0), error: t.noKey });
    expect(h.opened()).toBe(0);
    expect(chunks).toEqual([]);
  });

  it('asks for the text in the voice in force, and hands the audio over as it arrives', async () => {
    const h = harness();
    const chunks: Uint8Array[] = [];
    const done = h.tts.speak('你好。', (pcm) => chunks.push(pcm));
    await tick();
    const socket = h.socket();
    expect(h.urls).toEqual([TTS_URL]);
    expect(h.headers[0]).toMatchObject({ 'X-Api-Key': 'key-1', 'X-Api-Resource-Id': TTS_RESOURCE, 'X-Api-Sequence': '-1' });
    // nothing goes out before the socket is up
    expect(socket.sent).toEqual([]);

    socket.connect();
    expect(socket.sent).toHaveLength(1);
    expect(bodyOf(socket.sent[0]!)).toMatchObject({
      req_params: { text: '你好。', speaker: 'zh_female_vv_uranus_bigtts', audio_params: { format: 'pcm', sample_rate: 24000 } },
    });

    socket.audio(FIRST);
    socket.audio(SECOND);
    expect(chunks).toEqual([FIRST, SECOND]);
    socket.end();
    expect(await done).toBe(null);
    expect(socket.closed).toBe(true);
    // the whole piece is kept, so the same line next time sounds at once
    expect([...h.cache.made.values()]).toEqual([concat([FIRST, SECOND])]);
  });

  it('plays a piece it made before from the cache, with no socket at all', async () => {
    const h = harness();
    const made: Uint8Array[] = [];
    const first = h.tts.speak('早上好。', (pcm) => made.push(pcm));
    await tick();
    const socket = h.socket();
    socket.connect();
    socket.audio(FIRST);
    socket.end();
    expect(await first).toBe(null);
    expect(made).toEqual([FIRST]);

    const again: Uint8Array[] = [];
    expect(await h.tts.speak('早上好。', (pcm) => again.push(pcm))).toBe(null);
    expect(again).toEqual([FIRST]);
    expect(h.opened()).toBe(1);
  });

  it('keeps nothing of a piece an interruption cut short', async () => {
    const h = harness();
    const chunks: Uint8Array[] = [];
    const done = h.tts.speak('这一段很长。', (pcm) => chunks.push(pcm));
    await tick();
    const socket = h.socket();
    socket.connect();
    socket.audio(FIRST);
    h.tts.cancel();
    expect(await done).toBe(null);
    expect(chunks).toEqual([FIRST]);
    expect(socket.closed).toBe(true);
    expect([...h.cache.made.values()]).toEqual([]);
  });

  it('keeps nothing either when the socket goes before the end', async () => {
    const h = harness();
    const done = h.tts.speak('半途而废。', () => {});
    await tick();
    const socket = h.socket();
    socket.connect();
    socket.audio(FIRST);
    socket.drop();
    expect(await done).toBe(t.closed);
    expect([...h.cache.made.values()]).toEqual([]);
  });

  it('stops when the caller aborts, and calls that no failure', async () => {
    const h = harness();
    const stop = new AbortController();
    const done = h.tts.speak('别念了。', () => {}, stop.signal);
    await tick();
    h.socket().connect();
    stop.abort();
    expect(await done).toBe(null);
    expect(h.socket().closed).toBe(true);
    expect([...h.cache.made.values()]).toEqual([]);
  });
});

describe('what the service says', () => {
  it('reports a rejected request, and warns once', async () => {
    const h = harness();
    const done = h.tts.speak('你好。', () => {});
    await tick();
    const socket = h.socket();
    socket.connect();
    socket.fail(45_000_001, 'quota exceeded');
    const why = t.failed(45_000_001, 'quota exceeded');
    expect(await done).toBe(why);
    expect(h.log.warnings.some((line) => line.includes(why))).toBe(true);
    expect([...h.cache.made.values()]).toEqual([]);
  });

  it('reports a socket that never came up, and one that hangs up', async () => {
    const refused = harness({ open: () => { throw new Error('ECONNREFUSED'); } });
    expect(await refused.tts.speak('你好。', () => {})).toBe(t.connect('ECONNREFUSED'));

    const other = harness();
    const done = other.tts.speak('你好。', () => {});
    await tick();
    other.socket().connect();
    other.socket().drop();
    expect(await done).toBe(t.closed);
  });

  it('does not read a piece of a reply that is no longer the one being read', async () => {
    const h = harness();
    h.tts.reply('s1', ['第一句。', '第二句。']);
    expect(h.tts.pieces('s1')).toBe(2);
    expect(h.tts.pieces('s2')).toBe(0);
    expect(await h.tts.speakReply('s2', 0, () => {})).toBe(t.gone);
    expect(await h.tts.speakReply('s1', 5, () => {})).toBe(t.gone);
    expect(h.opened()).toBe(0);

    // a newer reply is the one the page may pull; the one before it is gone
    h.tts.reply('s2', ['咱们走吧。']);
    expect(h.tts.pieces('s1')).toBe(0);
    const chunks: Uint8Array[] = [];
    const done = h.tts.speakReply('s2', 0, (pcm) => chunks.push(pcm));
    await tick();
    const socket = h.socket();
    socket.connect();
    expect(bodyOf(socket.sent[0]!)).toMatchObject({ req_params: { text: '咱们走吧。' } });
    socket.audio(FIRST);
    socket.end();
    expect(await done).toBe(null);
    expect(chunks).toEqual([FIRST]);

    h.tts.cancel();
    expect(h.tts.pieces('s2')).toBe(0);
    expect(await h.tts.speakReply('s2', 0, () => {})).toBe(t.gone);
  });

  it('takes the panel\u2019s try-listen whole, ready to play', async () => {
    const h = harness();
    const done = h.tts.preview('你好呀，我是 Coo。');
    await tick();
    const socket = h.socket();
    socket.connect();
    socket.audio(FIRST);
    socket.audio(SECOND);
    socket.end();
    expect(await done).toEqual({ pcm: concat([FIRST, SECOND]), error: null });
  });
});
