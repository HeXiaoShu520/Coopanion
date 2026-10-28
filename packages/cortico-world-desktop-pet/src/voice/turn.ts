/**
 * Which answers are read aloud, and when reading stops. A turn starts at the microphone: what Coo
 * answers to words it heard is read, what answers typed words is not. Speaking again, typing, or
 * cutting Coo short stops the sound at once — a pet that talks over the person is worse than a
 * silent one.
 *
 * This decides; it does not synthesize. The pieces it hands over go to `DoubaoTts`, and playback
 * happens in the page, which reports back when the last piece of a bubble is done.
 */
import { cleanSpeech, MAX_CHARS, type CleanOptions } from './clean.ts';
import { splitSpeech, type SplitOptions } from './split.ts';

export interface VoicedReply {
  /** The bubble the words appear in; playback of exactly these pieces carries the same id. */
  id: string;
  /** The text, cleaned and cut into the pieces one request reads. Never empty. */
  pieces: readonly string[];
}

export interface TurnOut {
  /** Read `pieces` in order, under the bubble's id. */
  speak(reply: VoicedReply): void;
  /** Stop the sound now and drop everything still queued. */
  stop(): void;
}

export interface TurnOptions extends CleanOptions, SplitOptions {
  /** Reading aloud is switched off: nothing is ever handed to playback. */
  off?: () => boolean;
  /** Clean the text before reading it (Markdown, code, links, emoji); on unless the person turned it off. */
  clean?: boolean;
}

export class VoiceTurn {
  private fromMicrophone = false;
  private reading: string | null = null;
  /** Pieces of this turn already handed over: Coo repeating a line does not synthesize it twice. */
  private readonly said = new Set<string>();

  constructor(private readonly out: TurnOut, private readonly opts: TurnOptions = {}) {}

  /** The person's words came from the microphone: this turn's answers are read. */
  heard(): void {
    this.interrupt();
    this.fromMicrophone = true;
    this.said.clear();
  }

  /** The person typed: nothing in this turn is read, and whatever was playing stops. */
  typed(): void {
    this.interrupt();
    this.fromMicrophone = false;
  }

  /** Coo answers in the bubble `id`; a silent turn and a switched-off voice hand over nothing. */
  reply(id: string, text: string): void {
    if (!this.fromMicrophone || this.opts.off?.()) return;
    const speech = this.opts.clean === false
      ? Array.from(text.trim()).slice(0, Math.max(0, this.opts.maxChars ?? MAX_CHARS)).join('')
      : cleanSpeech(text, this.opts);
    if (!speech) return;
    const pieces = splitSpeech(speech, this.opts).filter((piece) => !this.said.has(piece));
    if (!pieces.length) return;
    for (const piece of pieces) this.said.add(piece);
    this.reading = id;
    this.out.speak({ id, pieces });
  }

  /**
   * The page played the last piece of `id`. Playback of what Coo says next is unaffected: one turn
   * may be several bubbles.
   */
  finished(id: string): void {
    if (this.reading === id) this.reading = null;
  }

  /**
   * The bot's turn ended. What already plays is left to finish; the next words typed or heard decide
   * whether the one after is read.
   */
  end(): void {
    this.fromMicrophone = false;
    this.said.clear();
  }

  /** Stop the sound now — the person spoke again, typed, or cut Coo short. */
  interrupt(): void {
    const busy = this.reading !== null;
    this.reading = null;
    this.said.clear();
    if (busy) this.out.stop();
  }

  /** This turn came from the microphone. */
  get voice(): boolean {
    return this.fromMicrophone;
  }

  /** The bubble whose words are being read, if any. */
  get readingId(): string | null {
    return this.reading;
  }
}
