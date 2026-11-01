import { describe, expect, it } from 'vitest';
import { Packer, looksUnfinished } from '../src/asr/segmenter.ts';

describe('looksUnfinished', () => {
  it('reads a tail on a connective or an open mark as unfinished', () => {
    expect(looksUnfinished('我想说的是')).toBe(true);
    expect(looksUnfinished('因为今天下雨所以')).toBe(true);
    expect(looksUnfinished('今天天气不错,')).toBe(true);
    expect(looksUnfinished('我觉得——')).toBe(true);
    expect(looksUnfinished('I was about to')).toBe(true);
    expect(looksUnfinished('I went there and')).toBe(true);
  });

  it('reads a sentence that ends on its own as finished', () => {
    expect(looksUnfinished('今天天气不错。')).toBe(false);
    expect(looksUnfinished('我去超市买了牛奶')).toBe(false);
    expect(looksUnfinished('I think so.')).toBe(false);
    expect(looksUnfinished('')).toBe(false);
  });
});

describe('Packer', () => {
  it('shows what it holds without taking it, and hands it over once the callers stop holding', () => {
    const packer = new Packer({ minChars: 2 });
    expect(packer.add('好')).toBe(false);
    expect(packer.pending).toBe(false);
    expect(packer.add('我想说的是')).toBe(true);
    expect(packer.peek()).toBe('我想说的是');
    expect(packer.pending).toBe(true);
    expect(packer.due(true)).toBeNull();
    expect(packer.due()).toBe('我想说的是');
    expect(packer.peek()).toBe('');
    expect(packer.pending).toBe(false);
  });

  it('joins two pieces the way one sentence is written', () => {
    const packer = new Packer({ minChars: 1 });
    packer.add('我想说的是');
    packer.add('今天有点累');
    expect(packer.peek()).toBe('我想说的是今天有点累');
  });
});
