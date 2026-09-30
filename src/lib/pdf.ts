import { fileURLToPath } from 'node:url';
import pdfMake from 'pdfmake';
import { sniffImageType } from './images.js';
import type { TDocumentDefinitions, Content, TableCell } from 'pdfmake/interfaces.js';

// Bundled Devanagari font (Noto Sans Devanagari) so Hindi reports render without a
// headless browser (ADR / CLAUDE.md: pdfmake with a bundled font, single-server budget).
const FONT_REGULAR = fileURLToPath(new URL('../assets/fonts/NotoSansDevanagari-Regular.ttf', import.meta.url));
const FONT_BOLD = fileURLToPath(new URL('../assets/fonts/NotoSansDevanagari-Bold.ttf', import.meta.url));

// Register the font once against the pdfmake singleton and restrict local file
// access to exactly the two bundled TTFs (no arbitrary path reads). Only normal +
// bold variants exist — do not style any text `italics`/`bolditalics`.
pdfMake.setFonts({ NotoSansDevanagari: { normal: FONT_REGULAR, bold: FONT_BOLD } });
pdfMake.setLocalAccessPolicy((path) => path === FONT_REGULAR || path === FONT_BOLD);
// The document never references external resources; deny all external URL fetches.
pdfMake.setUrlAccessPolicy(() => false);

// Hindi labels for the enum values used in a report.
const PLACE_LABEL: Record<'thana' | 'village', string> = { thana: 'थाना', village: 'गाँव' };
const STATUS_LABEL: Record<'alive' | 'dead', string> = { alive: 'जीवित', dead: 'मृत' };

export interface ReportExportRow {
  reportedAt: Date;
  reportingPlace: 'thana' | 'village';
  // This task. Optional — a personStatus='dead' row has none of these three
  // (see reports.schema.ts's checkDeathRequirements); rendered as '—' below,
  // same convention the two already-optional fields below already use.
  specificLocation?: string;
  personStatus: 'alive' | 'dead';
  currentPhone?: string;
  currentActivity?: string;
  // ADR-050. The other two fields of the three-field split. Optional — nullable
  // on rows created before the split, and not every report fills them.
  surrenderNetworkDetails?: string;
  otherInformation?: string;
  reporterName: string;
  // JPEG/PNG bytes of the report's evidence photos, in upload order. Empty when the
  // report has none or the export skipped them (see ReportExportData.photosOmitted).
  photos: Buffer[];
}

export interface ReportExportData {
  cadreName: string;
  cadrePhone: string;
  cadreThana: string;
  generatedAt: Date;
  reports: ReportExportRow[];
  // Photos that existed but were left out (unreadable, unsupported format, or over the
  // export's size budget) — surfaced in the document so a short PDF is never mistaken
  // for a report that had no photos.
  photosOmitted?: number;
}

// dd/mm/yyyy in IST (Asia/Kolkata) — the report is read locally in Chhattisgarh.
const dateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function formatDate(d: Date): string {
  return dateFmt.format(d);
}

// pdfmake takes embedded images as data URLs. The caller has already sniffed the bytes
// as JPEG or PNG, so the label here is only a fallback for an unexpected caller.
function imageDataUrl(buf: Buffer): string {
  return `data:${sniffImageType(buf) ?? 'image/jpeg'};base64,${buf.toString('base64')}`;
}

// fontkit (pdfmake's font engine) throws "Cannot read properties of null (reading
// 'xCoordinate')" while positioning the Devanagari Vedic accent marks U+0951-U+0954 after
// a consonant (found by scanning the whole Devanagari block against the bundled Noto
// font: only U+0951 crashes today, the neighbours are stripped as the same kind of mark).
// They carry no meaning in a name/address/report, but one stray paste of them used to turn a
// whole export into a 500, so every string is cleaned before pdfmake sees it.
const FONT_CRASH_MARKS = /[॑-॔]/g;

function sanitizeDoc<T>(node: T): T {
  if (typeof node === 'string') return node.replace(FONT_CRASH_MARKS, '') as T;
  if (Array.isArray(node)) return node.map(sanitizeDoc) as T;
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, sanitizeDoc(v)])) as T;
  }
  return node; // numbers, booleans, and the footer function
}

const REPORT_COLUMNS = 10;
const PHOTOS_PER_LINE = 5;

// Lays named images (keys into the document's `images` dictionary) out in lines of
// PHOTOS_PER_LINE, each scaled to fit the given box without distortion.
function photoLines(names: string[], fit: [number, number]): Content[] {
  const lines: Content[] = [];
  for (let i = 0; i < names.length; i += PHOTOS_PER_LINE) {
    lines.push({
      columns: names.slice(i, i + PHOTOS_PER_LINE).map((image) => ({ image, fit, width: fit[0] })),
      columnGap: 6,
      margin: [0, 0, 0, 4],
    });
  }
  return lines;
}

// Builds a Hindi PDF of a cadre's reports and resolves to the raw PDF bytes.
export async function generateReportsPdf(data: ReportExportData): Promise<Buffer> {
  const header: Content = [
    { text: 'संपर्क — कैडर रिपोर्ट', style: 'title' },
    {
      style: 'meta',
      columns: [
        { text: [{ text: 'कैडर का नाम: ', bold: true }, data.cadreName] },
        { text: [{ text: 'थाना: ', bold: true }, data.cadreThana] },
      ],
    },
    {
      style: 'meta',
      columns: [
        { text: [{ text: 'फ़ोन: ', bold: true }, data.cadrePhone] },
        { text: [{ text: 'निर्यात दिनांक: ', bold: true }, formatDate(data.generatedAt)] },
      ],
    },
    { text: `कुल रिपोर्ट: ${data.reports.length}`, style: 'meta', bold: true },
    ...(data.photosOmitted
      ? [{ text: `नोट: ${data.photosOmitted} फ़ोटो इस दस्तावेज़ में शामिल नहीं हो सकीं।`, style: 'meta' } as Content]
      : []),
  ];

  // ADR-050. Three distinct description columns, not one blob — mirrors the
  // mobile create-report form's three-field split.
  const tableHeader = [
    'क्रम', 'दिनांक', 'स्थान', 'विशिष्ट स्थान', 'स्थिति', 'फ़ोन',
    'वर्तमान गतिविधि', 'अन्य माओवादियों से सम्पर्क विवरण', 'अन्य जानकारी', 'रिपोर्टकर्ता',
  ].map((text) => ({ text, style: 'th' }));

  // Each report is its own row; a report with photos gets a second row directly under
  // it, spanning every column, holding the photos side by side (PHOTOS_PER_LINE to a
  // line) so the picture sits with the text it belongs to.
  const images: Record<string, string> = {};
  const tableRows: TableCell[][] = [];
  data.reports.forEach((r, i) => {
    tableRows.push([
      { text: String(i + 1), style: 'td' },
      { text: formatDate(r.reportedAt), style: 'td' },
      { text: PLACE_LABEL[r.reportingPlace], style: 'td' },
      { text: r.specificLocation || '—', style: 'td' },
      { text: STATUS_LABEL[r.personStatus], style: 'td' },
      { text: r.currentPhone || '—', style: 'td' },
      { text: r.currentActivity || '—', style: 'td' },
      { text: r.surrenderNetworkDetails || '—', style: 'td' },
      { text: r.otherInformation || '—', style: 'td' },
      { text: r.reporterName, style: 'td' },
    ]);
    if (r.photos.length > 0) {
      const names = r.photos.map((buf, j) => {
        const name = `r${i}p${j}`;
        images[name] = imageDataUrl(buf);
        return name;
      });
      tableRows.push([
        { stack: photoLines(names, [150, 150]), colSpan: REPORT_COLUMNS, margin: [0, 2, 0, 4] },
        ...Array.from({ length: REPORT_COLUMNS - 1 }, () => ({})),
      ]);
    }
  });

  const body: Content =
    data.reports.length === 0
      ? { text: 'इस कैडर के लिए कोई रिपोर्ट दर्ज नहीं है।', style: 'meta', bold: true }
      : {
          table: {
            headerRows: 1,
            widths: ['auto', 'auto', 'auto', '*', 'auto', 'auto', '*', '*', '*', 'auto'],
            body: [tableHeader, ...tableRows],
          },
          layout: 'lightHorizontalLines',
        };

  const docDefinition: TDocumentDefinitions = {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 32, 28, 40],
    defaultStyle: { font: 'NotoSansDevanagari', fontSize: 9 },
    images,
    content: [...header, { text: '', margin: [0, 6, 0, 0] }, body],
    styles: {
      title: { fontSize: 16, bold: true, margin: [0, 0, 0, 10] },
      meta: { fontSize: 10, margin: [0, 1, 0, 1] },
      th: { bold: true, fontSize: 9, fillColor: '#eeeeee', margin: [0, 3, 0, 3] },
      td: { fontSize: 8, margin: [0, 2, 0, 2] },
    },
    footer: (currentPage: number, pageCount: number): Content => ({
      text: `पृष्ठ ${currentPage} / ${pageCount}`,
      alignment: 'center',
      fontSize: 8,
      margin: [0, 12, 0, 0],
    }),
  };

  return pdfMake.createPdf(sanitizeDoc(docDefinition)).getBuffer();
}

// ─── Master profile ───────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<'surrendered' | 'jail' | 'thana', string> = {
  surrendered: 'आत्मसमर्पित',
  jail: 'जेल / बेल / रिहा',
  thana: 'गैर आत्मसमर्पित माओवादी',
};
const PERMANENT_STATUS_LABEL: Record<string, string> = {
  deceased: 'मृत',
  government_job: 'शासकीय नौकरी',
  gs: 'GS',
  living_elsewhere: 'अन्य जिले में निवासरत',
  untraceable: 'लापता',
};
const CUSTODY_STATUS_LABEL: Record<string, string> = {
  in_custody: 'हिरासत में / जेल में',
  released: 'रिहा / जेल से बाहर',
};
const GENDER_LABEL: Record<'male' | 'female', string> = { male: 'पुरुष', female: 'महिला' };

export interface ProfileExportCase {
  crimeNumber?: string;
  sections?: string;
  crimeThana?: string;
  crimeDescription?: string;
  arrestDate?: Date;
  bailGranted: boolean;
  bailDate?: Date;
  inJail: boolean;
  jailName?: string;
  underInvestigation: boolean;
  underTrial: boolean;
  challanNumber?: string;
  courtName?: string;
  caseStatus?: string;
  publicHarmOccurred: boolean;
  uapaApplied: boolean;
}

export interface ProfileExportData {
  generatedAt: Date;
  // JPEG/PNG bytes of the cadre's photo slots, in slot order.
  photos: Buffer[];
  photosOmitted?: number;
  cadre: {
    serialNumber?: string;
    name: string;
    phone: string;
    aliases: string[];
    gender?: 'male' | 'female';
    dateOfBirth?: Date;
    age?: number;
    fatherName?: string;
    motherName?: string;
    spouseName?: string;
    caste?: string;
    thana: string;
    subDivision?: string;
    district?: string;
    currentAddress: string;
    permanentAddress?: string;
    residingVillage?: string;
    designation: string;
    post?: string;
    regiment?: string;
    familyGroupInfo?: string;
    category: 'surrendered' | 'jail' | 'thana';
    priorityCategory?: string;
    permanentStatus?: string;
    custodyStatus?: string;
    deceasedDate?: Date;
    surrenderDate?: Date;
    surrenderLocation?: string;
    surrenderYear?: string;
    hasAadhaar: boolean;
    hasBankAccount: boolean;
    hasAbProforma: boolean;
    hasAgreementLetter: boolean;
    lastReportedAt?: Date;
  };
  cases: ProfileExportCase[];
}

type KvRow = [label: string, value: string | undefined];

const yesNo = (b: boolean): string => (b ? 'हाँ' : 'नहीं');

// A two-column label/value table. Rows with no value are dropped rather than printed
// as blanks — a profile that is mostly '—' hides the few facts it does have.
function kvTable(rows: KvRow[]): Content {
  const present = rows.filter((r): r is [string, string] => r[1] !== undefined && r[1] !== '');
  if (present.length === 0) return { text: '—', style: 'meta' };
  return {
    table: {
      widths: [140, '*'],
      body: present.map(([label, value]) => [
        { text: label, bold: true, fillColor: '#f5f5f5', margin: [2, 2, 2, 2] },
        { text: value, margin: [2, 2, 2, 2] },
      ]),
    },
    layout: 'lightHorizontalLines',
  };
}

// Builds a Hindi PDF of a cadre's master profile (photos, particulars, and — for the
// जेल/जमानत register — every criminal case) and resolves to the raw PDF bytes.
export async function generateProfilePdf(data: ProfileExportData): Promise<Buffer> {
  const c = data.cadre;
  const images: Record<string, string> = {};
  const photoNames = data.photos.map((buf, i) => {
    images[`p${i}`] = imageDataUrl(buf);
    return `p${i}`;
  });

  const content: Content[] = [
    { text: 'संपर्क — मास्टर प्रोफ़ाइल', style: 'title' },
    { text: [{ text: 'निर्यात दिनांक: ', bold: true }, formatDate(data.generatedAt)], style: 'meta' },
    ...(data.photosOmitted
      ? [{ text: `नोट: ${data.photosOmitted} फ़ोटो इस दस्तावेज़ में शामिल नहीं हो सकीं।`, style: 'meta' } as Content]
      : []),
    ...(photoNames.length > 0
      ? [{ stack: photoLines(photoNames, [150, 180]), margin: [0, 8, 0, 4] } as Content]
      : []),

    { text: 'पहचान', style: 'section' },
    kvTable([
      ['क्रमांक', c.serialNumber],
      ['नाम', c.name],
      ['उपनाम', c.aliases.length > 0 ? c.aliases.join(', ') : undefined],
      ['फ़ोन', c.phone],
      ['लिंग', c.gender ? GENDER_LABEL[c.gender] : undefined],
      ['जन्म तिथि', c.dateOfBirth ? formatDate(c.dateOfBirth) : undefined],
      ['आयु', c.age !== undefined ? String(c.age) : undefined],
      ['जाति', c.caste],
    ]),

    { text: 'परिवार', style: 'section' },
    kvTable([
      ['पिता का नाम', c.fatherName],
      ['माता का नाम', c.motherName],
      ['पति/पत्नी का नाम', c.spouseName],
      ['परिवार / साथ रहने वाले', c.familyGroupInfo],
    ]),

    { text: 'पता एवं क्षेत्र', style: 'section' },
    kvTable([
      ['थाना', c.thana],
      ['वर्तमान निवास', c.currentAddress],
      ['स्थायी पता', c.permanentAddress],
      ['वर्तमान निवासरत ग्राम', c.residingVillage],
      ['अनुभाग', c.subDivision],
      ['जिला', c.district],
    ]),

    { text: 'वर्गीकरण', style: 'section' },
    kvTable([
      ['श्रेणी', CATEGORY_LABEL[c.category]],
      ['कैटेगरी', c.priorityCategory],
      ['स्थायी चिह्न', c.permanentStatus ? PERMANENT_STATUS_LABEL[c.permanentStatus] ?? c.permanentStatus : undefined],
      ['मृत्यु दिनांक', c.deceasedDate ? formatDate(c.deceasedDate) : undefined],
      ['हिरासत की स्थिति', c.custodyStatus ? CUSTODY_STATUS_LABEL[c.custodyStatus] ?? c.custodyStatus : undefined],
      ['पद / रैंक', c.designation],
      ['Post', c.post],
      ['रेजिमेंट', c.regiment],
      ['अंतिम रिपोर्टिंग तिथि', c.lastReportedAt ? formatDate(c.lastReportedAt) : undefined],
    ]),
  ];

  if (c.category === 'surrendered') {
    content.push(
      { text: 'समर्पण', style: 'section' },
      kvTable([
        ['समर्पण दिनांक', c.surrenderDate ? formatDate(c.surrenderDate) : undefined],
        ['समर्पण स्थान', c.surrenderLocation],
        ['समर्पण वर्ष', c.surrenderYear],
      ]),
    );
  }

  content.push(
    { text: 'दस्तावेज़', style: 'section' },
    kvTable([
      ['आधार', yesNo(c.hasAadhaar)],
      ['बैंक खाता', yesNo(c.hasBankAccount)],
      ['AB प्रोफार्मा', yesNo(c.hasAbProforma)],
      ['एग्रीमेंट पत्र', yesNo(c.hasAgreementLetter)],
    ]),
  );

  if (c.category === 'jail') {
    content.push({ text: `आपराधिक प्रकरण (${data.cases.length})`, style: 'section' });
    if (data.cases.length === 0) {
      content.push({ text: 'कोई प्रकरण दर्ज नहीं है।', style: 'meta' });
    }
    data.cases.forEach((k, i) => {
      content.push(
        { text: `प्रकरण ${i + 1}`, bold: true, margin: [0, 6, 0, 2] },
        kvTable([
          ['अपराध क्रमांक', k.crimeNumber],
          ['धारा', k.sections],
          ['थाना (जहां अपराध दर्ज है)', k.crimeThana],
          ['अपराध विवरण', k.crimeDescription],
          ['गिरफ्तारी दिनांक', k.arrestDate ? formatDate(k.arrestDate) : undefined],
          ['जमानत', k.bailGranted ? `हाँ${k.bailDate ? ` — ${formatDate(k.bailDate)}` : ''}` : 'नहीं'],
          ['जेल निरूद्ध', k.inJail ? `हाँ${k.jailName ? ` — ${k.jailName}` : ''}` : 'नहीं'],
          ['प्रकरण विवेचनाधीन', yesNo(k.underInvestigation)],
          ['प्रकरण विचाराधीन', yesNo(k.underTrial)],
          ['चालान क्रमांक', k.challanNumber],
          ['Court Name', k.courtName],
          ['Case Status', k.caseStatus],
          ['जनहानि हुई', yesNo(k.publicHarmOccurred)],
          ['यूएपीए लगा है', yesNo(k.uapaApplied)],
        ]),
      );
    });
  }

  const docDefinition: TDocumentDefinitions = {
    pageSize: 'A4',
    pageMargins: [36, 36, 36, 44],
    defaultStyle: { font: 'NotoSansDevanagari', fontSize: 10 },
    images,
    content,
    styles: {
      title: { fontSize: 16, bold: true, margin: [0, 0, 0, 6] },
      meta: { fontSize: 10, margin: [0, 1, 0, 1] },
      section: { fontSize: 12, bold: true, margin: [0, 12, 0, 4] },
    },
    footer: (currentPage: number, pageCount: number): Content => ({
      text: `पृष्ठ ${currentPage} / ${pageCount}`,
      alignment: 'center',
      fontSize: 8,
      margin: [0, 12, 0, 0],
    }),
  };

  return pdfMake.createPdf(sanitizeDoc(docDefinition)).getBuffer();
}