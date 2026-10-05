// ADR-058 (amended by ADR-067). The mirror is one tab PER CATEGORY, not one tab for
// everything. The four create-form choices in the mobile app (create.tsx's
// CATEGORY_CHOICES) split `surrendered` by origin, and the other-origin choice splits
// again by otherOriginType -- so five real tabs, plus one for rows whose
// classification is incomplete.
//
// This is the ONLY place a cadre is mapped to a tab. The Apps Script side whitelists
// exactly these names (B-Smart.gs's MIRROR_TABS) and refuses anything else, so a bad
// payload can never create an arbitrary sheet.
export const MIRROR_TABS = [
  'Cadre-Surrendered',
  'Cadre-OtherDistrict',
  'Cadre-OtherState',
  'Cadre-Thana',
  'Cadre-Jail',
  // A surrendered cadre with no/partial origin classification appears in neither
  // dashboard tile (see the backend CLAUDE.md note on surrenderOrigin). Giving those
  // rows their own tab makes the gap visible and fixable instead of silently dropping
  // them from the mirror.
  'Cadre-Unclassified',
] as const;

export type MirrorTab = (typeof MIRROR_TABS)[number];

export interface TabbableCadre {
  category: string;
  surrenderOrigin: string | null;
  otherOriginType: string | null;
}

export function resolveMirrorTab(c: TabbableCadre): MirrorTab {
  switch (c.category) {
    case 'thana':
      return 'Cadre-Thana';
    case 'jail':
      return 'Cadre-Jail';
    case 'surrendered':
      if (c.surrenderOrigin === 'district') return 'Cadre-Surrendered';
      if (c.surrenderOrigin === 'other') {
        if (c.otherOriginType === 'other_district') return 'Cadre-OtherDistrict';
        if (c.otherOriginType === 'other_state') return 'Cadre-OtherState';
      }
      return 'Cadre-Unclassified';
    default:
      return 'Cadre-Unclassified';
  }
}
