/**
 * The Doubao recognizer against a socket of our own: what it sends, what it makes of what comes
 * back, and what it says when the service cannot be reached. No network, no microphone.
 */
import { gunzipSync, gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { Logger } from 'cortico/core/types.ts';
import { petText } from '../../src/i18n/index.ts';
import { ASR_SAMPLE_RATE, SAUC_RESOURCE, SAUC_URL } from '../../src/voice/protocol.ts';
import { DoubaoAsr, type DoubaoAsrOptions } from '../../src/voice/doubao-asr.ts';
import type { SocketHandlers, SpeechSocket } from '../../src/voice/socket.ts';

const t = petText('zh').doubao;
/** One frame of audio the service documents: 200 ms at 16 kHz. */
const CHUNK_SAMPLES = (ASR_SAMPLE_RATE * 200) / 1000;
const CHUNK_BYTES = CHUNK_SAMPLES * 2;

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

/** A response as the service sends it: gzip JSON, and the flag that closes the session. */
function response(body: unknown, last = false): Uint8Array {
  const payload = gzipSync(utf8(JSON.stringify(body)));
  return concat([Uint8Array.of(0x11, (0x9 << 4) | (last ? 2 : 0), 0x11, 0), be32(payload.length), payload]);
}

function errorFrame(code: number, message: string): Uint8Array {
  return concat([Uint8Array.of(0x11, 0xf0, 0x10, 0), be32(code), be32(utf8(message).length), utf8(message)]);
}

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

/** The socket the recognizer thinks it opened: the frames it sent, and the service's replies under the test's hand. */
class FakeSocket implements SpeechSocket {
  readonly sent: Uint8Array[] = [];
  closed = false;
  constructor(private readonly handlers: SocketHandlers) {}
  send(data: Uint8Array): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  /** The connection comes up. */
  connect(): void { this.handlers.open(); }
  /** The service answers with one frame; `last` closes the session. */
  say(body: unknown, last = false): void { this.handlers.message(response(body, last)); }
  fail(code: number, message: string): void { this.handlers.message(errorFrame(code, message)); }
  /** The service hangs up. */
  drop(): void { this.handlers.close(); }
}

interface Harness {
  asr: DoubaoAsr;
  log: QuietLog;
  /** The socket of the session opened last. */
  socket(index?: number): FakeSocket;
  urls: string[];
  headers: Array<Record<string, string>>;
}

function harness(over: Partial<DoubaoAsrOptions> = {}): Harness {
  const opened: FakeSocket[] = [];
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const log = quiet();
  const asr = new DoubaoAsr({
    config: () => ({ baseUrl: '' }),
    key: () => 'key-1',
    language: () => 'zh',
    uid: () => 'coo',
    timeoutMs: () => 1000,
    text: () => petText('zh'),
    log,
    open: (url, sent, handlers) => {
      const socket = new FakeSocket(handlers);
      opened.push(socket);
      urls.push(url);
      headers.push(sent);
      return socket;
    },
    ...over,
  });
  return { asr, log, urls, headers, socket: (index = -1) => opened.at(index)! };
}

/** The JSON body of a frame the session sent, past its header and, for a request, nothing else. */
const bodyOf = (frame: Uint8Array): Record<string, unknown> => JSON.parse(new TextDecoder().decode(gunzipSync(frame.subarray(8)))) as Record<string, unknown>;

describe('starting', () => {
  it('will not run without a key, and says so instead of connecting', async () => {
    const h = harness({ key: () => '' });
    await h.asr.start();
    expect(h.asr.state()).toMatchObject({ phase: 'error', url: SAUC_URL, pid: null, detail: t.noKey });
    expect(h.asr.sentence()).toBeNull();
    expect(await h.asr.transcribe(new Int16Array(CHUNK_SAMPLES))).toMatchObject({ text: '', error: t.noKey });
    expect(h.urls).toEqual([]);
  });

  it('refuses an address that is not a ws or wss URL', async () => {
    const h = harness({ config: () => ({ baseUrl: 'https://example.com/asr' }) });
    await h.asr.start();
    expect(h.asr.state()).toMatchObject({ phase: 'error', detail: t.badUrl('https://example.com/asr') });
  });

  it('runs on the official address when none is set, and waits to be started again when that changes', async () => {
    let baseUrl = '';
    const h = harness({ config: () => ({ baseUrl }) });
    await h.asr.start();
    expect(h.asr.state()).toMatchObject({ phase: 'running', url: SAUC_URL });
    expect(h.asr.configChanged).toBe(false);
    baseUrl = ' wss://asr.test/sauc ';
    expect(h.asr.configChanged).toBe(true);
    await h.asr.stop();
    expect(h.asr.state()).toMatchObject({ phase: 'stopped', detail: null });
  });

  it('picks up on a sentence once it runs, with the key and the language tag in the headers and the start request', async () => {
    const h = harness();
    await h.asr.start();
    expect(h.asr.sentence()).not.toBeNull();
    expect(h.headers[0]).toMatchObject({ 'X-Api-Key': 'key-1', 'X-Api-Resource-Id': SAUC_RESOURCE, 'X-Api-Sequence': '-1' });
    expect(h.socket().sent).toEqual([]);

    h.socket().connect();
    const start = h.socket().sent[0]!;
    expect(start[1]! >> 4).toBe(0x1);
    expect(bodyOf(start)).toMatchObject({ user: { uid: 'coo' }, audio: { rate: ASR_SAMPLE_RATE, language: 'zh-CN' } });
  });
});

describe('one sentence', () => {
  it('holds the first frames until the socket is up, then sends the start request before them, in order', async () => {
    const h = harness();
    await h.asr.start();
    const session = h.asr.sentence()!;
    const chunk = () => new Int16Array(CHUNK_SAMPLES);
    session.write(chunk());
    session.write(chunk());
    const socket = h.socket();
    expect(socket.sent).toEqual([]);

    socket.connect();
    expect(socket.sent).toHaveLength(3);
    expect(socket.sent[0]![1]! >> 4).toBe(0x1);
    for (const frame of socket.sent.slice(1)) {
      expect([...frame.subarray(0, 4)]).toEqual([0x11, 0x20, 0x01, 0x00]);
      expect(gunzipSync(frame.subarray(8)).length).toBe(CHUNK_BYTES);
    }
  });

  it('shows the words so far while the person is still speaking', async () => {
    const h = harness();
    await h.asr.start();
    const said: string[] = [];
    h.asr.sentence((text) => said.push(text))!;
    const socket = h.socket();
    socket.connect();
    socket.say({ result: { text: '你好世', utterances: [{ text: '你好', definite: false }] } });
    socket.say({ result: { text: '你好世界。', utterances: [{ text: '你好世界。', definite: false }] } });
    expect(said).toEqual(['你好世', '你好世界。']);
  });

  it('closes the input, waits for the last response, and joins the settled utterances once', async () => {
    const h = harness();
    await h.asr.start();
    const session = h.asr.sentence()!;
    const socket = h.socket();
    socket.connect();
    const first = [{ text: '你好', definite: true, start_time: 0, end_time: 500 }, { text: '世界。', definite: true, start_time: 500, end_time: 900 }];
    socket.say({ result: { text: '你好世界。', utterances: first } });

    const done = session.end();
    // the rest of the sentence goes out as the final frame before the wait
    expect([...socket.sent.at(-1)!.subarray(0, 4)]).toEqual([0x11, 0x22, 0x01, 0x00]);
    // the service repeats the same utterances in its last frame: they are not taken twice
    socket.say({ result: { text: '你好世界。', utterances: first } }, true);
    expect(await done).toMatchObject({ text: '你好世界。', error: null });
    expect(socket.closed).toBe(true);
  });

  it('gives up on the wait when the service says nothing more, and reports that nothing was heard', async () => {
    const h = harness({ timeoutMs: () => 5 });
    await h.asr.start();
    const session = h.asr.sentence()!;
    h.socket().connect();
    expect(await session.end()).toMatchObject({ text: '', error: t.noText });
  });

  it('stops the engine on a rejection from the service, before the socket ever opened', async () => {
    const h = harness();
    await h.asr.start();
    const session = h.asr.sentence()!;
    h.socket().fail(45_000_001, 'quota exceeded');
    const why = t.failed(45_000_001, 'quota exceeded');
    expect(h.asr.state()).toMatchObject({ phase: 'error', detail: why });
    expect(h.log.warnings.some((line) => line.includes(why))).toBe(true);
    expect(await session.end()).toMatchObject({ text: '', error: why });
  });

  it('stops the engine on a rejection from the service, after the socket came up too', async () => {
    const h = harness();
    await h.asr.start();
    const session = h.asr.sentence()!;
    h.socket().connect();
    h.socket().fail(45_000_001, 'quota exceeded');
    const why = t.failed(45_000_001, 'quota exceeded');
    expect(h.asr.state()).toMatchObject({ phase: 'error', detail: why });
    expect(await session.end()).toMatchObject({ text: '', error: why });
    // the engine no longer takes sentences until it is started again
    expect(h.asr.sentence()).toBeNull();
  });

  it('reports a socket that never came up, and one that hangs up mid-sentence', async () => {
    const h = harness({ open: () => { throw new Error('ECONNREFUSED'); } });
    await h.asr.start();
    const session = h.asr.sentence()!;
    expect(h.asr.state()).toMatchObject({ phase: 'error', detail: t.connect('ECONNREFUSED') });
    expect(await session.end()).toMatchObject({ error: t.connect('ECONNREFUSED') });

    const other = harness();
    await other.asr.start();
    const second = other.asr.sentence()!;
    other.socket().connect();
    other.socket().drop();
    expect(await second.end()).toMatchObject({ text: '', error: t.closed });
    // the socket did come up, so the engine stays ready for the next sentence
    expect(other.asr.state().phase).toBe('running');
  });

  it('takes a whole sentence through transcribe, and nothing at all while stopped', async () => {
    const h = harness();
    expect(await h.asr.transcribe(new Int16Array(CHUNK_SAMPLES))).toMatchObject({ error: t.notRunning });

    await h.asr.start();
    const pending = h.asr.transcribe(new Int16Array(CHUNK_SAMPLES * 2));
    const socket = h.socket();
    socket.connect();
    // two frames of 200 ms went out behind the start request, then the final one
    expect(socket.sent.map((frame) => frame[1]! & 0x0f)).toEqual([0, 0, 0, 2]);
    socket.say({ result: { text: '好的。', utterances: [{ text: '好的。', definite: true, start_time: 0, end_time: 800 }] } }, true);
    expect(await pending).toMatchObject({ text: '好的。', error: null });
  });
});
