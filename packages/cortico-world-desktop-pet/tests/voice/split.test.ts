/** Cutting a reply into the pieces one synthesis request reads. */
import { describe, expect, it } from 'vitest';
import { FIRST_CHARS, splitSpeech } from '../../src/voice/split.ts';

const chars = (text: string): number => Array.from(text).length;

describe('splitSpeech', () => {
  it('reads nothing for empty text, and a short reply in one piece', () => {
    expect(splitSpeech('')).toEqual([]);
    expect(splitSpeech('   ')).toEqual([]);
    expect(splitSpeech('你好呀。今天过得怎么样？')).toEqual(['你好呀。今天过得怎么样？']);
  });

  it('keeps every piece short enough, the first one shorter, and loses no words', () => {
    const text = '今天天气很好。我们去公园散步吧，然后买点吃的回来。晚上再看一部电影，要是还有精神的话就再看一部。';
    const pieces = splitSpeech(text);
    expect(pieces.length).toBeGreaterThan(1);
    expect(chars(pieces[0]!)).toBeLessThanOrEqual(FIRST_CHARS);
    expect(pieces.join('')).toBe(text);
  });

  it('cuts at a mark within reach instead of at the limit', () => {
    expect(splitSpeech('这是一句话，后面还有很长很长很长很长的话。', { first: 10, rest: 80 })).toEqual(['这是一句话，', '后面还有很长很长很长很长的话。']);
  });

  it('forces a cut at the limit when no mark is in reach', () => {
    expect(splitSpeech('a'.repeat(100), { first: 10, rest: 20 }).map(chars)).toEqual([10, 20, 20, 20, 20, 10]);
  });

  it('keeps the space between sentences of a language written with spaces, and gives Chinese none', () => {
    expect(splitSpeech('It rains. It pours. It floods.')).toEqual(['It rains. It pours. It floods.']);
    expect(splitSpeech('下雨了。越下越大。路上都积水了。')).toEqual(['下雨了。越下越大。路上都积水了。']);
  });

  it('counts an emoji outside the basic plane once', () => {
    expect(splitSpeech('🙂'.repeat(40), { first: 10, rest: 10 }).map(chars)).toEqual([10, 10, 10, 10]);
  });
});
