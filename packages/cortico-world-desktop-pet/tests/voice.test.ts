/**
 * Voice input end to end inside the World: PCM frames over the pet socket → segmenter → Doubao's
 * streaming recognition (a service of our own on the other side) → `desktop-pet.speech` event,
 * with the listen phases the page shows along the way.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'fflate';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESKTOP_PET_DEFAULTS, type MicMode } from '../src/config.ts';
import { DesktopPetWorld } from '../src/world.ts';
import { petText } from '../src/i18n/index.ts';
import type { Language } from 'cortico/core/language.ts';
import { parseHotkey, tapTracker, TAP_MAX_MS, type Hotkey, type watchHotkey } from '../src/asr/hotkey.ts';
import { rmsDb } from '../src/asr/segmenter.ts';
import { KWS_MODEL } from '../src/runtime/store.ts';
import { SAUC_URL } from '../src/voice/protocol.ts';
import type { WakeModule, WakeSpotter } from '../src/voice/kws.ts';
import type { SocketHandlers, SocketOpen, SpeechSocket } from '../src/voice/socket.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { FakePage } from './helpers/page.ts';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const be32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
};

/** A response as the service sends it: gzip JSON, and the flag that closes the session. */
function response(body: unknown, last = false): Uint8Array {
  const payload = gzipSync(utf8(JSON.stringify(body)));
  const out = new Uint8Array(8 + payload.length);
  out.set([0x11, (0x9 << 4) | (last ? 2 : 0), 0x11, 0]);
  out.set(be32(payload.length), 4);
  out.set(payload, 8);
  return out;
}

/** One session on the service's side: the frames it was sent, and the text it answers with. */
class TestSocket implements SpeechSocket {
  readonly sent: Uint8Array[] = [];
  /** Audio frames sent, the final one included. */
  audio = 0;

  constructor(
    private readonly handlers: SocketHandlers,
    private readonly answer: string | ((frames: number) => string),
    private readonly partialOf?: (frames: number) => string | null,
  ) {}

  send(data: Uint8Array): void {
    this.sent.push(data);
    // the start request carries the session's format; only audio frames are answered
    if ((data[1]! >> 4) === 0x1) return;
    this.audio++;
    if ((data[1]! & 0x02) !== 0) {
      const text = typeof this.answer === 'string' ? this.answer : this.answer(this.audio);
      const utterances = text ? [{ text, definite: true, start_time: 0, end_time: this.audio }] : [];
      queueMicrotask(() => this.handlers.message(response({ result: { text, utterances } }, true)));
      return;
    }
    const partial = this.partialOf?.(this.audio);
    if (partial) queueMicrotask(() => this.handlers.message(response({ result: { text: partial, utterances: [{ text: partial, definite: false }] } })));
  }

  close(): void {}
}

/** The service the World's recognizer talks to: every session's address, headers and frames. */
class TestSpeech {
  readonly urls: string[] = [];
  readonly headers: Array<Record<string, string>> = [];
  readonly sockets: TestSocket[] = [];

  constructor(
    private readonly answer: string | ((frames: number) => string),
    private readonly partialOf?: (frames: number) => string | null,
  ) {}

  readonly open: SocketOpen = (url, headers, handlers) => {
    this.urls.push(url);
    this.headers.push(headers);
    const socket = new TestSocket(handlers, this.answer, this.partialOf);
    this.sockets.push(socket);
    // the connection comes up by itself, as a live one does
    queueMicrotask(() => handlers.open());
    return socket;
  };

  /** The session opened last. */
  get socket(): TestSocket {
    return this.sockets.at(-1)!;
  }
}

const tone = (ms: number, amp: number) => {
  const frames: Int16Array[] = [];
  for (let f = 0; f < ms / 20; f++) {
    const fr = new Int16Array(320);
    for (let i = 0; i < 320; i++) fr[i] = Math.round(amp * 32767 * Math.sin(2 * Math.PI * 440 * (f * 320 + i) / 16000));
    frames.push(fr);
  }
  return frames;
};

/** Speech, then the pause that closes the sentence. */
const sentence = (ms = 900) => [...tone(ms, .3), ...tone(900, 0)];

/** Writes a config patch into the live section, as Core does with a World's persist. */
const merge = (to: Record<string, unknown>, patch: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) merge(to[k] as Record<string, unknown>, v as Record<string, unknown>);
    else to[k] = v;
  }
};

const server = (world: DesktopPetWorld) => world.voiceState().server as { phase: string; url: string; pid: null; detail: string | null };
const input = (world: DesktopPetWorld) => world.voiceState().input as { mode: MicMode; open: boolean; hotkeyProblem: string | null; hint: string };
const counts = (world: DesktopPetWorld) => world.voiceState().counts as { utterances: number; delivered: number; dropped: number };
const call = (world: DesktopPetWorld, method: string, args: unknown[] = []) => world.webUi().invoke!('voice', method, args);

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

/** A talk key the test presses; `problem` makes it unreadable. */
function scriptedKey(problem?: string) {
  const key = { press: (_down: boolean) => {}, tap: () => {}, hotkey: null as Hotkey | null };
  const watch = async (hotkey: Hotkey, onChange: (down: boolean) => void, _pollMs: number, onTap?: (count: number) => void) => {
    if (problem) return problem;
    key.hotkey = hotkey;
    key.press = onChange;
    key.tap = () => onTap?.(1);
    return { stop: () => {} };
  };
  return { key, watch };
}

/** Hardware key samples go through the production gesture tracker for every active watcher. */
function sampledKeys() {
  const held = new Set<number>();
  const watchers = new Set<{ keys: number[]; step: ReturnType<typeof tapTracker> }>();
  const watch: typeof watchHotkey = async (hotkey, onChange, _pollMs, onTap, _text, trigger) => {
    const watcher = { keys: hotkey.keys, step: tapTracker(hotkey.taps, onChange, onTap, trigger) };
    watchers.add(watcher);
    return { stop: () => { watchers.delete(watcher); } };
  };
  const sample = (key: string, down: boolean, at: number) => {
    for (const vk of parseHotkey(key)!.keys) {
      if (down) held.add(vk); else held.delete(vk);
    }
    for (const watcher of watchers) watcher.step(watcher.keys.every((vk) => held.has(vk)), at);
  };
  return { watch, sample };
}

/** The wake word said once: the spotter answers with its keyword on the first frame, and the cooldown keeps it at one. */
function scriptedWake() {
  const spotter: WakeSpotter = {
    createStream: () => ({ acceptWaveform: () => {} }),
    isReady: () => true,
    decode: () => {},
    reset: () => {},
    getResult: () => ({ keyword: '小可' }),
  };
  const load = (): WakeModule => ({ KeywordSpotter: function () { return spotter; } as unknown as new (config: Record<string, unknown>) => WakeSpotter });
  return { load };
}

interface Setup {
  mode?: MicMode;
  watch?: ReturnType<typeof scriptedKey>['watch'];
  language?: Language;
  openOnPress?: boolean;
  /** The wake word on, with its model's files standing in and `loadWake` as the spotter. */
  wake?: boolean;
  loadWake?: () => WakeModule;
  /** The API Key Core hands over; empty is a deployment that saved none. */
  key?: string;
  /** What the service says while the sentence is still being heard. */
  partial?: (frames: number) => string | null;
  /** The phase the recognizer is expected to come up in. */
  phase?: 'running' | 'error';
}

async function setup(answer: string | ((frames: number) => string), o: Setup = {}) {
  const speech = new TestSpeech(answer, o.partial);
  const keys = { value: o.key ?? 'test-key' };
  const cfg = structuredClone(DESKTOP_PET_DEFAULTS);
  Object.assign(cfg, { enabled: true, port: 0 });
  cfg.window.enabled = false;
  cfg.asr.mic.mode = o.mode ?? 'always';
  cfg.asr.mic.openOnPress = o.openOnPress ?? false;
  cfg.wake.enabled = o.wake ?? false;
  if (o.wake) {
    // the keywords the spotter is built from, in its own tokens; the cooldown keeps a test to one wake
    cfg.wake.keywords = '▁小 ▁可 :2.0 #0.4 @小可';
    cfg.wake.cooldownMs = 60_000;
  }
  const dir = mkdtempSync(join(tmpdir(), 'pet-voice-'));
  if (o.wake) {
    const model = join(dir, 'm', KWS_MODEL.id);
    mkdirSync(model, { recursive: true });
    for (const role of ['encoder', 'decoder', 'joiner']) writeFileSync(join(model, `${role}-x.onnx`), 'x');
    writeFileSync(join(model, 'tokens.txt'), '▁小 0\n▁可 1\n');
  }
  const host = new FakeHost();
  const world = new DesktopPetWorld({
    cfg, timezone: 'Asia/Shanghai', persist: (patch) => merge(cfg as never, patch as never), runtimesRoot: () => join(dir, 'rt'), modelsDir: () => join(dir, 'm'),
    watchHotkey: o.watch, language: () => o.language ?? 'zh',
    doubaoApiKey: () => keys.value, storeDoubaoApiKey: (key) => { keys.value = key; },
    openSpeechSocket: speech.open,
    loadWake: o.loadWake,
  });
  await world.start(host);
  cleanup.push(() => world.stop());
  await expect.poll(() => server(world).phase).toBe(o.phase ?? 'running');
  const page = await FakePage.open(world.petUrl.replace(/\/pet$/, ''));
  cleanup.push(() => page.close());
  return { speech, keys, world, host, page, cfg };
}

describe('voice input', () => {
  it('stops the recognizer when voice input is switched off and starts it again when it is switched on', async () => {
    const { cfg, world } = await setup('hello');
    cfg.asr.enabled = false;
    await expect.poll(() => server(world).phase).toBe('stopped');
    expect(server(world).pid).toBeNull();
    cfg.asr.enabled = true;
    await expect.poll(() => server(world).phase).toBe('running');
  });

  it("takes Doubao's address and Key from the panel, and the next sentence opens a session on the new address with that Key", async () => {
    const { speech, world, page } = await setup('你好');
    const saved = await call(world, 'setDoubao', [{ baseUrl: 'wss://asr.test/sauc', key: 'key-2' }]) as { server: { phase: string; url: string }; doubao: { baseUrl: string; keySaved: boolean } };
    expect(saved.doubao).toMatchObject({ baseUrl: 'wss://asr.test/sauc', keySaved: true });
    expect(saved.server).toMatchObject({ phase: 'running', url: 'wss://asr.test/sauc' });
    for (const fr of sentence()) page.audio(fr);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    await expect.poll(() => speech.urls.length, { timeout: 5000 }).toBe(1);
    expect(speech.urls[0]).toBe('wss://asr.test/sauc');
    expect(speech.headers[0]).toMatchObject({ 'X-Api-Key': 'key-2' });
  });

  it('turns a spoken utterance into one speech event that wakes without interrupting the round', async () => {
    const { speech, host, page } = await setup('今天天气怎么样');
    for (const fr of sentence()) page.audio(fr);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0]).toMatchObject({ type: 'desktop-pet.speech', senderKey: 'desktop-pet.voice', text: '[voice] 伙伴:今天天气怎么样' });
    // always listening also hears a TV or other people
    expect(host.pushOpts[0]).toEqual({ trigger: 'flush' });
    expect((await page.next((m) => m.t === 'listen' && m.phase === 'heard')).text).toBe('今天天气怎么样');
    // one session per sentence: the live one, on the official address with the shared Key, ended by its own final frame
    expect(speech.urls).toEqual([SAUC_URL]);
    expect(speech.headers[0]).toMatchObject({ 'X-Api-Key': 'test-key' });
    expect(speech.socket.sent.at(-1)![1]! & 0x02).not.toBe(0);
  });

  it('holds a sentence that breaks off on a connective, so the rest arrives in the same event', async () => {
    let said = 0;
    const { host, page } = await setup(() => (++said === 1 ? '我想说的是' : '今天有点累'));
    for (const fr of sentence()) page.audio(fr);
    await expect.poll(() => said, { timeout: 5000 }).toBe(1);
    // transcribed and past its closing pause: without the wait for the rest it would have gone out
    await new Promise((r) => setTimeout(r, 300));
    expect(host.events).toHaveLength(0);
    for (const fr of sentence()) page.audio(fr);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0]).toMatchObject({ type: 'desktop-pet.speech', text: '[voice] 伙伴:我想说的是今天有点累' });
  });

  it('a threshold set from the meter applies to the next frame: speech below it is not heard', async () => {
    const { world, host, page } = await setup('不该听见');
    const speech = tone(900, .3);
    const state = await call(world, 'setThreshold', [rmsDb(speech[0]!) + 3]) as { thresholdDb: number };
    expect(state.thresholdDb).toBe(rmsDb(speech[0]!) + 3);
    const last = tone(20, .05)[0]!;
    for (const fr of [...speech, ...tone(900, 0), last]) page.audio(fr);
    await expect.poll(() => world.voiceState().level).toBe(rmsDb(last));
    expect(counts(world).utterances).toBe(0);
    expect(host.events).toHaveLength(0);
  });

  it('drops a known hallucination and tells the page nothing was heard', async () => {
    const { host, page } = await setup('谢谢观看');
    for (const fr of sentence()) page.audio(fr);
    await page.next((m) => m.t === 'listen' && m.phase === 'none');
    expect(host.events).toHaveLength(0);
  });

  it('hold: only audio while the talk key is down counts, and releasing the key ends the utterance', async () => {
    const { key, watch } = scriptedKey();
    const { host, page, world } = await setup('帮我看看这个', { mode: 'hold', watch });
    expect(key.hotkey).toEqual(parseHotkey(DESKTOP_PET_DEFAULTS.asr.mic.hotkey));
    for (const fr of tone(600, .3)) page.audio(fr);
    await new Promise((r) => setTimeout(r, 200));
    expect(counts(world).utterances).toBe(0);
    // the quick tap before the held press: the pet perks up before it listens
    key.tap();
    await page.next((m) => m.t === 'listen' && m.phase === 'ready');
    key.press(true);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    // quiet speech still counts while the key is held, pauses included
    for (const fr of [...tone(500, .01), ...tone(800, 0), ...tone(300, .01)]) page.audio(fr);
    await new Promise((r) => setTimeout(r, 200));
    expect(host.events).toHaveLength(0);
    key.press(false);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0]!.text).toBe('[voice] 伙伴:帮我看看这个');
    expect(host.pushOpts[0]).toEqual({ trigger: 'interrupt' });
  });

  it('hold: the microphone stays open across a press and release unless it is set to open on press', async () => {
    const { key, watch } = scriptedKey();
    const { page } = await setup('帮我看看这个', { mode: 'hold', watch });
    expect(page.init.mic).toBe(true);
    key.press(true);
    key.press(false);
    await new Promise((r) => setTimeout(r, 800));
    expect(page.messages.some((m) => m.t === 'prefs' && m.mic === false)).toBe(false);
  });

  it('hold, open on press: the page opens the microphone from the press until shortly after the release', async () => {
    const { key, watch } = scriptedKey();
    const { page } = await setup('帮我看看这个', { mode: 'hold', watch, openOnPress: true });
    expect(page.init.mic).toBe(false);
    key.press(true);
    await page.next((m) => m.t === 'prefs' && m.mic === true);
    // listening starts with the first frame from the microphone the press opened
    page.audio(tone(20, .01)[0]!);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    key.press(false);
    await page.next((m) => m.t === 'prefs' && m.mic === false);
  });

  it("the listening bubble's cancel drops what was heard, sends nothing and closes the bubble", async () => {
    const { key, watch } = scriptedKey();
    const { host, page } = await setup('说错了', { mode: 'hold', watch });
    key.press(true);
    for (const fr of tone(600, .3)) page.audio(fr);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    page.send({ t: 'cancel' });
    await page.next((m) => m.t === 'listen' && m.phase === 'none');
    // the key comes up after the cancel: nothing is left to send
    key.press(false);
    await new Promise((r) => setTimeout(r, 500));
    expect(host.events).toHaveLength(0);
    expect(page.messages.some((m) => m.t === 'listen' && m.phase === 'heard')).toBe(false);
  });

  it('a talk key that cannot be read keeps the gate closed', async () => {
    const { watch } = scriptedKey('no keyboard here');
    const { page, world } = await setup('不该听见', { mode: 'hold', watch });
    expect(input(world)).toMatchObject({ mode: 'hold', hotkeyProblem: 'no keyboard here', open: false });
    expect(input(world).hint).toContain('no keyboard here');
    const last = tone(20, .05)[0]!;
    for (const fr of [...tone(900, .3), ...tone(900, 0), last]) page.audio(fr);
    // frames arrive in order: once the last one is metered, every sentence the others made is counted
    await expect.poll(() => world.voiceState().level).toBe(rmsDb(last));
    expect(counts(world).utterances).toBe(0);
  });

  it('the typing key is watched only once switched on, and its press opens the typing box', async () => {
    const { key, watch } = scriptedKey();
    // listening without a key: any key watched is the typing key
    const { page, cfg } = await setup('', { watch });
    expect(key.hotkey).toBeNull();
    cfg.typeKey.enabled = true;
    await expect.poll(() => key.hotkey).not.toBeNull();
    key.press(true);
    await page.next((m) => m.t === 'type');
  });

  it.each([
    ['RightCtrl', false], ['RightCtrl', true], ['RightCtrl*2', false], ['RightCtrl*2', true],
  ] as const)('%s with openOnPress=%s: double-tap types without voice; holding speaks without typing', async (hotkey, openOnPress) => {
    const { watch, sample } = sampledKeys();
    const { world, page, speech, host } = await setup('听清楚了', { mode: 'hold', watch, language: 'zh', openOnPress });
    await world.webUi().invoke!('voice', 'setMic', [{ hotkey }]);
    await world.webUi().invoke!('pet', 'setTypeKey', [{ enabled: true, hotkey: 'RightCtrl*2' }]);

    sample('RightCtrl', true, 0);
    expect(world.voiceState().input).toMatchObject({ open: false });
    sample('RightCtrl', false, 100);
    sample('RightCtrl', true, 200);
    sample('RightCtrl', true, 200 + TAP_MAX_MS);
    expect(world.voiceState().input).toMatchObject({ open: false });
    for (const fr of tone(600, .3)) page.audio(fr);
    const closedFrame = tone(20, .05)[0];
    page.audio(closedFrame);
    await expect.poll(() => world.voiceState().level).toBe(rmsDb(closedFrame));
    sample('RightCtrl', false, 200 + TAP_MAX_MS);
    await page.next((m) => m.t === 'type');
    expect(page.messages.some((m) => m.t === 'listen' && m.phase === 'start')).toBe(false);
    if (openOnPress) expect(page.messages.some((m) => m.t === 'prefs' && m.mic === true)).toBe(false);
    expect(speech.urls).toHaveLength(0);
    expect(host.events).toHaveLength(0);

    sample('RightCtrl', true, 1000);
    sample('RightCtrl', false, 1100);
    sample('RightCtrl', true, 1200);
    sample('RightCtrl', true, 1200 + TAP_MAX_MS + 1);
    expect(world.voiceState().input).toMatchObject({ open: true });
    if (openOnPress) await page.next((m) => m.t === 'prefs' && m.mic === true);
    for (const fr of tone(600, .3)) page.audio(fr);
    const openFrame = tone(20, .1)[0];
    page.audio(openFrame);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    await expect.poll(() => world.voiceState().level).toBe(rmsDb(openFrame));
    sample('RightCtrl', false, 2200);
    expect(world.voiceState().input).toMatchObject({ open: false });
    await page.next((m) => m.t === 'listen' && m.phase === 'heard');
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toBe('[voice] 伙伴:听清楚了');
    expect(page.messages.some((m) => m.t === 'type')).toBe(false);
  });

  it('stopping a key watcher during a pending hold prevents it from opening voice later', async () => {
    const { watch, sample } = sampledKeys();
    const { world, page } = await setup('', { mode: 'hold', watch, language: 'zh', openOnPress: true });
    await world.webUi().invoke!('voice', 'setMic', [{ hotkey: 'RightCtrl' }]);
    await world.webUi().invoke!('pet', 'setTypeKey', [{ enabled: true, hotkey: 'RightCtrl*2' }]);
    sample('RightCtrl', true, 0);
    await world.webUi().invoke!('voice', 'setMic', [{ hotkey: 'F8' }]);
    sample('RightCtrl', true, TAP_MAX_MS + 1);
    expect(world.voiceState().input).toMatchObject({ open: false });
    expect(page.messages.some((m) => m.t === 'listen' && m.phase === 'start')).toBe(false);
  });

  it('hold: a talk key apart from the typing key listens from the press', async () => {
    const { watch, sample } = sampledKeys();
    const { world, page } = await setup('', { mode: 'hold', watch });
    await world.webUi().invoke!('voice', 'setMic', [{ hotkey: 'RightCtrl' }]);
    await world.webUi().invoke!('pet', 'setTypeKey', [{ enabled: true, hotkey: 'F8*2' }]);
    sample('RightCtrl', true, 0);
    expect(world.voiceState().input).toMatchObject({ open: true });
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    sample('RightCtrl', false, 100);
    expect(world.voiceState().input).toMatchObject({ open: false });
  });

  it('hold: a talk key shared with the typing key listens only once held past a tap', async () => {
    const { watch, sample } = sampledKeys();
    const { world } = await setup('', { mode: 'hold', watch });
    await world.webUi().invoke!('voice', 'setMic', [{ hotkey: 'RightCtrl' }]);
    await world.webUi().invoke!('pet', 'setTypeKey', [{ enabled: true, hotkey: 'RightCtrl*2' }]);
    sample('RightCtrl', true, 0);
    sample('RightCtrl', true, TAP_MAX_MS);
    expect(world.voiceState().input).toMatchObject({ open: false });
    sample('RightCtrl', true, TAP_MAX_MS + 1);
    expect(world.voiceState().input).toMatchObject({ open: true });
  });

  it('hold: changing the typing key restarts the talk key watcher with the matching trigger', async () => {
    const { watch, sample } = sampledKeys();
    const { world, cfg } = await setup('', { mode: 'hold', watch });
    await world.webUi().invoke!('voice', 'setMic', [{ hotkey: 'RightCtrl' }]);
    sample('RightCtrl', true, 0);
    expect(world.voiceState().input).toMatchObject({ open: true });
    sample('RightCtrl', false, 100);
    // switched on through the pet panel with the same key: the press waits out a tap
    await world.webUi().invoke!('pet', 'setTypeKey', [{ enabled: true, hotkey: 'RightCtrl*2' }]);
    sample('RightCtrl', true, 1000);
    expect(world.voiceState().input).toMatchObject({ open: false });
    sample('RightCtrl', true, 1000 + TAP_MAX_MS + 1);
    expect(world.voiceState().input).toMatchObject({ open: true });
    sample('RightCtrl', false, 1500);
    // switched off in the config directly: the next config sync goes back to listening from the press
    cfg.typeKey.enabled = false;
    await expect.poll(() => {
      sample('RightCtrl', true, 2000);
      const open = (world.voiceState().input as { open: boolean }).open;
      sample('RightCtrl', false, 2050);
      return open;
    }).toBe(true);
  });

  it('a single-press typing shortcut opens the box before the key is released', async () => {
    const { watch, sample } = sampledKeys();
    const { world, page } = await setup('', { mode: 'always', watch });
    await world.webUi().invoke!('pet', 'setTypeKey', [{ enabled: true, hotkey: 'F8' }]);
    sample('F8', true, 0);
    await page.next((m) => m.t === 'type');
  });

  it('the microphone button held down sends the sentence without waiting for its closing pause', async () => {
    const { host, page } = await setup('帮我开灯');
    // speech with no pause after it: the segmenter is still inside the sentence
    for (const fr of tone(600, .3)) page.audio(fr);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    await new Promise((r) => setTimeout(r, 300));
    expect(host.events).toHaveLength(0);
    page.send({ t: 'commit' });
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0]!.text).toBe('[voice] 伙伴:帮我开灯');
    expect((await page.next((m) => m.t === 'listen' && m.phase === 'heard')).text).toBe('帮我开灯');
  });

  it('hold: the round does not go out while the key is still held', async () => {
    const { key, watch } = scriptedKey();
    const { cfg, host, page } = await setup('说到一半', { mode: 'hold', watch });
    // a held key arms no clock, so its length cannot send anything
    cfg.asr.mic.roundSeconds = 1;
    key.press(true);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    for (const fr of tone(700, .3)) page.audio(fr);
    await new Promise((r) => setTimeout(r, 2500));
    expect(host.events).toHaveLength(0);
    key.press(false);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0]!.text).toBe('[voice] 伙伴:说到一半');
  });

  it('hold: letting go ends the round, and what is said next opens the next one', async () => {
    const { key, watch } = scriptedKey();
    const { host, page, world } = await setup('说到一半', { mode: 'hold', watch });
    key.press(true);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    for (const fr of tone(700, .3)) page.audio(fr);
    // the frames are metered before the key comes up: letting go flushes what was heard
    await expect.poll(() => world.voiceState().level).toBeGreaterThan(-30);
    key.press(false);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0]!.text).toBe('[voice] 伙伴:说到一半');
    expect((await page.next((m) => m.t === 'listen' && m.phase === 'heard')).text).toBe('说到一半');
    // the next press hears a round of its own
    key.press(true);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    for (const fr of tone(400, .3)) page.audio(fr);
    await new Promise((r) => setTimeout(r, 300));
    key.press(false);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(2);
    expect(counts(world).utterances).toBe(2);
  });

  it('listening all the time: speech with no pause in it still goes out at the round length', async () => {
    const { cfg, host, page } = await setup('一口气说完');
    cfg.asr.mic.roundSeconds = 1;
    // no closing pause ever comes: without the clock this waits for one that never arrives
    for (const fr of tone(1500, .3)) page.audio(fr);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0]!.text).toBe('[voice] 伙伴:一口气说完');
  });

  it('listening all the time: the round after one that ran its length gets a clock of its own', async () => {
    let said = 0;
    const { cfg, host, page } = await setup(() => (++said === 1 ? '头一句' : '下一句'));
    cfg.asr.mic.roundSeconds = 1;
    for (const fr of tone(2000, .3)) page.audio(fr);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0]!.text).toBe('[voice] 伙伴:头一句');
    // listening goes on in a new round: this one is sent by its own clock too, not by a pause that never comes
    for (const fr of tone(2000, .3)) page.audio(fr);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(2);
    expect(host.events[1]!.text).toBe('[voice] 伙伴:下一句');
  });

  it('the panel writes the round length and the state carries it back', async () => {
    const { world } = await setup('x');
    const state = await call(world, 'setMic', [{ roundSeconds: 90 }]) as { input: { roundSeconds: number } };
    expect(state.input.roundSeconds).toBe(90);
  });

  it('a length written from the panel restarts the clock of the round being heard', async () => {
    const { host, page, world } = await setup('改一下长度');
    for (const fr of tone(600, .3)) page.audio(fr);
    await expect.poll(() => world.voiceState().level).toBeGreaterThan(-30);
    // the round opened on the default minute, which has barely begun
    const state = await call(world, 'setMic', [{ roundSeconds: 5 }]) as { input: { roundSeconds: number } };
    expect(state.input.roundSeconds).toBe(5);
    // five seconds from the change, not the minute the round opened on
    await expect.poll(() => host.events.length, { timeout: 9000 }).toBe(1);
    expect(host.events[0]!.text).toBe('[voice] 伙伴:改一下长度');
  });

  it('a switch to a held key takes the clock off the round being heard', async () => {
    const { watch } = scriptedKey();
    const { host, page, world } = await setup('说到一半', { watch });
    await call(world, 'setMic', [{ roundSeconds: 5 }]);
    for (const fr of tone(600, .3)) page.audio(fr);
    await expect.poll(() => world.voiceState().level).toBeGreaterThan(-30);
    // the round is on a five-second clock; a held key ends rounds on release instead
    await call(world, 'setMic', [{ mode: 'hold' }]);
    await new Promise((r) => setTimeout(r, 6000));
    expect(host.events).toHaveLength(0);
  });

  it('the word that woke the pet is taken off the front of what was said', async () => {
    const { watch } = scriptedKey();
    const { load } = scriptedWake();
    const { host, page } = await setup('小可今天天气怎么样', { mode: 'hold', watch, wake: true, loadWake: load });
    for (const fr of sentence(600)) page.audio(fr);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    // the name was said to call it, not asked of it
    expect(host.events[0]!.text).toBe('[voice] 伙伴:今天天气怎么样');
  });

  it('a sentence that is only the word that woke it asks nothing', async () => {
    const { watch } = scriptedKey();
    const { load } = scriptedWake();
    const { host, page, world } = await setup('小可', { mode: 'hold', watch, wake: true, loadWake: load });
    for (const fr of sentence(600)) page.audio(fr);
    await page.next((m) => m.t === 'listen' && m.phase === 'none');
    expect(counts(world).dropped).toBe(1);
    expect(host.events).toHaveLength(0);
  });

  it('hold: the round a wake word opens runs to the round length', async () => {
    const { watch } = scriptedKey();
    const { load } = scriptedWake();
    const { host, page, world } = await setup('叫醒了', { mode: 'hold', watch, wake: true, loadWake: load });
    await call(world, 'setMic', [{ roundSeconds: 5 }]);
    // the word opens a round; the speech after it never pauses
    for (const fr of tone(400, .3)) page.audio(fr);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    for (const fr of tone(2000, .3)) page.audio(fr);
    await expect.poll(() => host.events.length, { timeout: 9000 }).toBe(1);
    expect(host.events[0]!.text).toBe('[voice] 伙伴:叫醒了');
  });

  it('hold: the talk key takes the round a wake word opened off its clock', async () => {
    const { key, watch } = scriptedKey();
    const { load } = scriptedWake();
    const { host, page, world } = await setup('说到一半', { mode: 'hold', watch, wake: true, loadWake: load });
    await call(world, 'setMic', [{ roundSeconds: 5 }]);
    for (const fr of tone(400, .3)) page.audio(fr);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    // the round the word opened is on a five-second clock; from the press it ends on release
    key.press(true);
    for (const fr of tone(2000, .3)) page.audio(fr);
    await new Promise((r) => setTimeout(r, 6000));
    expect(host.events).toHaveLength(0);
    key.press(false);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0]!.text).toBe('[voice] 伙伴:说到一半');
  });

  it('a page that connects while the word is being waited for is told so', async () => {
    const { watch } = scriptedKey();
    const { load } = scriptedWake();
    const { world, page } = await setup('不该听见', { mode: 'hold', watch, wake: true, loadWake: load });
    await page.next((m) => m.t === 'wake' && m.armed === true);
    // a reloaded page is a page that has been told nothing: it is told again
    await page.close();
    const again = await FakePage.open(world.petUrl.replace(/\/pet$/, ''));
    await again.next((m) => m.t === 'wake' && m.armed === true);
    await again.close();
  });

  it('hold: the window a wake word opens runs out, and the talk key after it is heard on its own', async () => {
    const { key, watch } = scriptedKey();
    const { load } = scriptedWake();
    const { host, page, world } = await setup('小可帮我看看', { mode: 'hold', watch, wake: true, loadWake: load });
    const quiet = tone(20, 0)[0]!;
    page.audio(quiet);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    // the word opened a window: the pet is no longer merely waiting for it
    await page.next((m) => m.t === 'wake' && m.armed === false);
    // a microphone keeps sending silence, and ten seconds of it outlast the window
    const seen = page.messages.length;
    const until = Date.now() + 10_600;
    while (Date.now() < until) { page.audio(quiet); await new Promise((r) => setTimeout(r, 20)); }
    // the window is over: the word is waited for again
    await expect.poll(() => page.messages.slice(seen).some((m) => m.t === 'wake' && m.armed === true), { timeout: 4000 }).toBe(true);
    // and the key's sentence is the person's: the word at its front was said to the pet, not by a wake still open
    key.press(true);
    for (const fr of tone(700, .3)) page.audio(fr);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    await new Promise((r) => setTimeout(r, 200));
    key.press(false);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0]!.text).toBe('[voice] 伙伴:小可帮我看看');
  });

  it('switching voice input off drops the round it was hearing instead of leaving the bubble open', async () => {
    const { cfg, host, page, world } = await setup('说到一半');
    for (const fr of tone(600, .3)) page.audio(fr);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    cfg.asr.enabled = false;
    await page.next((m) => m.t === 'listen' && m.phase === 'none');
    await new Promise((r) => setTimeout(r, 400));
    // the words heard so far were never transcribed: the round went with the recognizer
    expect(counts(world).utterances).toBe(0);
    expect(host.events).toHaveLength(0);
  });

  it('the key held with nothing heard closes the listening bubble and sends nothing', async () => {
    const { key, watch } = scriptedKey();
    const { speech, host, page } = await setup('x', { mode: 'hold', watch });
    key.press(true);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    key.press(false);
    await page.next((m) => m.t === 'listen' && m.phase === 'none');
    expect(speech.sockets).toHaveLength(0);
    expect(host.events).toHaveLength(0);
  });

  it('the bubble shows what is heard while the sentence is spoken, then the event carries the final text', async () => {
    // one character per 200 ms frame the service has heard
    const { host, page } = await setup('听清楚了', { partial: (frames) => '听'.repeat(frames) });
    for (const fr of tone(1400, .3)) page.audio(fr);
    const live = await page.next((m) => m.t === 'listen' && m.phase === 'partial' && typeof m.interim === 'string' && m.interim.length >= 3);
    expect(live.text).toBe('');
    expect(host.events).toHaveLength(0);
    for (const fr of tone(900, 0)) page.audio(fr);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0]!.text).toBe('[voice] 伙伴:听清楚了');
    expect((await page.next((m) => m.t === 'listen' && m.phase === 'heard')).text).toBe('听清楚了');
  });

  it('without an API Key the recognizer says so, and a Key saved from the panel starts it', async () => {
    const { speech, world } = await setup('你好', { key: '', phase: 'error' });
    expect(server(world)).toMatchObject({ phase: 'error', detail: petText('zh').doubao.noKey, pid: null });
    expect(world.voiceState().doubao).toMatchObject({ keySaved: false });
    expect(speech.sockets).toHaveLength(0);
    const saved = await call(world, 'setDoubao', [{ key: 'key-1' }]) as { server: { phase: string }; doubao: { keySaved: boolean } };
    expect(saved.doubao.keySaved).toBe(true);
    expect(saved.server.phase).toBe('running');
  });

  it('ignores quiet input', async () => {
    const { speech, page, world } = await setup('x');
    for (const fr of tone(1500, .002)) page.audio(fr);
    await new Promise((r) => setTimeout(r, 400));
    expect(speech.sockets).toHaveLength(0);
    expect(counts(world).utterances).toBe(0);
  });

  it('always: the reply being read out is not heard back as the person\'s words', async () => {
    const { cfg, speech, host, page, world } = await setup('你好');
    // reading turned on: the World hands the reply to the page as it is said
    cfg.tts.enabled = true;
    for (const fr of sentence()) page.audio(fr);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    await world.tools().find((t) => t.name === 'pet_say')!.handler({ script: '我在听。' }, { role: 'main', log: host.log });
    await page.next((m) => m.t === 'speak');
    // the microphone hears the speaker too: Coo's own voice is not the person's and asks nothing
    for (const fr of sentence()) page.audio(fr);
    await new Promise((r) => setTimeout(r, 800));
    expect(speech.urls).toHaveLength(1);
    expect(host.events).toHaveLength(1);
    // nor does it cut the reading short
    expect(page.messages.some((m) => m.t === 'speak-stop')).toBe(false);
  });

  it('always: a reply the page says it played leaves the listening able to hear again', async () => {
    const { cfg, host, page, world } = await setup('你好');
    cfg.tts.enabled = true;
    for (const fr of sentence()) page.audio(fr);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    await world.tools().find((t) => t.name === 'pet_say')!.handler({ script: '我在听。' }, { role: 'main', log: host.log });
    const speak = await page.next((m) => m.t === 'speak');
    // the reply played out, or was stopped: the page is done with it either way
    page.send({ t: 'spoke', id: speak.id });
    for (const fr of sentence()) page.audio(fr);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(2);
    expect(host.events[1]!.text).toBe('[voice] 伙伴:你好');
  });

  it('always: a page gone while it was reading leaves the listening able to hear again', async () => {
    const { cfg, host, page, world } = await setup('你好');
    cfg.tts.enabled = true;
    for (const fr of sentence()) page.audio(fr);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    await world.tools().find((t) => t.name === 'pet_say')!.handler({ script: '我在听。' }, { role: 'main', log: host.log });
    await page.next((m) => m.t === 'speak');
    // the page reloads before it played the reply out: nothing will report that end
    await page.close();
    const again = await FakePage.open(world.petUrl.replace(/\/pet$/, ''));
    cleanup.push(() => again.close());
    for (const fr of sentence()) again.audio(fr);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(2);
    expect(host.events[1]!.text).toBe('[voice] 伙伴:你好');
  });
});
