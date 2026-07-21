import { describe, it, expect } from 'vitest';
import { deriveAge, toWireUser } from './serialize.js';

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

// ADR-042. The scope pair must actually reach the client: `subDivision` was on the model
// and on the mobile type but missing from this serializer, so an SDOP's scope silently
// never left the server. Caught by a staging smoke test, pinned here.
describe('toWireUser org scope (ADR-042)', () => {
  const base = {
    id: 1, name: 'SDOPBJR', phone: null, email: 'sdopbjr@sampark.internal',
    passwordHash: null, totpSecret: null, totpConfirmedAt: null, role: 'admin' as const,
    designation: null, avatarUrl: null, badgeImageUrl: null, deletedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  };

  it('returns subDivision for an SDOP and thana for an officer', () => {
    expect(toWireUser({ ...base, thana: null, subDivision: 'बीजापुर' }))
      .toMatchObject({ subDivision: 'बीजापुर' });
    expect(toWireUser({ ...base, role: 'officer', thana: 'गंगालूर', subDivision: null }))
      .toMatchObject({ thana: 'गंगालूर' });
  });

  it('omits both for an unrestricted HQ account', () => {
    const w = toWireUser({ ...base, role: 'super_admin', thana: null, subDivision: null });
    // The serializer sets absent optionals to `undefined` rather than omitting the key —
    // JSON.stringify drops them, so the client sees them absent. Assert the VALUE.
    expect(w.thana).toBeUndefined();
    expect(w.subDivision).toBeUndefined();
    expect(JSON.parse(JSON.stringify(w))).not.toHaveProperty('subDivision');
  });
});
