import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
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

describe('PDF generation with real-sized photos', () => {
  // Regression: sanitizeDoc used to lay out EVERY string in the document, including the
  // multi-megabyte base64 data URLs of embedded photos, through the font engine. That
  // hung the request (and blocked the event loop) for any profile/report that had a photo.
  function noisePng(w: number, h: number): Buffer {
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = (Math.random() * 256) | 0;
    const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b: Buffer) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255]! ^ (c >>> 8); return (~c) >>> 0; };
    const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
    const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  }

  it('a profile with three ~1.5 MB photos generates in seconds, not minutes', async () => {
    const big = noisePng(700, 700);
    expect(big.length).toBeGreaterThan(1_000_000);
    const t0 = Date.now();
    const pdf = await generateProfilePdf({
      generatedAt: new Date(), photos: [big, big, big],
      cadre: {
        name: 'नाम', phone: '1', aliases: [], thana: 'बीजापुर', currentAddress: 'x', designation: 'x',
        category: 'thana', hasAadhaar: true, hasBankAccount: false, hasAbProforma: false, hasAgreementLetter: false,
      },
      cases: [],
    });
    expect(pdf.length).toBeGreaterThan(big.length);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 60_000);
});