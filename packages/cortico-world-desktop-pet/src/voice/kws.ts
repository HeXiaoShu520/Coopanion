/**
 * The wake word: sherpa-onnx's `KeywordSpotter` run over the microphone frames the page already
 * sends, so the pet can be called without reaching for the talk key. The model is small (a few MB)
 * and comes from the runtime store like the recognition models; nothing here touches the network.
 *
 * A keyword is heard, not recognized: the spotter answers with the line it matched, and the caller
 * decides what to do with it. `feed()` hands back the line when one is found and the cooldown after
 * the last one has run out — so one wake is never answered twice, and a person who says the word
 * again a moment later is not heard twice either.
 *
 * The lines come from the person, in the spotter's own syntax: `tokens :score #threshold @what it
 * shows`, one a line, exactly as the model's `keywords.txt` is written. Deriving them from plain
 * words is the model's vocabulary's business, not ours, so the World only stores and hands them over.
 *
 * A spotter that throws is backed off rather than retried every frame: a broken model would
 * otherwise raise several times a second for as long as the microphone is open.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import type { Logger } from 'cortico/core/types.ts';
import { petText, type PetText } from '../i18n/index.ts';

/** The rate the page records at; the spotter is built for it. */
const SAMPLE_RATE = 16_000;
/** The files a transducer spotter loads, by role. */
const ROLES = ['encoder', 'decoder', 'joiner', 'tokens'] as const;
/** Frames that may raise before the spotter is left alone for a while. */
const FAILURES_BEFORE_BACKOFF = 3;
const BACKOFF_MS = 30_000;

/** The part of sherpa-onnx's keyword spotter used here; tests pass a fake. */
export interface WakeStream {
  acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void;
}
export interface WakeSpotter {
  createStream(): WakeStream;
  isReady(stream: WakeStream): boolean;
  decode(stream: WakeStream): void;
  reset(stream: WakeStream): void;
  getResult(stream: WakeStream): { keyword?: string } | string;
}
export interface WakeModule {
  KeywordSpotter: new (config: Record<string, unknown>) => WakeSpotter;
}

export function loadWake(): WakeModule {
  return createRequire(import.meta.url)('sherpa-onnx-node') as WakeModule;
}

export interface WakeSettings {
  /** How sure the spotter must be, 0–1. */
  threshold: number;
  /** Milliseconds after one wake during which the next is ignored. */
  cooldownMs: number;
  /** CPU threads for the spotter; 0 picks two. */
  threads: number;
}

export interface WakeWordOptions {
  /** The model files by role (`encoder`, `decoder`, `joiner`, `tokens`), or why they are not there. */
  model: () => { paths: Readonly<Record<string, string>> } | { missing: string };
  /** The keywords file, written by the World before the spotter is built; empty when nothing may wake the pet. */
  keywordsFile: () => string;
  settings: () => WakeSettings;
  log: Logger;
  /** The text table of the app language; Chinese when absent. */
  text?: () => PetText;
  load?: () => WakeModule;
}

export type WakePhase = 'stopped' | 'listening' | 'error';

export interface WakeState {
  phase: WakePhase;
  /** Why it is not listening, when it is not. */
  detail: string | null;
  /** What may wake the pet, as the person wrote it. */
  words: string[];
}

/** One line of a keywords file without its tuning: the words themselves, and what they show. */
export function keywordWords(line: string): string {
  // `tokens :boost #threshold @what it shows`: the `@` part is the words, once the person wrote one
  const at = line.lastIndexOf('@');
  if (at >= 0) return line.slice(at + 1).trim();
  return keywordHead(line);
}

/** The tokens a line is heard as, which the model's own table has to have. */
export function keywordTokens(line: string): string[] {
  const head = keywordHead(line);
  return head ? head.split(/\s+/) : [];
}

/** The `tokens :boost #threshold` part of a line: what is left once what it shows is taken off. */
function keywordHead(line: string): string {
  const at = line.lastIndexOf('@');
  const tokens = at >= 0 ? line.slice(0, at) : line;
  return tokens.split('#')[0]!.replace(/:\s*[-\d.]+\s*$/, '').trim();
}

/** The lines a keywords file is made of: one a line, blank lines and `#` comments left out. */
export function keywordLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

export class WakeWord {
  private spotter: WakeSpotter | null = null;
  private stream: WakeStream | null = null;
  private phase: WakePhase = 'stopped';
  private detail: string | null = null;
  /** The words the running spotter was built for: a frame asks for them fifty times a second, so the file is read once at start. */
  private currentWords: string[] = [];
  private starting: Promise<void> | null = null;
  private failures = 0;
  private backoffUntil = 0;
  private lastWake = 0;

  constructor(private readonly opts: WakeWordOptions) {}

  private get t(): PetText['wake'] {
    return (this.opts.text?.() ?? petText()).wake;
  }

  state(): WakeState {
    return { phase: this.phase, detail: this.detail, words: this.words() };
  }

  /** The words that may wake the pet: those the spotter was built from, still readable after it stopped. */
  words(): string[] {
    return this.currentWords;
  }

  /** The keyword lines the spotter is built from, as they stand on disk now. */
  private lines(): string[] {
    const file = this.opts.keywordsFile();
    try {
      return existsSync(file) ? keywordLines(readFileSync(file, 'utf8')) : [];
    } catch {
      return [];
    }
  }

  /**
   * The tokens a keyword needs that the model's table does not have. sherpa-onnx ends the process when
   * a keyword cannot be encoded, so a word written in characters where the model wants its own tokens
   * is refused here, while there is still a process to say why.
   */
  private unknownTokens(table: string): string[] {
    let vocab: Set<string>;
    try {
      // `<token> <id>` a line; the id is the spotter's business, the first column is the word
      vocab = new Set(readFileSync(table, 'utf8').split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]!).filter(Boolean));
    } catch {
      // an unreadable table is the spotter's own failure to report, not this check's
      return [];
    }
    const missing: string[] = [];
    for (const line of this.lines()) for (const token of keywordTokens(line)) if (!vocab.has(token)) missing.push(token);
    return missing;
  }

  /** Why nothing can be heard now, or null: no file at all, or the spotter failed. */
  problem(): string | null {
    if (this.phase === 'error') return this.detail;
    if (this.phase === 'stopped') return this.detail ?? this.t.notListening;
    return null;
  }

  /** Loads the spotter for the keywords written now; a model or file that is not there is not a failure. */
  start(): Promise<void> {
    this.starting ??= this.doStart().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    this.release();
    this.failures = 0;
    this.backoffUntil = 0;
    // the words on disk now are the ones this start is for
    this.currentWords = this.lines().map(keywordWords);
    const files = this.opts.model();
    if ('missing' in files) { this.phase = 'stopped'; this.detail = files.missing; return; }
    if (!this.currentWords.length) { this.phase = 'stopped'; this.detail = this.t.noWords; return; }
    // the store leaves out a role whose file is missing: the spotter needs every one of them
    if (!ROLES.every((role) => { const file = files.paths[role]; return !!file && existsSync(file); })) { this.phase = 'error'; this.detail = this.t.incomplete; return; }
    const unknown = this.unknownTokens(files.paths.tokens!);
    if (unknown.length) {
      this.phase = 'error';
      this.detail = this.t.unknownTokens([...new Set(unknown)].slice(0, 4).join(' '));
      return;
    }
    try {
      const wake = (this.opts.load ?? loadWake)();
      const settings = this.opts.settings();
      this.spotter = new wake.KeywordSpotter({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: files.paths.encoder, decoder: files.paths.decoder, joiner: files.paths.joiner },
          tokens: files.paths.tokens,
          numThreads: settings.threads > 0 ? settings.threads : 2,
          provider: 'cpu',
          debug: 0,
        },
        keywordsFile: this.opts.keywordsFile(),
        keywordsThreshold: settings.threshold,
        numTrailingBlanks: 2,
        maxActivePaths: 4,
      });
      this.stream = this.spotter.createStream();
      this.phase = 'listening';
      this.detail = null;
    } catch (err) {
      this.spotter = null;
      this.stream = null;
      this.phase = 'error';
      this.detail = this.t.loadFailed((err as Error).message);
    }
  }

  /** Stops listening and lets go of the spotter. */
  stop(): void {
    this.release();
    this.phase = 'stopped';
    this.detail = null;
  }

  private release(): void {
    this.spotter = null;
    this.stream = null;
  }

  /** Starts over: the audio before this moment is not heard again. */
  reset(): void {
    const spotter = this.spotter, stream = this.stream;
    if (!spotter || !stream) return;
    try { spotter.reset(stream); } catch { /* the next frame starts a fresh stream anyway */ }
    this.lastWake = 0;
  }

  /**
   * One frame of microphone audio; the keyword line it completed, or null. `now` is the test's clock.
   */
  feed(frame: Int16Array, now = Date.now()): string | null {
    const spotter = this.spotter, stream = this.stream;
    if (!spotter || !stream || frame.length === 0) return null;
    if (now - this.lastWake < this.opts.settings().cooldownMs) return null;
    if (now < this.backoffUntil) return null;
    try {
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: toFloat(frame) });
      // the spotter asks for a decode each time it has enough audio; a frame may hold more than one
      for (let guard = 0; guard < 8 && spotter.isReady(stream); guard++) spotter.decode(stream);
      const result = spotter.getResult(stream);
      const keyword = (typeof result === 'string' ? result : result.keyword ?? '').trim();
      if (!keyword) return null;
      spotter.reset(stream);
      this.lastWake = now;
      this.failures = 0;
      return keyword;
    } catch (err) {
      this.failures++;
      this.opts.log.warn(`唤醒词出错:${(err as Error).message}`);
      if (this.failures >= FAILURES_BEFORE_BACKOFF) {
        this.backoffUntil = now + BACKOFF_MS;
        this.failures = 0;
        this.detail = this.t.paused;
        this.opts.log.warn(`唤醒词暂停 ${BACKOFF_MS / 1000} 秒`);
      }
      return null;
    }
  }
}

const toFloat = (pcm: Int16Array): Float32Array => {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
  return out;
};
