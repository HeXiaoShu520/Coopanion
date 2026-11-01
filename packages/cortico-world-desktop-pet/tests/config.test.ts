/** config.ts: how the self-adjustment and touch settings read. */
import { describe, expect, it } from 'vitest';
import { SELF_DEFAULT, directSettings, selfAdjustMode, touchWakes } from '../src/config.ts';

describe('selfAdjust', () => {
  it('reads the boolean earlier versions wrote: true as default, false as off', () => {
    expect(selfAdjustMode(true)).toBe('default');
    expect(selfAdjustMode(false)).toBe('off');
    expect(directSettings({ selfAdjust: true })).toEqual(SELF_DEFAULT);
  });

  it('custom takes the per-item picks, any makes every item direct', () => {
    const custom = { ...SELF_DEFAULT, figure: false, sound: true };
    expect(directSettings({ selfAdjust: 'custom', selfAdjustCustom: custom })).toEqual(custom);
    expect(directSettings({ selfAdjust: 'default', selfAdjustCustom: custom })).toEqual(SELF_DEFAULT);
    expect(Object.values(directSettings({ selfAdjust: 'any' })).every(Boolean)).toBe(true);
  });
});

describe('touchWakes', () => {
  it('custom wakes for the picked kinds only', () => {
    const touch = { wakeOn: 'custom' as const, wakeKinds: ['pet', 'drop'] };
    expect(['poke', 'pet', 'throw', 'drop'].filter((k) => touchWakes(touch, k))).toEqual(['pet', 'drop']);
    expect(touchWakes({ wakeOn: 'poke' }, 'pet')).toBe(false);
  });
});
