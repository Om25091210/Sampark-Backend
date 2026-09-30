import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { makeLayoutSafe, generateProfilePdf, generateReportsPdf } from './pdf.js';

// fontkit throws on some Devanagari marks (see pdf.ts). These pin the behaviour that
// matters: text that lays out is returned untouched, text that would crash is repaired
// instead of throwing, and no combination of characters the font supports can make an
// export throw.
const CRASHERS = ['\u0951', '\u1CD0', '\u1CD2', '\uA8E1'];

describe('makeLayoutSafe', () => {
  it('leaves ordinary Hindi, punctuation and Latin untouched', () => {
    for (const s of ['बीजापुर / गंगालूर', 'सुखराम पोडियामी', 'ABC-123 (test)', 'क्ष त्र ज्ञ श्र', '']) {
      expect(makeLayoutSafe(s)).toBe(s);
    }
  });

  it.each(CRASHERS)('repairs %s after a consonant without throwing, keeping the rest', (mark) => {
    const out = makeLayoutSafe(`क${mark}ष`);
    expect(out).not.toContain(mark);
    expect(out).toContain('क');
    expect(out).toContain('ष');
  });
});

describe('PDF generators never throw on unusual characters', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const cadre = (s: string) => ({
    name: s, phone: s, aliases: [s], thana: s, currentAddress: s, designation: s, post: s, fatherName: s,
    category: 'jail' as const, hasAadhaar: true, hasBankAccount: false, hasAbProforma: false, hasAgreementLetter: false,
  });
  const kase = (s: string) => ({
    crimeNumber: s, sections: s, crimeThana: s, crimeDescription: s, jailName: s, courtName: s, caseStatus: s,
    bailGranted: false, inJail: true, underInvestigation: false, underTrial: true, publicHarmOccurred: false, uapaApplied: true,
  });

  it.each(CRASHERS)('profile + reports export survive %s in every free-text field', async (mark) => {
    const s = `क${mark}ष ${mark} नाम${mark}`;
    await expect(
      generateProfilePdf({ generatedAt: new Date(), photos: [png], cadre: cadre(s), cases: [kase(s)] }),
    ).resolves.toBeInstanceOf(Buffer);
    await expect(
      generateReportsPdf({
        cadreName: s, cadrePhone: s, cadreThana: s, generatedAt: new Date(),
        reports: [{
          reportedAt: new Date(), reportingPlace: 'village', specificLocation: s, personStatus: 'alive', currentPhone: s,
          currentActivity: s, surrenderNetworkDetails: s, otherInformation: s, reporterName: s, photos: [png],
        }],
      }),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it('survives random strings drawn from every character the bundled font supports', async () => {
    // Deterministic LCG so a failure reproduces.
    let seed = 20260930;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const fontkit = (await import('node:module')).createRequire(import.meta.url)('fontkit') as {
      openSync(p: string): { characterSet: number[] };
    };
    const path = fileURLToPath(new URL('../assets/fonts/NotoSansDevanagari-Regular.ttf', import.meta.url));
    const cps = fontkit.openSync(path).characterSet.filter((c) => c >= 0x20);
    for (let i = 0; i < 40; i++) {
      const s = Array.from({ length: 30 }, () => String.fromCodePoint(cps[Math.floor(rnd() * cps.length)]!)).join('');
      await expect(
        generateProfilePdf({ generatedAt: new Date(), photos: [], cadre: cadre(s), cases: [kase(s)] }),
      ).resolves.toBeInstanceOf(Buffer);
    }
  });
});