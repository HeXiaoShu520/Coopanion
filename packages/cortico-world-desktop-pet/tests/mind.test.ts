import { describe, expect, it } from 'vitest';
import { CatMind, doseDown, doseUp, leakTo, type MindText } from '../src/mind.ts';

const text: MindText = {
  tired: () => 'tired',
  low: () => 'low',
  fresh: () => 'fresh',
  warm: () => 'warm',
};

describe('doseUp', () => {
  it('never passes 1 however many doses it takes', () => {
    let value = 0;
    for (let i = 0; i < 200; i++) value = doseUp(value, 0.3);
    expect(value).toBeGreaterThan(0.99);
    expect(value).toBeLessThanOrEqual(1);
  });

  it('moves more the closer the value already is: a dose is not a step', () => {
    expect(doseUp(0, 0.1)).toBeCloseTo(0.1);
    expect(doseUp(0.8, 0.1)).toBeGreaterThan(0.1);
  });
});

describe('doseDown', () => {
  it('stays above 0 however many doses it takes', () => {
    let value = 1;
    for (let i = 0; i < 200; i++) value = doseDown(value, 0.3);
    expect(value).toBeLessThan(0.01);
    expect(value).toBeGreaterThan(0);
  });
});

describe('leakTo', () => {
  it('loses half the distance from the base in one half-life', () => {
    expect(leakTo(1, 0.5, 1000, 1000)).toBeCloseTo(0.75);
    expect(leakTo(1, 0.5, 1000, 2000)).toBeCloseTo(0.625);
  });

  it('keeps a value read at the same time, or by a clock that went back', () => {
    expect(leakTo(0.9, 0.5, 1000, 0)).toBe(0.9);
    expect(leakTo(0.9, 0.5, 1000, -5)).toBe(0.9);
  });
});

describe('CatMind', () => {
  it('says nothing while nothing stands out', () => {
    let now = 1_000;
    const mind = new CatMind(() => now);
    expect(mind.line(text, '小明')).toBe('');
    now += 60_000;
    expect(mind.line(text, '小明')).toBe('');
  });

  it('warms to a hand and tires under it', () => {
    let now = 1_000;
    const mind = new CatMind(() => now);
    expect(mind.line(text, '小明')).toBe('');
    for (let i = 0; i < 6; i++) mind.touch('pet');
    expect(mind.line(text, '小明')).toBe('warm');
  });

  it('tires from being thrown, and rests back to its base with time', () => {
    let now = 1_000;
    const mind = new CatMind(() => now);
    for (let i = 0; i < 40; i++) mind.touch('throw');
    expect(mind.line(text, '小明')).toContain('tired');
    now += 24 * 60 * 60_000;
    expect(mind.line(text, '小明')).toBe('');
  });

  it('tires by the distance walked, not by the number of walks', () => {
    let now = 1_000;
    const mind = new CatMind(() => now);
    for (let i = 0; i < 3; i++) mind.walk(1);
    expect(mind.line(text, '小明')).not.toBe('');
    const short = new CatMind(() => now);
    for (let i = 0; i < 3; i++) short.walk(0.1);
    expect(short.line(text, '小明')).toBe('');
  });
});
