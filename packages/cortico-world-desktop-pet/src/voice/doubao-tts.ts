/**
 * The Doubao streaming synthesizer: one WebSocket per piece of text, PCM at 24 kHz coming back while
 * the person may already be listening. The reply being read is kept by its bubble's id, so the pet
 * page pulls each piece by number (`GET /api/tts/audio?id=…&i=…`); `cancel()` drops the socket of
 * every piece still arriving, and that is how interrupting the bot stops the sound.
 *
 * A piece already made is played from the cache under the voice and the text, so a repeated line
 * costs nothing and sounds at once.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { petText, type PetText } from '../i18n/index.ts';
import { SpeechFrameError, TTS_RESOURCE, TTS_URL, parseTtsFrame, ttsFrame } from './protocol.ts';
import { openSocket, type SocketOpen, type SpeechSocket } from './socket.ts';

/** What synthesis reads of the settings: the speaker, and nothing else — speed and volume are the page's. */
export interface TtsConfig { voice: string }

/** Made pieces, by voice and text; the World keeps them on disk, tests in memory. */
export interface PieceCache {
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, pcm: Uint8Array): Promise<void>;
}

export interface TtsOptions {
  /** `tts` as configured now. */
  config: () => TtsConfig;
  /** The API Key; recognition uses the same one. */
  key: () => string;
  /** The directory the made pieces sit in; '' makes no cache. */
  cacheDir: () => string;
  log: Logger;
  /** The text table of the app language; Chinese when absent. */
  text?: () => PetText;
  open?: SocketOpen;
  /** Where made pieces go; the disk under `cacheDir` when absent. */
  cache?: PieceCache;
}

/** The reply being read: the bubble it belongs to, and its text in the pieces it was split into. */
interface Reading { id: string; pieces: readonly string[] }

export class DoubaoTts {
  /** The sessions still arriving, so `cancel()` can drop them all. */
  private readonly live = new Set<AbortController>();
  private reading: Reading | null = null;
  private readonly cache: PieceCache;

  constructor(private readonly opts: TtsOptions) {
    this.cache = opts.cache ?? diskCache(opts.cacheDir);
  }

  private get t(): PetText['doubao'] {
    return (this.opts.text?.() ?? petText()).doubao;
  }

  /** Why nothing can be synthesized now, or null. */
  problem(): string | null {
    return this.opts.key() ? null : this.t.noKey;
  }

  /** The reply the page may ask for; the newest replaces the one before it. */
  reply(id: string, pieces: readonly string[]): void {
    this.reading = { id, pieces };
  }

  /** How many pieces that reply has; 0 when it is not the one being read. */
  pieces(id: string): number {
    return this.reading?.id === id ? this.reading.pieces.length : 0;
  }

  /** One piece of a reply, written out as it arrives; a reason when it could not be made. */
  async speakReply(id: string, index: number, onChunk: (pcm: Uint8Array) => void, signal?: AbortSignal): Promise<string | null> {
    if (this.reading?.id !== id) return this.t.gone;
    const text = this.reading.pieces[index];
    if (text === undefined) return this.t.gone;
    return this.speak(text, onChunk, signal);
  }

  /** `text` as PCM, written out as it arrives; a reason when it could not be made. */
  async speak(text: string, onChunk: (pcm: Uint8Array) => void, signal?: AbortSignal): Promise<string | null> {
    const why = this.problem();
    if (why) return why;
    const key = this.cacheKey(text);
    const made = await this.cache.read(key);
    if (made) {
      if (!signal?.aborted) onChunk(made);
      return null;
    }
    const chunks: Uint8Array[] = [];
    const { error, complete } = await this.session(text, (pcm) => {
      chunks.push(pcm);
      onChunk(pcm);
    }, signal);
    // a piece cut short — by the person interrupting, or by the socket going before the end — is not worth keeping
    if (complete && !signal?.aborted && chunks.length) void this.cache.write(key, concat(chunks));
    return error;
  }

  /** All of `text` at once, for the panel's try-listen. */
  async preview(text: string, signal?: AbortSignal): Promise<{ pcm: Uint8Array; error: string | null }> {
    const chunks: Uint8Array[] = [];
    const error = await this.speak(text, (pcm) => chunks.push(pcm), signal);
    return { pcm: concat(chunks), error };
  }

  /** Stops every piece still arriving and forgets the reply: the person stopped listening. */
  cancel(): void {
    for (const session of this.live) session.abort();
    this.live.clear();
    this.reading = null;
  }

  /** The cache name of one text in the voice in force. */
  private cacheKey(text: string): string {
    return createHash('sha256').update(`${this.opts.config().voice}\u0000${text}`).digest('hex');
  }

  /** One session: the request goes out when the socket opens, and every audio frame is a chunk. */
  private session(text: string, onChunk: (pcm: Uint8Array) => void, outer?: AbortSignal): Promise<{ error: string | null; complete: boolean }> {
    return new Promise((done) => {
      const session = new AbortController();
      this.live.add(session);
      let finished = false;
      let failed: string | null = null;
      /** The service said the stream was over: only then is the whole piece in hand. */
      let ended = false;
      const socket = (this.opts.open ?? openSocket);
      let handle: SpeechSocket | null = null;

      const finish = (why: string | null) => {
        if (finished) return;
        finished = true;
        this.live.delete(session);
        outer?.removeEventListener('abort', interrupt);
        session.signal.removeEventListener('abort', interrupt);
        try { handle?.close(); } catch { /* already closed */ }
        done({ error: why, complete: ended && !why });
      };
      // the person interrupting is not a failure: the piece just stops arriving
      const interrupt = () => { failed = null; finish(null); };
      if (outer?.aborted) { finish(null); return; }
      outer?.addEventListener('abort', interrupt);
      // `cancel()` aborts the session itself, whatever it was doing
      session.signal.addEventListener('abort', interrupt);

      const trouble = (why: string) => { failed = why; this.opts.log.warn(`豆包朗读失败:${why}`); finish(why); };
      try {
        handle = socket(TTS_URL, this.headers(), {
          open: () => {
            if (finished) return;
            handle?.send(ttsFrame(text, { speaker: this.opts.config().voice }));
          },
          message: (data) => {
            if (finished) return;
            let frame: ReturnType<typeof parseTtsFrame>;
            try {
              frame = parseTtsFrame(data);
            } catch (err) {
              trouble(err instanceof SpeechFrameError ? err.message : (err as Error).message);
              return;
            }
            if (frame.kind === 'error') trouble(this.t.failed(frame.code, frame.message));
            else if (frame.kind === 'audio') { if (frame.payload.length) onChunk(frame.payload); }
            else if (frame.end) { ended = true; finish(null); }
          },
          error: (why) => trouble(this.t.connect(why)),
          close: () => { if (!finished) trouble(failed ?? this.t.closed); },
        });
        if (session.signal.aborted) interrupt();
      } catch (err) {
        trouble(this.t.connect((err as Error).message));
      }
    });
  }

  private headers(): Record<string, string> {
    const id = randomUUID();
    return { 'X-Api-Key': this.opts.key(), 'X-Api-Resource-Id': TTS_RESOURCE, 'X-Api-Request-Id': id, 'X-Api-Connect-Id': id, 'X-Api-Sequence': '-1' };
  }
}

/** The made pieces under `dir`, one file each; a cache that cannot be read or written is just a miss. */
function diskCache(dir: () => string): PieceCache {
  const file = (key: string) => join(dir(), `${key}.pcm`);
  return {
    async read(key) {
      if (!dir()) return null;
      try { return await readFile(file(key)); } catch { return null; }
    },
    async write(key, pcm) {
      if (!dir()) return;
      try {
        await mkdir(dir(), { recursive: true });
        await writeFile(file(key), pcm);
      } catch { /* the piece still plays; it is made again next time */ }
    },
  };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
