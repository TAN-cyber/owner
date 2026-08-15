import { describe, expect, it } from 'vitest';

import {
  hasComparableLoopFileObject,
  sameLoopFileObject,
} from '../../../domains/owner-loop/loop-file-identity.js';

describe('Loop file object identity', () => {
  it('requires a complete device and inode pair before metadata can be skipped', () => {
    const left = { dev: 7, ino: 0, birthtime: 100 };
    const right = { dev: 7, ino: 0, birthtime: 200 };

    expect(hasComparableLoopFileObject(left, right)).toBe(false);
    expect(sameLoopFileObject(left, right)).toBe(false);
  });

  it('uses matching inode and birth time when one Windows device id is unavailable', () => {
    const pathStat = { dev: 0, ino: 42, birthtime: 100 };
    const handleStat = { dev: 7, ino: 42, birthtime: 100 };

    expect(hasComparableLoopFileObject(pathStat, handleStat)).toBe(false);
    expect(sameLoopFileObject(pathStat, handleStat)).toBe(true);
    expect(sameLoopFileObject(pathStat, { ...handleStat, ino: 43 })).toBe(false);
  });
});
