/**
 * Cutting a reply into the pieces synthesis reads one after another. The first piece is kept short
 * so the pet starts speaking after a short request instead of after the whole paragraph; the pieces
 * after it are longer, which keeps the number of requests down. A mark in the text decides where a
 * piece ends, and a piece with no mark in reach is cut at its limit.
 */
import { joinSpeech } from '../asr/result.ts';

/** Marks a piece may end after; the latest one within reach wins. */
const BREAKS: ReadonlySet<string> = new Set(['\n', '。', '！', '？', '!', '?', '；', ';', '，', ',', '：', ':', '、']);

/** How much one request reads: the first piece, then the rest. */
export const FIRST_CHARS = 30;
export const REST_CHARS = 80;

export interface SplitOptions {
  /** Characters in the first piece; `FIRST_CHARS` unless the caller says otherwise. */
  first?: number;
  /** Characters in every piece after the first; `REST_CHARS` unless the caller says otherwise. */
  rest?: number;
}

/** Characters by code point, so an emoji outside the basic plane counts once, as it reads. */
function chars(text: string): string[] {
  return Array.from(text);
}

/** `text` cut after each mark: every piece but the last keeps the mark that ends it, and none is empty. */
function pieces(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let at = 0; at < text.length; at += 1) {
    if (!BREAKS.has(text[at]!)) continue;
    out.push(text.slice(from, at + 1).trim());
    from = at + 1;
  }
  out.push(text.slice(from).trim());
  return out.filter((piece) => piece.length > 0);
}

/** The last mark at or before `limit`, or -1: a piece is cut after it. */
function lastBreak(points: readonly string[], limit: number): number {
  for (let at = Math.min(limit, points.length - 1); at >= 0; at -= 1) if (BREAKS.has(points[at]!)) return at;
  return -1;
}

/**
 * The pieces `text` is read in, in order, each short enough to synthesize on its own. Empty text
 * reads as nothing at all; text shorter than the first limit stays one piece.
 */
export function splitSpeech(text: string, opts: SplitOptions = {}): string[] {
  const first = Math.max(1, opts.first ?? FIRST_CHARS);
  const rest = Math.max(first, opts.rest ?? REST_CHARS);
  const out: string[] = [];
  /** The piece being filled, and how many characters are in it. */
  let current = '';
  let taken = 0;
  let limit = first;
  for (const piece of pieces(text.trim())) {
    let points = chars(piece);
    while (points.length > limit) {
      // a piece already begun is closed before this one is cut, so order is kept
      if (current) {
        out.push(current);
        current = '';
        taken = 0;
        limit = rest;
      }
      const at = lastBreak(points, limit);
      const cut = at < 0 ? limit : at + 1;
      out.push(points.slice(0, cut).join('').trim());
      points = chars(points.slice(cut).join('').trim());
      limit = rest;
    }
    if (!points.length) continue;
    limit = out.length ? rest : first;
    if (current && taken + points.length > limit) {
      out.push(current);
      current = points.join('');
      taken = points.length;
    } else {
      const piece = points.join('');
      current = current ? joinSpeech([current, piece]) : piece;
      taken += points.length;
    }
  }
  if (current) out.push(current);
  return out.filter((piece) => piece.length > 0);
}
