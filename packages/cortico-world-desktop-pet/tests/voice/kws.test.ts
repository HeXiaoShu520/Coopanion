/**
 * The wake word against a spotter of our own: what a keywords file is read as, which files the
 * spotter is built from, what a hit hands back, and how a cooldown and a spotter that keeps failing
 * are kept from waking the pet over and over. No model, no microphone, no network.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { petText } from '../../src/i18n/index.ts';
import {
  WakeWord, keywordLines, keywordWords, type WakeModule, type WakeSpotter, type WakeStream,
} from '../../src/voice/kws.ts';

const t = petText('zh').wake;

/** A logger that keeps what was warned about. */
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

/** The stream the spotter hands out; the samples it was fed are the test's to look at. */
class FakeStream implements WakeStream {
  readonly samples: Float32Array[] = [];
  rate = 0;
  acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void {
    this.rate = w.sampleRate;
    this.samples.push(w.samples);
  }
}

/** The spotter the World thinks it built: the test says what it hears and when it throws. */
class FakeSpotter implements WakeSpotter {
  readonly streams: FakeStream[] = [];
  /** How many decodes are owed before the spotter wants no more audio. */
  pending = 1;
  result = '';
  resets = 0;
  fail = false;
  createStream(): FakeStream {
    const stream = new FakeStream();
    this.streams.push(stream);
    return stream;
  }
  isReady(): boolean { return this.pending-- > 0; }
  decode(): void { if (this.fail) throw new Error('boom'); }
  reset(): void { this.resets++; }
  getResult(): { keyword?: string } { return this.result ? { keyword: this.result } : {}; }
}

interface Harness {
  wake: WakeWord;
  spotter: FakeSpotter;
  log: QuietLog;
  paths: Record<string, string>;
  keywordsFile: string;
  /** What the spotter was built with, as it was handed over. */
  configs: Array<Record<string, unknown>>;
}

interface Options {
  /** The keywords file's body; `null` writes an empty one. */
  words?: string | null;
  /** The one reason no model is there at all; the files are written either way. */
  missing?: string;
  /** Leave a file out of the paths the spotter is built from. */
  incomplete?: boolean;
  /** Make building the spotter throw. */
  badModel?: boolean;
  cooldownMs?: number;
}

function setup(options: Options = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'pet-kws-'));
  const keywordsFile = join(dir, 'keywords.txt');
  writeFileSync(keywordsFile, options.words === null ? '' : options.words ?? '▁小 ▁可 :2.0 #0.4 @小可\n');
  const paths: Record<string, string> = {};
  for (const role of ['encoder', 'decoder', 'joiner', 'tokens']) {
    paths[role] = join(dir, `${role}.onnx`);
    writeFileSync(paths[role]!, role);
  }
  if (options.incomplete) delete paths.tokens;
  const spotter = new FakeSpotter();
  const log = quiet();
  const configs: Array<Record<string, unknown>> = [];
  const load = (): WakeModule => ({
    KeywordSpotter: function (this: unknown, config: Record<string, unknown>) {
      configs.push(config);
      if (options.badModel) throw new Error('no such model');
      return spotter;
    } as unknown as new (config: Record<string, unknown>) => WakeSpotter,
  });
  const wake = new WakeWord({
    model: () => (options.missing ? { missing: options.missing } : { paths }),
    keywordsFile: () => keywordsFile,
    settings: () => ({ threshold: .25, cooldownMs: options.cooldownMs ?? 1000, threads: 0 }),
    log,
    load,
  });
  return { wake, spotter, log, paths, keywordsFile, configs };
}

/** One frame of silence at the rate the page records: what the spotter is fed. */
const frame = (n = 320): Int16Array => new Int16Array(n).fill(1024);

describe('a keywords file', () => {
  it('reads the words after @, with the tuning left behind', () => {
    expect(keywordWords('▁小 ▁可 :2.0 #0.4 @小可')).toBe('小可');
    expect(keywordWords('▁x ▁y :1.5 #0.3')).toBe('▁x ▁y');
  });

  it('drops blank lines and comments, and keeps one keyword a line', () => {
    expect(keywordLines('# what may wake it\n\n  ▁小 ▁可  \r\n@小可\n')).toEqual(['▁小 ▁可', '@小可']);
  });
});

describe('starting the spotter', () => {
  it('is stopped with the reason when no model is downloaded', async () => {
    const h = setup({ missing: '唤醒词模型还没有下载' });
    await h.wake.start();
    expect(h.wake.state()).toMatchObject({ phase: 'stopped', detail: '唤醒词模型还没有下载' });
    expect(h.wake.problem()).toBe('唤醒词模型还没有下载');
    expect(h.configs).toEqual([]);
  });

  it('is stopped when nothing is written to wake it', async () => {
    const h = setup({ words: null });
    await h.wake.start();
    expect(h.wake.state()).toMatchObject({ phase: 'stopped', detail: t.noWords });
  });

  it('is an error when the files it was handed are not all there', async () => {
    const h = setup({ incomplete: true });
    await h.wake.start();
    expect(h.wake.state()).toMatchObject({ phase: 'error', detail: t.incomplete });
  });

  it('is an error that says why when the model cannot be built', async () => {
    const h = setup({ badModel: true });
    await h.wake.start();
    expect(h.wake.state().phase).toBe('error');
    expect(h.wake.state().detail).toBe(t.loadFailed('no such model'));
  });

  it('listens with the person\'s own words, at 16 kHz and the threshold set', async () => {
    const h = setup();
    await h.wake.start();
    expect(h.wake.state()).toMatchObject({ phase: 'listening', detail: null, words: ['小可'] });
    expect(h.wake.problem()).toBeNull();
    expect(h.configs).toHaveLength(1);
    const config = h.configs[0]!;
    expect(config.keywordsFile).toBe(h.keywordsFile);
    expect(config.keywordsThreshold).toBe(.25);
    expect(config.featConfig).toEqual({ sampleRate: 16_000, featureDim: 80 });
    expect((config.modelConfig as { transducer: Record<string, string> }).transducer.encoder).toBe(h.paths.encoder);
    expect(h.spotter.streams).toHaveLength(1);
  });
});

describe('hearing the word', () => {
  it('hands back what was heard and starts over, once', async () => {
    const h = setup();
    await h.wake.start();
    h.spotter.result = '小可';
    expect(h.wake.feed(frame(), 1_000)).toBe('小可');
    expect(h.spotter.resets).toBe(1);
    // the same word a moment later is the same wake, not a second one
    expect(h.wake.feed(frame(), 1_100)).toBeNull();
    expect(h.wake.feed(frame(), 2_100)).toBe('小可');
    const stream = h.spotter.streams[0]!;
    expect(stream.rate).toBe(16_000);
    expect(stream.samples[0]![0]).toBeCloseTo(1024 / 32768);
  });

  it('is silent while the spotter hears nothing', async () => {
    const h = setup();
    await h.wake.start();
    expect(h.wake.feed(frame(), 1_000)).toBeNull();
    expect(h.spotter.resets).toBe(0);
  });

  it('hears nothing once it is stopped', async () => {
    const h = setup();
    await h.wake.start();
    h.wake.stop();
    h.spotter.result = '小可';
    expect(h.wake.state()).toMatchObject({ phase: 'stopped', detail: null });
    expect(h.wake.feed(frame(), 1_000)).toBeNull();
  });

  it('backs off after a spotter that keeps throwing rather than retrying every frame', async () => {
    const h = setup();
    await h.wake.start();
    // the spotter wants audio every frame, and decoding it is what fails
    h.spotter.pending = 100;
    h.spotter.fail = true;
    for (let i = 0; i < 3; i++) expect(h.wake.feed(frame(), 1_000 + i)).toBeNull();
    expect(h.wake.state().detail).toBe(t.paused);
    expect(h.log.warnings.filter((w) => w.includes('唤醒词出错'))).toHaveLength(3);
    const fed = h.spotter.streams[0]!.samples.length;
    // nothing reaches the spotter while it is resting
    expect(h.wake.feed(frame(), 2_000)).toBeNull();
    expect(h.spotter.streams[0]!.samples.length).toBe(fed);
  });
});
