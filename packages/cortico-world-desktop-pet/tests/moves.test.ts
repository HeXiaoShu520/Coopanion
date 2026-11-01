import { describe, expect, it } from 'vitest';
import { readMove } from '../src/moves.ts';
import type { MoveTarget } from '../src/packs.ts';

const target: MoveTarget = {
  id: 'desk',
  name: { zh: '桌子', en: 'desk' },
  about: { zh: '走到桌子跟前', en: 'walks to the desk' },
  params: [{ id: 'speed', about: { zh: '快慢', en: 'how fast' }, min: 0, max: 2 }],
};

describe('readMove', () => {
  it('walks to a share of the width, clamped, and to the named places', () => {
    expect(readMove({ to: .3 }, [])).toEqual({ kind: 'walk', to: .3, run: false });
    expect(readMove({ to: 5 }, [])).toEqual({ kind: 'walk', to: 1, run: false });
    expect(readMove({ to: 'center', run: true }, [])).toEqual({ kind: 'walk', to: .5, run: true });
    expect(readMove({ to: 'cursor' }, [])).toEqual({ kind: 'walk', to: 'cursor', run: false });
    expect(readMove({ to: '.25' }, [])).toEqual({ kind: 'walk', to: .25, run: false });
  });

  it('refuses Object.prototype member names: they are not targets', () => {
    for (const to of ['toString', 'constructor', '__proto__', 'valueOf']) {
      expect(readMove({ to }, [])).toEqual({ kind: 'badTarget', got: JSON.stringify(to) });
    }
  });

  it('goes to a pack target by id or by name, its params by order or by id', () => {
    expect(readMove({ to: 'desk', params: [1.5] }, [target])).toEqual({ kind: 'move', target, to: 'desk', run: false, params: { speed: 1.5 } });
    expect(readMove({ to: '桌子', params: { speed: .5 } }, [target])).toEqual({ kind: 'move', target, to: 'desk', run: false, params: { speed: .5 } });
    expect(readMove({ to: 'desk' }, [target])).toEqual({ kind: 'move', target, to: 'desk', run: false, params: {} });
  });

  it('reports a call that is none of these', () => {
    expect(readMove({}, [])).toEqual({ kind: 'noTarget' });
    expect(readMove({ to: '月亮' }, [target])).toEqual({ kind: 'badTarget', got: '"月亮"' });
    expect(readMove({ to: .5, params: {} }, [])).toMatchObject({ kind: 'badParams', target: null });
    expect(readMove({ to: 'desk', params: [3] }, [target])).toMatchObject({ kind: 'badParams', target });
    expect(readMove({ to: 'desk', params: ['x'] }, [target])).toMatchObject({ kind: 'badParams', target });
  });
});
