import { describe, expect, it } from 'vitest';
import {
  CANONICAL_THANAS,
  SUB_DIVISION_THANAS,
  cadreScopeWhere,
  resolveCadreScope,
  scopeAdmitsThana,
} from './scope.js';

describe('the police jurisdiction table (ADR-044)', () => {
  it('is a partition: 9 sub-divisions, 22 thanas, none shared', () => {
    // If a thana ever appeared under two sub-divisions, two SDOPs would silently hold
    // authority over the same cadres and neither would be wrong according to the code.
    expect(Object.keys(SUB_DIVISION_THANAS)).toHaveLength(9);
    expect(CANONICAL_THANAS).toHaveLength(22);
    expect(new Set(CANONICAL_THANAS).size).toBe(22);
  });

  it('is stored in NFC, so it can be compared against the register (Phase 0)', () => {
    // The table is the right-hand side of every scope comparison. If a key here were
    // encoded differently from the same name in `cadres`, that SDOP would match nothing.
    for (const [sub, thanas] of Object.entries(SUB_DIVISION_THANAS)) {
      expect(sub).toBe(sub.normalize('NFC'));
      for (const t of thanas) expect(t).toBe(t.normalize('NFC'));
    }
  });
});

describe('resolveCadreScope', () => {
  const user = (o: Partial<Parameters<typeof resolveCadreScope>[0]>) =>
    resolveCadreScope({ role: 'officer', thana: null, subDivision: null, ...o });

  it('HQ is unrestricted', () => {
    expect(user({ role: 'super_admin' })).toEqual({ kind: 'all' });
  });

  it('an SDOP gets exactly their sub-division, and nothing from another one', () => {
    const s = user({ role: 'admin', subDivision: 'भैरमगढ़' });
    expect(s).toEqual({ kind: 'thanas', thanas: ['नेलसनार', 'भैरमगढ़', 'जांगला', 'मिरतुर'] });
    expect(scopeAdmitsThana(s, 'जांगला')).toBe(true);
    expect(scopeAdmitsThana(s, 'कुटरू')).toBe(false); // a different SDOP's station
  });

  it('an officer gets exactly their own station', () => {
    const s = user({ role: 'officer', thana: 'गंगालूर' });
    expect(s).toEqual({ kind: 'thanas', thanas: ['गंगालूर'] });
    expect(scopeAdmitsThana(s, 'बीजापुर')).toBe(false);
  });

  it('matches across Unicode encodings, in BOTH directions', () => {
    // भैरमगढ़ with the precomposed ढ़ (U+095D) vs the decomposed form the table holds.
    const precomposed = 'भैरमगढ़';
    expect(precomposed).not.toBe('भैरमगढ़');
    // An SDOP account written the other way still resolves to a real sub-division...
    expect(user({ role: 'admin', subDivision: precomposed })).toEqual(
      user({ role: 'admin', subDivision: 'भैरमगढ़' }),
    );
    // ...and a cadre row written the other way is still admitted.
    expect(scopeAdmitsThana(user({ role: 'officer', thana: 'भैरमगढ़' }), precomposed)).toBe(true);
  });

  describe('fails CLOSED — an account we cannot place sees nothing, never everything', () => {
    const cases: [string, Parameters<typeof user>[0]][] = [
      ['officer with no thana', { role: 'officer', thana: null }],
      ['admin with no subDivision', { role: 'admin', subDivision: null }],
      ['admin with an unknown subDivision', { role: 'admin', subDivision: 'कोतवाली' }],
      ['an unrecognised role', { role: 'auditor' }],
    ];
    for (const [label, u] of cases) {
      it(label, () => {
        const s = user(u);
        expect(s).toEqual({ kind: 'thanas', thanas: [] });
        // The empty list must reach Prisma as a predicate that matches NOTHING.
        // `{}` here would silently mean "no filter" — i.e. see the whole register.
        expect(cadreScopeWhere(s)).toEqual({ thana: { in: [] } });
        expect(scopeAdmitsThana(s, 'गंगालूर')).toBe(false);
      });
    }

    it('reports WHY, so a mis-scoped account is diagnosable', () => {
      const reasons: string[] = [];
      resolveCadreScope({ role: 'admin', thana: null, subDivision: 'कोतवाली' }, (r) => reasons.push(r));
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain('कोतवाली');
    });
  });

  it('HQ produces an EMPTY where clause, not a thana filter', () => {
    expect(cadreScopeWhere({ kind: 'all' })).toEqual({});
  });
});
