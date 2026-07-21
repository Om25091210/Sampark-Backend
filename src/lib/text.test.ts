import { describe, expect, it } from 'vitest';
import { nfc } from './text.js';
import { importCadreRow, listCadresQuery } from '../modules/cadres/cadres.schema.js';
import { importUserRow } from '../modules/users/users.schema.js';

// The two encodings of भैरमगढ़. They render identically and are canonically equivalent,
// but `===` and Postgres `=` both say they are different values. Written as escapes so
// the assertion cannot be silently "fixed" by an editor renormalising this file.
const PRECOMPOSED = 'भैरमगढ़'; // ...ढ़ as U+095D
const DECOMPOSED = 'भैरमगढ़'; // ...ढ + nukta

describe('NFC normalisation of Devanagari location text (Phase 0)', () => {
  it('the two encodings really are distinct strings that NFC unifies', () => {
    // Guards the premise. If this ever fails, the rest of Phase 0 is solving a non-problem.
    expect(PRECOMPOSED).not.toBe(DECOMPOSED);
    expect(nfc(PRECOMPOSED)).toBe(DECOMPOSED);
    // NFC DEcomposes here — the precomposed nukta letters are composition-excluded — so
    // the canonical stored form is the longer sequence, not the shorter one.
    expect(nfc(PRECOMPOSED).length).toBeGreaterThan(PRECOMPOSED.length);
    expect(nfc(DECOMPOSED)).toBe(DECOMPOSED);
  });

  const cadre = {
    serialNumber: '9001',
    name: 'क',
    phone: '',
    currentAddress: 'x',
    designation: 'y',
    category: 'surrendered',
    alertLevel: 'normal',
  };

  it('normalises cadre thana, subDivision and district on import', () => {
    const parsed = importCadreRow.parse({
      ...cadre,
      thana: PRECOMPOSED,
      subDivision: PRECOMPOSED,
      district: PRECOMPOSED,
    });
    expect(parsed.thana).toBe(DECOMPOSED);
    expect(parsed.subDivision).toBe(DECOMPOSED);
    expect(parsed.district).toBe(DECOMPOSED);
  });

  it('normalises the account scope fields on user import', () => {
    const officer = importUserRow.parse({
      name: 'SHOX01',
      email: 'x@sampark.internal',
      role: 'officer',
      thana: PRECOMPOSED,
    });
    expect(officer.thana).toBe(DECOMPOSED);

    const sdop = importUserRow.parse({
      name: 'SDOPX01',
      email: 'y@sampark.internal',
      role: 'admin',
      subDivision: PRECOMPOSED,
    });
    expect(sdop.subDivision).toBe(DECOMPOSED);
  });

  it('normalises the thana query filter, so a client sending either form matches', () => {
    // Without this, a mobile keyboard emitting the precomposed form would filter for a
    // value that exists nowhere in the table and return an empty, unremarkable list.
    expect(listCadresQuery.parse({ thana: PRECOMPOSED }).thana).toEqual([DECOMPOSED]);
    expect(listCadresQuery.parse({ thana: DECOMPOSED }).thana).toEqual([DECOMPOSED]);
  });
});
