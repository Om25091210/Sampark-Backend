import { fileURLToPath } from 'node:url';
import pdfMake from 'pdfmake';
import type { TDocumentDefinitions, Content } from 'pdfmake/interfaces.js';

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
  specificLocation: string;
  personStatus: 'alive' | 'dead';
  currentPhone: string;
  currentActivity: string;
  reporterName: string;
}

export interface ReportExportData {
  cadreName: string;
  cadrePhone: string;
  cadreThana: string;
  generatedAt: Date;
  reports: ReportExportRow[];
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
  ];

  const tableHeader = ['क्रम', 'दिनांक', 'स्थान', 'विशिष्ट स्थान', 'स्थिति', 'फ़ोन', 'गतिविधि', 'रिपोर्टकर्ता'].map(
    (text) => ({ text, style: 'th' }),
  );

  const tableRows = data.reports.map((r, i) => [
    { text: String(i + 1), style: 'td' },
    { text: formatDate(r.reportedAt), style: 'td' },
    { text: PLACE_LABEL[r.reportingPlace], style: 'td' },
    { text: r.specificLocation, style: 'td' },
    { text: STATUS_LABEL[r.personStatus], style: 'td' },
    { text: r.currentPhone, style: 'td' },
    { text: r.currentActivity, style: 'td' },
    { text: r.reporterName, style: 'td' },
  ]);

  const body: Content =
    data.reports.length === 0
      ? { text: 'इस कैडर के लिए कोई रिपोर्ट दर्ज नहीं है।', style: 'meta', bold: true }
      : {
          table: {
            headerRows: 1,
            widths: ['auto', 'auto', 'auto', '*', 'auto', 'auto', '*', 'auto'],
            body: [tableHeader, ...tableRows],
          },
          layout: 'lightHorizontalLines',
        };

  const docDefinition: TDocumentDefinitions = {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 32, 28, 40],
    defaultStyle: { font: 'NotoSansDevanagari', fontSize: 9 },
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

  return pdfMake.createPdf(docDefinition).getBuffer();
}
