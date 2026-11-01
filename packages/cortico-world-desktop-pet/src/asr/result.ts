/** What a recognizer returns for one utterance, and the filter for lines that are not speech. */

export interface TranscribeResult {
  text: string;
  ms: number;
  /** null on success. */
  error: string | null;
}

/** One sentence being heard: audio goes in while it is spoken, the text comes back after `end`. */
export interface SpeechSentence {
  write(frame: Int16Array): void;
  end(): Promise<TranscribeResult>;
}

/**
 * Lines a service writes for audio without speech: on noise they come back as stock phrases from
 * their training subtitles, and some label sounds in brackets, parentheses or asterisks
 * (`[Música]`, `(звук пива)`, `*Bruit de la porte*`), sometimes cut off before the closing mark.
 * Their content cannot be told apart from real speech, so they are blocked by list; letting one
 * through means an event claims a sentence nobody said. Words a person also says
 * (订阅, 转发, 字幕, 谢谢观看) block a line only in the credits' own phrasing or as the whole
 * line, so a sentence that mentions them reaches the bot.
 */
const HALLUCINATION_PATTERNS: readonly RegExp[] = [
  /^[\s。.,、!?!?…~-]*$/,
  /请不吝点赞|明镜与点点栏目|字幕(?:由|志愿者|组|制作|提供|翻译|by|[:：])/i,
  /^[\s\p{P}]*谢谢观看[\s\p{P}]*$/u,
  /^(?:[\s\p{P}]*(?:点赞|订阅|转发|打赏)){2,}[\s\p{P}]*$/u,
  /^(thank you|thanks for watching|subtitles by|you)[\s.!]*$/i,
  /^\s*(sous-titr|untertitel|subt[ií]tulos|legendas|sottotitoli|субтитр)/i,
  /^\s*[[(（【*♪]/,
];

/** Written without spaces between words. */
const UNSPACED_END = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u;
const UNSPACED_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Sentences heard one after another: a space before one that starts with a letter or digit after
 * a letter, digit or ASCII punctuation, unless either side is Chinese or Japanese.
 */
export function joinSpeech(pieces: readonly string[]): string {
  let out = '';
  for (const p of pieces) {
    if (!p) continue;
    const spaced = /[\p{L}\p{N}.,!?;:]$/u.test(out) && !UNSPACED_END.test(out) && /^[\p{L}\p{N}]/u.test(p) && !UNSPACED_START.test(p);
    out += spaced ? ` ${p}` : p;
  }
  return out;
}

export function looksHallucinated(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return HALLUCINATION_PATTERNS.some((re) => re.test(t));
}
