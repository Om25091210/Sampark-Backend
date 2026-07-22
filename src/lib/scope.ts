import type { Prisma } from '@prisma/client';
import { nfc } from './text.js';

/**
 * Phase C — row-level authorisation scope (ADR-044).
 *
 * The FIXED police jurisdiction hierarchy: 9 SDOP sub-divisions over 22 thanas. Supplied
 * by the client and verified against the Bijapur district police site and 2024-25 transfer
 * orders. It is a partition — every thana belongs to exactly one sub-division, and all 22
 * canonical thanas are covered. `scope.test.ts` asserts both properties, so a future edit
 * cannot quietly orphan a station or double-map one.
 *
 * WHY THIS TABLE AND NOT `Cadre.subDivision` (this is the important part):
 *
 * `Cadre.subDivision` looks like it should answer "which SDOP owns this cadre" and does
 * NOT. It records which **CPI(Maoist) organisational unit** the cadre operated under —
 * hence values like `डीके जोन` (DK Zone), `माड़ डिवीजन` (Maad Division) and
 * `तेलंगाना स्टेट कमेटी` (Telangana State Committee). Maoist area boundaries and police
 * boundaries are genuinely different, so a cadre living under भैरमगढ़ police jurisdiction
 * may well have operated under the कुटरू Maoist committee — which is exactly the
 * multi-mapping the Phase 0 audit found (भैरमगढ़ thana: 128 rows say भैरमगढ़, 67 say कुटरू).
 *
 * Reading that column as jurisdiction would hand SDOPs a caseload assembled from insurgent
 * geography. Authorisation is therefore derived ONLY from `Cadre.thana` against this table.
 * `Cadre.subDivision` is intelligence data and is never consulted for access control.
 */
export const SUB_DIVISION_THANAS: Readonly<Record<string, readonly string[]>> = {
  // Kutru -> Bedre, Kutru, Naimed
  'कुटरू':          ['बेदरे', 'कुटरू', 'नैमेड़'],
  // Farsegarh -> Farsegarh, Toynar, Modakpal
  'फरसेगढ़':        ['फरसेगढ़', 'तोयनार', 'मोदकपाल'],
  // Bhairamgarh -> Nelasnar, Bhairamgarh, Jangla, Mirtur
  'भैरमगढ़':        ['नेलसनार', 'भैरमगढ़', 'जांगला', 'मिरतुर'],
  // Gangalur -> Gangalur
  'गंगालूर':        ['गंगालूर'],
  // Bijapur / Kotwali -> Bijapur / Kotwali
  'बीजापुर':        ['बीजापुर'],
  // Pamed -> Pamed
  'पामेड़':         ['पामेड़'],
  // Awapalli -> Awapalli, Usoor, Elmidi
  'आवापल्ली':       ['आवापल्ली', 'उसूर', 'एलमिडी'],
  // Basaguda -> Basaguda, Tarrem
  'बासागुड़ा':      ['बासागुड़ा', 'तर्रेम'],
  // Bhopalpatnam -> Bhopalpatnam, Madded, Tarlaguda, Bhadrakali
  'भोपालपटनम':      ['भोपालपटनम', 'मद्देड़', 'तारलागुड़ा', 'भद्रकाली'],
};

/** The 22 canonical thanas, flattened. */
export const CANONICAL_THANAS: readonly string[] = Object.values(SUB_DIVISION_THANAS).flat();

/**
 * What a principal is allowed to see.
 * `all` = unrestricted (HQ). `thanas` = exactly these; an EMPTY list means "nothing",
 * which is the deliberate fail-closed outcome for a mis-scoped account.
 */
export type CadreScope = { kind: 'all' } | { kind: 'thanas'; thanas: readonly string[] };

export const SCOPE_ALL: CadreScope = { kind: 'all' };

export interface ScopedPrincipal {
  role: string;
  thana: string | null;
  subDivision: string | null;
}

/**
 * Resolve a principal's scope. FAIL-CLOSED everywhere: any account we cannot place —
 * an officer with no thana, an SDOP whose sub-division is not in the table, an
 * unrecognised role — resolves to the EMPTY thana list and therefore sees nothing.
 *
 * The alternative (treat "unknown" as unrestricted) fails open, and the whole point of
 * Phase C is that a scoping mistake must not silently widen access. A user seeing an empty
 * list is a visible, reportable bug; a constable silently seeing all 1,482 records is not.
 *
 * `onMisscoped` exists so the caller can LOG the fail-closed case. An account that can see
 * nothing looks identical to a station with no cadres, so it must be noisy in the log or it
 * will be diagnosed as "the app is broken" weeks later.
 */
export function resolveCadreScope(
  user: ScopedPrincipal,
  onMisscoped?: (reason: string) => void,
): CadreScope {
  if (user.role === 'super_admin') return SCOPE_ALL;

  if (user.role === 'admin') {
    if (user.subDivision === null) {
      onMisscoped?.('admin account has no subDivision - scoped to nothing');
      return { kind: 'thanas', thanas: [] };
    }
    const thanas = SUB_DIVISION_THANAS[nfc(user.subDivision)];
    if (thanas === undefined) {
      onMisscoped?.(`admin subDivision "${user.subDivision}" is not one of the 9 - scoped to nothing`);
      return { kind: 'thanas', thanas: [] };
    }
    return { kind: 'thanas', thanas };
  }

  if (user.role === 'officer') {
    if (user.thana === null) {
      onMisscoped?.('officer account has no thana - scoped to nothing');
      return { kind: 'thanas', thanas: [] };
    }
    return { kind: 'thanas', thanas: [nfc(user.thana)] };
  }

  onMisscoped?.(`role "${user.role}" has no scope rule - scoped to nothing`);
  return { kind: 'thanas', thanas: [] };
}

/**
 * The scope as a Prisma predicate on `Cadre`. Returns `{}` for HQ so the query is
 * unchanged, and `{ thana: { in: [] } }` for a mis-scoped account, which matches no rows.
 */
export function cadreScopeWhere(scope: CadreScope): Prisma.CadreWhereInput {
  return scope.kind === 'all' ? {} : { thana: { in: [...scope.thanas] } };
}

/** Does this scope admit a cadre at `thana`? Compared through NFC on both sides. */
export function scopeAdmitsThana(scope: CadreScope, thana: string): boolean {
  if (scope.kind === 'all') return true;
  const t = nfc(thana);
  return scope.thanas.some((s) => nfc(s) === t);
}
