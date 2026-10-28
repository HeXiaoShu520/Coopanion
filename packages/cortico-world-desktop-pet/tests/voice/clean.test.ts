/** What of a reply a voice reads: no markup, no code, no address, no emoji, no long aside. */
import { describe, expect, it } from 'vitest';
import { MAX_CHARS, cleanSpeech } from '../../src/voice/clean.ts';

describe('cleanSpeech', () => {
  it('drops a code block whole and reads inline code by its content', () => {
    const said = cleanSpeech('先跑这个：\n```bash\npnpm run build\n```\n然后看 `dist` 目录。');
    expect(said).not.toContain('pnpm run build');
    expect(said).not.toContain('```');
    expect(said).not.toContain('`');
    expect(said).toContain('先跑这个');
    expect(said).toContain('dist');
  });

  it('reads a link by the words it shows and an address not at all', () => {
    expect(cleanSpeech('看[官方文档](https://example.com/doc)就知道了。')).toBe('看官方文档就知道了。');
    expect(cleanSpeech('地址是 https://example.com/a?b=c 记得收藏。')).toBe('地址是 记得收藏。');
  });

  it('keeps the words emphasis wraps and the underscores inside a name', () => {
    expect(cleanSpeech('**重要**的事说三遍，别写 `snake_case`。')).toBe('重要的事说三遍，别写 snake_case。');
  });

  it('takes the emoji out, the skin tone and the joiner with them', () => {
    expect(cleanSpeech('好耶🎉👍🏻 我们走吧😊')).toBe('好耶 我们走吧');
  });

  it('drops a long aside with its brackets and keeps the words of a short one', () => {
    expect(cleanSpeech('他说（这是一段很长很长的旁白，长到不该被念出来，因为它是写给眼睛的）好。', { parentheses: 10 })).toBe('他说 好。');
    expect(cleanSpeech('他（小声）说好的')).toBe('他 小声 说好的');
  });

  it('reads tabular and listed lines as plain speech', () => {
    const said = cleanSpeech('# 清单\n\n- 苹果\n- 香蕉\n\n| 名 | 数量 |\n| --- | --- |\n| 梨 | 两个 |');
    expect(said).not.toMatch(/[#|\-]{2,}/);
    expect(said).toContain('苹果香蕉');
    expect(said).toContain('两个');
  });

  it('stops a long reply at a mark near the limit, never in the middle of a word', () => {
    const long = `${'好'.repeat(300)}。`;
    const said = cleanSpeech(long, { maxChars: 20 });
    expect(Array.from(said).length).toBeLessThanOrEqual(20);
    const cut = cleanSpeech('一二三四五六七八九十，后面还有很多很多很多很多很多很多的话。', { maxChars: 12 });
    expect(cut).toBe('一二三四五六七八九十，');
  });

  it('reads nothing when nothing is left', () => {
    expect(cleanSpeech('')).toBe('');
    expect(cleanSpeech('🎉🎉')).toBe('');
    expect(cleanSpeech('```\ncode\n```')).toBe('');
  });

  it('has a default limit of its own', () => {
    expect(Array.from(cleanSpeech('好'.repeat(MAX_CHARS + 50))).length).toBeLessThanOrEqual(MAX_CHARS);
  });
});
