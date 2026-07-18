import { describe, it, expect } from 'vitest';
import { deriveAge } from './serialize.js';

// ADR-036. Age is derived on read, so the calendar arithmetic is the whole feature.
describe('deriveAge', () => {
  const now = new Date('2026-07-18T12:00:00.000Z');

  it('is undefined when there is no birth date', () => {
    expect(deriveAge(null, now)).toBeUndefined();
  });

  it('counts whole years', () => {
    expect(deriveAge(new Date('2000-07-18'), now)).toBe(26);
  });

  it('has NOT counted a birthday that is still to come this year', () => {
    // Birthday is 2026-12-01, still ahead of 2026-07-18.
    expect(deriveAge(new Date('1990-12-01'), now)).toBe(35);
  });

  it('HAS counted a birthday already passed this year', () => {
    // Birthday 2026-01-05 is behind us.
    expect(deriveAge(new Date('1990-01-05'), now)).toBe(36);
  });

  it('counts the birthday itself as the new age (boundary)', () => {
    expect(deriveAge(new Date('1990-07-18'), now)).toBe(36);
  });

  it('has not yet counted the day before the birthday', () => {
    expect(deriveAge(new Date('1990-07-19'), now)).toBe(35);
  });

  it('returns undefined for a future birth date rather than a negative age', () => {
    // A bad import value must not surface as age -5.
    expect(deriveAge(new Date('2031-01-01'), now)).toBeUndefined();
  });
});
