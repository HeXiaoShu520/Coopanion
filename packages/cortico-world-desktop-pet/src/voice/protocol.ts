/**
 * Binary frames of the Doubao speech services (Volcengine v3): streaming recognition over SAUC, and
 * streaming synthesis. Both are WebSocket connections carrying length-prefixed frames; this module is
 * the whole wire format, so it can be read and tested without a socket.
 *
 * Every frame starts with four header bytes: version and header size in the first, message type in
 * the high nibble of the second, flags in its low nibble, serialization and compression in the
 * third. What follows depends on the message:
 *
 * - client full request: a four-byte payload size, then the payload;
 * - client audio: the same; a final frame carries no sequence (flags 2) or a negative one (flags 3);
 * - server response: an optional four-byte sequence when the flags say so, then the payload size and
 *   the payload; a session id precedes the size under flags 4 (synthesis only);
 * - error: a four-byte code, the message size, then the message as UTF-8.
 *
 * Recognition payloads are JSON, gzip-compressed both ways. Synthesis asks for raw PCM at 24 kHz in
 * mono 16-bit, and answers with audio frames until an empty JSON object ends the stream.
 */
import { gunzipSync, gzipSync } from 'fflate';

/** Endpoints and resource ids, as the services document them. */
export const SAUC_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
export const SAUC_RESOURCE = 'volc.seedasr.sauc.duration';
export const TTS_URL = 'wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream';
export const TTS_RESOURCE = 'seed-tts-2.0';
/** The rate synthesis returns; playback resamples nothing. */
export const TTS_SAMPLE_RATE = 24000;
/** The rate recognition takes, the same the pet page records at. */
export const ASR_SAMPLE_RATE = 16000;

const FULL_CLIENT = 0x1;
const AUDIO_ONLY = 0x2;
const SERVER_RESPONSE = 0x9;
const ERROR = 0xF;
const TTS_AUDIO = 0xB;
const SER_RAW = 0x0;
const SER_JSON = 0x1;
const COMP_NONE = 0x0;
const COMP_GZIP = 0x1;
const FLAG_NONE = 0x0;
const FLAG_POS_SEQUENCE = 0x1;
const FLAG_LAST = 0x2;
const FLAG_LAST_NEG_SEQUENCE = 0x3;
const FLAG_SESSION = 0x4;

export class SpeechFrameError extends Error {}

function header(type: number, flags: number, serialization: number, compression: number): Uint8Array {
  return Uint8Array.of(0x11, (type << 4) | flags, (serialization << 4) | compression, 0);
}

/** `bytes` of `value` as a big-endian unsigned 32-bit integer, at `at`. */
function putU32(out: Uint8Array, at: number, value: number): void {
  new DataView(out.buffer).setUint32(at, value, false);
}

function putI32(out: Uint8Array, at: number, value: number): void {
  new DataView(out.buffer).setInt32(at, value, false);
}

function u32(data: Uint8Array, at: number, what: string): number {
  if (at + 4 > data.length) throw new SpeechFrameError(`frame ends before ${what}`);
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at, false);
}

function i32(data: Uint8Array, at: number, what: string): number {
  if (at + 4 > data.length) throw new SpeechFrameError(`frame ends before ${what}`);
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(at, false);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function json(data: Uint8Array): Record<string, unknown> {
  if (!data.length) return {};
  const parsed: unknown = JSON.parse(new TextDecoder().decode(data));
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
}

/** A frame with a payload: the four header bytes, an optional sequence, the size, the payload. */
function frame(type: number, flags: number, serialization: number, compression: number, payload: Uint8Array, sequence?: number): Uint8Array {
  const head = header(type, flags, serialization, compression);
  const seq = sequence === undefined ? new Uint8Array(0) : new Uint8Array(4);
  if (sequence !== undefined) putI32(seq, 0, sequence);
  const size = new Uint8Array(4);
  putU32(size, 0, payload.length);
  return concat([head, seq, size, payload]);
}

/** What the recognition session asks for when it opens. */
export interface StartOptions {
  /** Opaque client name the service records; the app's own id. */
  uid: string;
  /** ISO 639-1 with a region when it has one, such as `zh-CN`; empty leaves detection to the model. */
  language?: string;
  /** Audio rate; 16000 unless a test says otherwise. */
  rate?: number;
  /** Words and phrases to favour, sent as the service's `context` hotwords. */
  hotwords?: readonly string[];
}

/** The first frame of a recognition session: format, model and what to return. */
export function startFrame(opts: StartOptions): Uint8Array {
  const body = {
    user: { uid: opts.uid },
    audio: {
      format: 'pcm', codec: 'raw', rate: opts.rate ?? ASR_SAMPLE_RATE, bits: 16, channel: 1,
      ...opts.language ? { language: opts.language } : {},
    },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: false,
      enable_nonstream: true,
      show_utterances: true,
      result_type: 'full',
      // how long a silence ends the sentence: the pet's own segmenter already cuts by loudness
      end_window_size: 800,
      force_to_speech_time: 800,
      ...opts.hotwords?.length ? { context: JSON.stringify({ hotwords: opts.hotwords.map((word) => ({ word })) }) } : {},
    },
  };
  return frame(FULL_CLIENT, FLAG_NONE, SER_JSON, COMP_GZIP, gzipSync(jsonBytes(body)));
}

/**
 * One slice of microphone audio, 16 kHz mono PCM16. `final` closes the session's input: the service
 * then sends the last utterances. `sequence` numbers the frames in order when the caller keeps one;
 * a final frame carries the negative of the next number, as the service expects.
 */
export function audioFrame(pcm: Uint8Array, opts: { final?: boolean; sequence?: number } = {}): Uint8Array {
  const flags = opts.final ? (opts.sequence === undefined ? FLAG_LAST : FLAG_LAST_NEG_SEQUENCE) : opts.sequence === undefined ? FLAG_NONE : FLAG_POS_SEQUENCE;
  return frame(AUDIO_ONLY, flags, SER_RAW, COMP_GZIP, gzipSync(pcm), opts.sequence);
}

export type AsrFrame =
  | { kind: 'json'; payload: Record<string, unknown>; sequence: number | null; last: boolean }
  | { kind: 'error'; code: number; message: string };

/** One frame the recognition service sent back. */
export function parseAsrFrame(data: Uint8Array): AsrFrame {
  if (data.length < 4) throw new SpeechFrameError('frame shorter than its header');
  const type = data[1]! >> 4;
  const flags = data[1]! & 0x0f;
  const serialization = data[2]! >> 4;
  const compression = data[2]! & 0x0f;
  let at = (data[0]! & 0x0f) * 4;
  if (type === ERROR) {
    const code = u32(data, at, 'error code');
    const size = u32(data, at + 4, 'error size');
    const message = data.subarray(at + 8, at + 8 + size);
    return { kind: 'error', code, message: new TextDecoder().decode(message) };
  }
  if (type !== SERVER_RESPONSE) throw new SpeechFrameError(`unexpected message type ${type}`);
  const sequence = flags === FLAG_POS_SEQUENCE || flags === FLAG_LAST_NEG_SEQUENCE ? i32(data, at, 'sequence') : null;
  if (sequence !== null) at += 4;
  const size = u32(data, at, 'payload size');
  at += 4;
  const payload = data.subarray(at, at + size);
  const last = flags === FLAG_LAST || flags === FLAG_LAST_NEG_SEQUENCE;
  const plain = compression === COMP_GZIP && payload.length ? gunzipSync(payload) : payload;
  if (serialization !== SER_JSON) throw new SpeechFrameError(`unexpected serialization ${serialization}`);
  return { kind: 'json', payload: json(plain), sequence, last };
}

/** What one recognition response says: the text so far, and the utterances it has settled. */
export interface AsrReading {
  /** The session's text so far, unfinished included; empty when the frame carried none. */
  partial: string;
  /** Utterances that closed in this frame, each once: the service repeats them in later frames. */
  finals: string[];
  /** The service has nothing more to say; the input was closed. */
  last: boolean;
}

/**
 * Reads a response and dedupes its settled utterances. The service repeats an utterance in every
 * later frame of the session, so each is taken once, keyed by its place in the audio.
 */
export class AsrReader {
  private readonly taken = new Set<string>();

  read(payload: Record<string, unknown>, last: boolean): AsrReading {
    const result = (payload.result ?? {}) as Record<string, unknown>;
    const partial = typeof result.text === 'string' ? result.text : '';
    const finals: string[] = [];
    const utterances = Array.isArray(result.utterances) ? result.utterances as Array<Record<string, unknown>> : [];
    utterances.forEach((u, at) => {
      if (u.definite !== true) return;
      const text = typeof u.text === 'string' ? u.text.trim() : '';
      if (!text) return;
      const key = `${u.start_time ?? ''}:${u.end_time ?? ''}:${at}`;
      if (this.taken.has(key)) return;
      this.taken.add(key);
      finals.push(text);
    });
    return { partial, finals, last };
  }
}

export type TtsFrame =
  | { kind: 'audio'; payload: Uint8Array }
  /** `end: true` when the service closed the stream with an empty object. */
  | { kind: 'json'; payload: Record<string, unknown>; end: boolean }
  | { kind: 'error'; code: number; message: string };

/** The synthesis request for one piece of cleaned text. */
export function ttsFrame(text: string, opts: { speaker: string; sampleRate?: number }): Uint8Array {
  const body = {
    req_params: {
      text,
      speaker: opts.speaker,
      audio_params: { format: 'pcm', sample_rate: opts.sampleRate ?? TTS_SAMPLE_RATE },
      // the text is already cleaned here; the service must not rewrite or drop parts of it
      additions: JSON.stringify({
        disable_markdown_filter: true,
        disable_emoji_filter: true,
        max_length_to_filter_parenthesis: 100,
      }),
    },
  };
  return frame(FULL_CLIENT, FLAG_NONE, SER_JSON, COMP_NONE, jsonBytes(body));
}

/** One frame the synthesis service sent back. */
export function parseTtsFrame(data: Uint8Array): TtsFrame {
  if (data.length < 4) throw new SpeechFrameError('frame shorter than its header');
  const type = data[1]! >> 4;
  const flags = data[1]! & 0x0f;
  const serialization = data[2]! >> 4;
  let at = (data[0]! & 0x0f) * 4;
  if (type === ERROR) {
    const code = u32(data, at, 'error code');
    const size = u32(data, at + 4, 'error size');
    return { kind: 'error', code, message: new TextDecoder().decode(data.subarray(at + 8, at + 8 + size)) };
  }
  // a sequence (flags 1 and 3, skipped) and the session id (flags 4) both sit before the payload
  if (flags === FLAG_POS_SEQUENCE || flags === FLAG_LAST_NEG_SEQUENCE) at += 4;
  if (flags === FLAG_SESSION) {
    at += 4;
    const sessionSize = u32(data, at, 'session id size');
    at += 4 + sessionSize;
  }
  const size = u32(data, at, 'payload size');
  at += 4;
  const payload = data.subarray(at, at + size);
  if (type === TTS_AUDIO) return { kind: 'audio', payload };
  const body = serialization === SER_JSON ? json(payload) : {};
  return { kind: 'json', payload: body, end: Object.keys(body).length === 0 };
}
