/**
 * What of a reply reaches the ear. The page draws Markdown, so a reply arrives carrying markers,
 * links, emoji, tables and code — none of which is worth hearing. What leaves here is the speech
 * alone, short enough to read.
 */

export interface CleanOptions {
  /** The longest text read at all, in characters; the rest of a long reply is dropped. */
  maxChars?: number;
  /**
   * Where a bracketed aside stops being an aside. An aside is something the page shows and a voice
   * skips past; a long one usually carries the sentence's meaning, so only the brackets go.
   */
  parentheses?: number;
}

/** A reply longer than this is not read to its end; see `CleanOptions.maxChars`. */
export const MAX_CHARS = 200;
/** Where a bracketed aside stops being an aside; see `CleanOptions.parentheses`. */
export const PARENTHESES_CHARS = 100;

/** Marks a shortened reply may end after, so it does not stop in the middle of a word. */
const ENDS: ReadonlySet<string> = new Set('。！？!?；;，,、：:…— ');

/** One pass each, in order: later rules see what the earlier ones left. */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // a code block is not speech, and reading its lines would be nonsense
  [/```[\s\S]*?(?:```|$)/g, ' '],
  // a tag is markup, its text already there
  [/<\/?[a-z][^>]*>/gi, ' '],
  // an image is its address and its alt text; neither is spoken
  [/!\[[^\]]*\]\([^)]*\)/g, ' '],
  // a link is read by the words it shows
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/\[([^\]]*)\]\[[^\]]*\]/g, '$1'],
  // inline code is read by its content: `pnpm build` says pnpm build
  [/`+([^`]*)`+/g, '$1'],
  // an address read out letter by letter is noise
  [/\b(?:https?:\/\/|www\.)\S+/gi, ' '],
  // list, heading and quote markers
  [/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/gm, ''],
  [/^[ \t]*#{1,6}[ \t]*/gm, ''],
  [/^[ \t]*>[ \t]?/gm, ''],
  // a table's rule line goes whole; its bars only separate cells
  [/^[ \t]*\|?(?:[ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*:?[ \t]*$/gm, ' '],
  [/\|/g, ' '],
  // emphasis keeps the words it wraps
  [/\*\*([^*]+)\*\*/g, '$1'],
  [/\*([^*]+)\*/g, '$1'],
  [/__([^_]+)__/g, '$1'],
  // underscores inside a name are part of it, not emphasis
  [/(?<![\p{L}\p{N}])_([^_]+)_(?![\p{L}\p{N}])/gu, '$1'],
  [/~~([^~]+)~~/g, '$1'],
];

/** Bracketed groups, innermost first by repetition; every bracket pair the page may show. */
const BRACKETED = /\(([^()]*)\)|（([^（）]*)）|\[([^\[\]]*)\]|【([^【】]*)】|〔([^〔〕]*)〕/g;

function unbracket(text: string, limit: number): string {
  return text.replace(BRACKETED, (...args: unknown[]) => {
    const inner = args.slice(1, 6).map((g) => (typeof g === 'string' ? g : '')).join('');
    return Array.from(inner).length > limit ? ' ' : ` ${inner} `;
  });
}

/** `text` cut to `max` characters, at a mark when one is near the end. */
function shorten(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  let cut = max;
  for (let at = max - 1; at >= 0; at -= 1) {
    if (!ENDS.has(points[at]!)) continue;
    cut = at + 1;
    break;
  }
  return points.slice(0, cut).join('').trimEnd();
}

/** The text of `reply` as a voice says it: no markup, no emoji, no address, no code, shortened. */
export function cleanSpeech(reply: string, opts: CleanOptions = {}): string {
  let out = reply ?? '';
  for (const [rule, to] of RULES) out = out.replace(rule, to);
  out = unbracket(out, Math.max(0, opts.parentheses ?? PARENTHESES_CHARS));
  out = out.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0E\uFE0F\u200D\u20E3]/gu, '');
  // a line break between Chinese characters is layout, not speech; a space that separated two
  // pieces of the reply stays, since only the break is removed here
  out = out.replace(/(?<=[\p{Script=Han}])[ \t]*\n[ \t]*(?=[\p{Script=Han}])/gu, '');
  out = out.replace(/[ \t\u00A0]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
  return shorten(out, Math.max(0, opts.maxChars ?? MAX_CHARS));
}
