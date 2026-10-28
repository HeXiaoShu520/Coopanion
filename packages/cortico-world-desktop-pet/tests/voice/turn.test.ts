/** Which answers are read aloud: only those to words from the microphone, and only until the person cuts in. */
import { describe, expect, it } from 'vitest';
import { VoiceTurn, type TurnOptions, type VoicedReply } from '../../src/voice/turn.ts';

function recorder(opts: TurnOptions = {}) {
  const spoken: VoicedReply[] = [];
  let stops = 0;
  const turn = new VoiceTurn({ speak: (reply) => spoken.push(reply), stop: () => { stops += 1; } }, opts);
  return { turn, spoken, stops: () => stops };
}

describe('VoiceTurn', () => {
  it('reads the answer to words it heard, and none to words that were typed', () => {
    const { turn, spoken } = recorder();
    turn.reply('s1', '你好呀。');
    expect(spoken).toEqual([]);

    turn.typed();
    turn.reply('s1', '你好呀。');
    expect(spoken).toEqual([]);

    turn.heard();
    expect(turn.voice).toBe(true);
    turn.reply('s1', '你好呀。');
    expect(spoken).toEqual([{ id: 's1', pieces: ['你好呀。'] }]);
    expect(turn.readingId).toBe('s1');
  });

  it('stops at once when the person types over it', () => {
    const { turn, spoken, stops } = recorder();
    turn.heard();
    turn.reply('s1', '我来讲一件挺长的事情，你听好了。');
    expect(spoken).toHaveLength(1);

    turn.typed();
    expect(stops()).toBe(1);
    expect(turn.readingId).toBe(null);
    expect(turn.voice).toBe(false);
  });

  it('stops when the person speaks again, and reads the next answer', () => {
    const { turn, spoken, stops } = recorder();
    turn.heard();
    turn.reply('s1', '第一句。');
    turn.heard();
    expect(stops()).toBe(1);
    expect(turn.readingId).toBe(null);

    turn.reply('s2', '第二句。');
    expect(spoken.map((r) => r.id)).toEqual(['s1', 's2']);
  });

  it('does not synthesize a line it already read in this turn', () => {
    const { turn, spoken } = recorder();
    turn.heard();
    turn.reply('s1', '好的。');
    turn.reply('s2', '好的。');
    expect(spoken).toHaveLength(1);
    turn.reply('s2', '那我们走吧。');
    expect(spoken).toHaveLength(2);
  });

  it('hands over nothing while reading is switched off', () => {
    const { turn, spoken } = recorder({ off: () => true });
    turn.heard();
    turn.reply('s1', '你好呀。');
    expect(spoken).toEqual([]);
    expect(turn.readingId).toBe(null);
  });

  it('cleans the text and cuts it into pieces before handing it over', () => {
    const { turn, spoken } = recorder();
    turn.heard();
    turn.reply('s1', '**听好了**：\n```js\nconst a = 1;\n```\n我们说点别的。');
    const [reply] = spoken;
    expect(reply!.pieces.join('')).not.toContain('const a');
    expect(reply!.pieces.join(' ')).toContain('听好了');

    turn.reply('s2', '这一句要念得久一点。'.repeat(8));
    expect(spoken[1]!.pieces.length).toBeGreaterThan(1);
  });

  it('takes the end of the turn without cutting the sound that still plays', () => {
    const { turn, stops } = recorder();
    turn.heard();
    turn.reply('s1', '慢慢说完这一句。');
    turn.end();
    expect(stops()).toBe(0);
    expect(turn.voice).toBe(false);
    expect(turn.readingId).toBe('s1');

    turn.finished('s1');
    expect(turn.readingId).toBe(null);
  });
});
