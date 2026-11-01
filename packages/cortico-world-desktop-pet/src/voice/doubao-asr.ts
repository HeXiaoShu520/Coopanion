/**
 * The Doubao streaming recognizer: one WebSocket session per sentence. Audio goes out as it is
 * heard, so the words arrive while the person is still speaking, and the last frame closes the
 * input; what the service settles is joined into the result.
 *
 * A session that cannot connect, or that the service answers with an error, puts the engine in
 * `error` with the reason: nothing more is sent until it is started again, which a change of
 * address or an API Key saved from the panel also does.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from 'cortico/core/types.ts';
import { joinSpeech, type SpeechSentence, type TranscribeResult } from '../asr/result.ts';
import { petText, type PetText } from '../i18n/index.ts';
import { ASR_SAMPLE_RATE, AsrReader, SAUC_RESOURCE, SAUC_URL, SpeechFrameError, audioFrame, parseAsrFrame, startFrame } from './protocol.ts';
import { openSocket, type SocketOpen, type SpeechSocket } from './socket.ts';

export type DoubaoPhase = 'stopped' | 'running' | 'error';

export interface DoubaoState {
  phase: DoubaoPhase;
  /** The address sessions go to; empty never happens, the official one stands in. */
  url: string;
  pid: null;
  detail: string | null;
}

/** One sentence, as the segmenter hands its audio over. */
export interface SessionOpen {
  /** The address the session connects to. */
  url: string;
  headers: Record<string, string>;
  language: string;
  uid: string;
  /** How long the last utterances may take once the input is closed. */
  waitMs: number;
  text: PetText['doubao'];
  log: Logger;
  /** Called when the failure is one the engine cannot recover from. */
  fatal(why: string): void;
}

export interface DoubaoAsrOptions {
  /** `asr.doubao` as configured now. */
  config: () => { baseUrl: string };
  /** The API Key; the same one synthesis uses. */
  key: () => string;
  /** ISO 639-1 with a region when it has one, such as `zh-CN`. */
  language: () => string;
  /** The name the service records with the requests: the app's. */
  uid: () => string;
  /** How long the last utterances may take once the input is closed. */
  timeoutMs: () => number;
  log: Logger;
  /** The text table of the app language; Chinese when absent. */
  text?: () => PetText;
  open?: SocketOpen;
}

/** How much audio one frame carries: 200 ms, as the service documents. */
const CHUNK_SAMPLES = (ASR_SAMPLE_RATE * 200) / 1000;
/** A frame smaller than this waits for the next one; more of them is wasted overhead. */
const CHUNK_BYTES = CHUNK_SAMPLES * 2;

export class DoubaoAsr {
  private phase: DoubaoPhase = 'stopped';
  private detail: string | null = null;
  /** The address the engine was last started with. */
  private started = '';

  constructor(private readonly opts: DoubaoAsrOptions) {}

  private get t(): PetText['doubao'] {
    return (this.opts.text?.() ?? petText()).doubao;
  }

  private url(): string {
    return this.opts.config().baseUrl.trim() || SAUC_URL;
  }

  state(): DoubaoState {
    return { phase: this.phase, url: this.url(), pid: null, detail: this.detail };
  }

  /** The address changed since the engine was started. Polled with the config, so the key, whose read can open `.env`, is not compared. */
  get configChanged(): boolean {
    return this.started !== this.opts.config().baseUrl.trim();
  }

  /** Takes the configured address and key, or says why they cannot be used; nothing is sent yet. */
  async start(): Promise<void> {
    this.started = this.opts.config().baseUrl.trim();
    const why = this.problem();
    this.phase = why ? 'error' : 'running';
    this.detail = why;
    if (why) this.opts.log.warn(`豆包识别没有启动:${why}`);
  }

  private problem(): string | null {
    const raw = this.opts.config().baseUrl.trim();
    if (raw) {
      let url: URL;
      try { url = new URL(raw); } catch { return this.t.badUrl(raw); }
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return this.t.badUrl(raw);
    }
    return this.opts.key() ? null : this.t.noKey;
  }

  async stop(): Promise<void> {
    this.phase = 'stopped';
    this.detail = null;
  }

  private headers(): Record<string, string> {
    // recognition and synthesis share one key, and the service takes one id for both headers
    const id = randomUUID();
    return { 'X-Api-Key': this.opts.key(), 'X-Api-Resource-Id': SAUC_RESOURCE, 'X-Api-Request-Id': id, 'X-Api-Connect-Id': id, 'X-Api-Sequence': '-1' };
  }

  /** A session for the sentence being heard now, or null when the engine is not running. */
  sentence(onPartial: (text: string) => void = () => {}): SpeechSentence | null {
    if (this.phase !== 'running') return null;
    return new DoubaoSession({
      url: this.url(),
      headers: this.headers(),
      language: languageTag(this.opts.language()),
      uid: this.opts.uid(),
      waitMs: this.opts.timeoutMs(),
      text: this.t,
      log: this.opts.log,
      fatal: (why) => {
        this.phase = 'error';
        this.detail = why;
      },
    }, onPartial, this.opts.open ?? openSocket);
  }

  /** One finished sentence to text, for the path that already holds the whole sentence. */
  async transcribe(pcm: Int16Array): Promise<TranscribeResult> {
    const session = this.sentence();
    if (!session) return { text: '', ms: 0, error: this.detail ?? this.t.notRunning };
    for (let at = 0; at < pcm.length; at += CHUNK_SAMPLES) session.write(pcm.subarray(at, at + CHUNK_SAMPLES));
    return session.end();
  }
}

/** `zh` as `zh-CN`: the service reads a bare code as the language its model guesses from. */
function languageTag(language: string): string {
  if (!/^[a-z]{2}$/i.test(language)) return language;
  return { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR' }[language.toLowerCase()] ?? language;
}

/**
 * One sentence on its own socket. Audio written before the connection opens is held, so the first
 * frames of a sentence are not lost; the start request goes out first, then those frames.
 */
class DoubaoSession implements SpeechSentence {
  private readonly reader = new AsrReader();
  private socket: SpeechSocket | null = null;
  private ready = false;
  /** Frames written before the socket opened, sent in order once it does. */
  private readonly waiting: Uint8Array[] = [];
  /** Bytes of the frame being filled. */
  private pending = new Uint8Array(0);
  private sequence = 0;
  private readonly finals: string[] = [];
  private failure: string | null = null;
  private settled = false;
  private wake: (() => void) | null = null;

  constructor(
    private readonly s: SessionOpen,
    private readonly onPartial: (text: string) => void,
    open: SocketOpen,
  ) {
    try {
      this.socket = open(s.url, s.headers, {
        open: () => this.onOpen(),
        message: (data) => this.onMessage(data),
        error: (why) => this.fail(s.text.connect(why)),
        close: () => this.onClose(),
      });
    } catch (err) {
      this.fail(s.text.connect((err as Error).message));
    }
  }

  write(frame: Int16Array): void {
    if (this.failure) return;
    const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    const joined = new Uint8Array(this.pending.length + bytes.length);
    joined.set(this.pending, 0);
    joined.set(bytes, this.pending.length);
    this.pending = joined;
    while (this.pending.length >= CHUNK_BYTES) {
      this.send(audioFrame(this.pending.subarray(0, CHUNK_BYTES)));
      this.pending = this.pending.slice(CHUNK_BYTES);
    }
  }

  async end(): Promise<TranscribeResult> {
    const started = Date.now();
    // the rest of the sentence, marked final: the service then settles its last utterances
    if (!this.failure) {
      this.send(audioFrame(this.pending, { final: true }));
      this.pending = new Uint8Array(0);
      await this.waitSettled();
    }
    this.close();
    const text = joinSpeech(this.finals);
    if (this.failure) return { text: '', ms: Date.now() - started, error: this.failure };
    if (!text) return { text: '', ms: Date.now() - started, error: this.s.text.noText };
    return { text, ms: Date.now() - started, error: null };
  }

  private onOpen(): void {
    this.ready = true;
    this.send(startFrame({ uid: this.s.uid, language: this.s.language, rate: ASR_SAMPLE_RATE }));
    for (const frame of this.waiting.splice(0)) this.socket?.send(frame);
  }

  private send(frame: Uint8Array): void {
    if (!this.ready) { this.waiting.push(frame); return; }
    this.socket?.send(frame);
  }

  private onMessage(data: Uint8Array): void {
    if (this.failure) return;
    let frame: ReturnType<typeof parseAsrFrame>;
    try {
      frame = parseAsrFrame(data);
    } catch (err) {
      this.fail(this.s.text.badFrame(err instanceof SpeechFrameError ? err.message : (err as Error).message));
      return;
    }
    if (frame.kind === 'error') { this.fail(this.s.text.failed(frame.code, frame.message), true); return; }
    const reading = this.reader.read(frame.payload, frame.last);
    this.finals.push(...reading.finals);
    if (reading.partial) this.onPartial(reading.partial);
    if (frame.last) this.settle();
  }

  /**
   * One failure. A session that never opened, or that the service answered with an error, stops
   * the engine; the rest — a hang-up mid-sentence, a frame that cannot be read — fail it alone.
   */
  private fail(why: string, fatal = false): void {
    if (this.failure) return;
    this.failure = why;
    this.s.log.warn(`豆包识别失败:${why}`);
    if (fatal || !this.ready) this.s.fatal(why);
    this.settle();
  }

  /** The service closed the socket: the session is over, whether or not it settled its text. */
  private onClose(): void {
    if (!this.failure && !this.settled) {
      this.failure = this.s.text.closed;
      if (!this.ready) this.s.fatal(this.failure);
    }
    this.settle();
  }

  private settle(): void {
    this.settled = true;
    this.wake?.();
    this.wake = null;
  }

  private waitSettled(): Promise<void> {
    if (this.settled) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, this.s.waitMs);
      this.wake = () => { clearTimeout(timer); resolve(); };
    });
  }

  private close(): void {
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    try { socket?.close(); } catch { /* already closed */ }
  }
}
