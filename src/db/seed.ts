import { PrismaClient } from '@prisma/client';
import { createQueue } from './queue.js';

// Idempotent seed — safe to re-run. Users are upserted by their unique phone;
// cadres by (name, phone); reports by their idempotency key. This is the single
// source of the cadre/report data the mobile app renders (the inline screen mocks
// were removed — the app now loads everything from here via the API).
const prisma = new PrismaClient();

// Parse a DD/MM/YYYY string (the format used in the field records) to a Date.
// Empty / malformed input → null so an optional column stays unset.
function parseDMY(value: string | undefined): Date | null {
  if (value === undefined || value.trim() === '') return null;
  const [d, m, y] = value.split('/').map((n) => Number(n));
  if (!d || !m || !y) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

const USERS = [
  // Known test super-admin for exercising the OTP auth flow from a real device.
  { name: 'सुपर एडमिन', phone: '+919999999999', role: 'super_admin' as const, designation: 'System Administrator', thana: 'बीजापुर सदर' },
  { name: 'एडमिन', phone: '+919888888888', role: 'admin' as const, designation: 'आईटी सेल', thana: 'बीजापुर सदर' },
  { name: 'राजेश कुमार सिंह', phone: '+919770000001', role: 'officer' as const, designation: 'सहायक उपनिरीक्षक', thana: 'बीजापुर सदर' },
  { name: 'प्रिया वर्मा', phone: '+919770000002', role: 'officer' as const, designation: 'आरक्षक', thana: 'भैरमगढ़' },
];

// One report the seed writes against a cadre. `reportedAt` is set explicitly so
// the newest-first ordering in the mobile feed is deterministic.
interface SeedReport {
  idempotencyKey: string;
  reportingPlace: 'thana' | 'village';
  personStatus: 'alive' | 'dead';
  currentActivity: string;
  isHomeAddress: boolean;
  reportedAt: string;
}

// The full cadre roster the app renders, with their reporting history. Every
// field the mobile profile screen reads is populated here so the DB-backed
// screens show complete records (matching what the removed screen mocks held).
interface SeedCadre {
  // ADR-025. The paper-register number. These are PLACEHOLDERS — the real values
  // arrive with the ~1,790-row import (Design-Docs#7), which owns the true format.
  // Seeded so the profile's serial chip is actually visible before that import:
  // with every row null the field renders nothing and cannot be reviewed at all.
  serialNumber: string;
  name: string;
  phone: string;
  thana: string;
  currentAddress: string;
  permanentAddress: string;
  designation: string;
  category: 'surrendered' | 'jail' | 'thana';
  alertLevel: 'critical' | 'warning' | 'normal';
  // ADR-032. `alertTag` and `alertDate` are a pair: both set, or neither. Seed used
  // to write a date while leaving the tag null, so every seeded row carried an alert
  // date for an alert that did not exist. A `normal` cadre has no alert, so neither.
  alertTag?: string;
  alertDate?: string;
  aliases: string[];
  verificationOffice: string;
  supervisoryOffice: string;
  surrenderDate?: string; // DD/MM/YYYY
  surrenderLocation?: string;
  // ADR-019. Only surrendered cadres have one — it is what the two dashboard
  // tiles split on. Left undefined for jail/thana cadres.
  surrenderOrigin?: 'district' | 'other';
  surrenderYear?: string;
  regiment?: string;
  subDivision?: string;
  familyGroupInfo?: string;
  incident?: string;
  // ADR-036. YYYY-MM-DD. Manually enterable; the import fills the rest.
  dateOfBirth?: string;
  fatherName?: string;
  motherName?: string;
  spouseName?: string;
  reports: SeedReport[];
}

const CADRES: SeedCadre[] = [
  {
    serialNumber: 'BJP/2025/0001',
    name: 'बबलू माडवी', phone: '+919770784646', thana: 'बीजापुर / गंगालूर',
    currentAddress: 'मझीवाडा थाना गंगालूर जिला बीजापुर छ०ग०',
    permanentAddress: 'मझीवाडा गंगालूर जिला बीजापुर',
    designation: 'पश्चिम बस्तर डीवीजन डीएचसीएम (प्लाटून न०12 कमांडर)',
    category: 'surrendered', alertLevel: 'critical', alertTag: 'सक्रिय अलर्ट', alertDate: '2026-05-16',
    dateOfBirth: '1989-07-14', fatherName: 'सुखराम माडवी', motherName: 'सुकमती माडवी', spouseName: 'ललिता माडवी',
    aliases: ['बब्बू', 'माडू', 'B-12 कमांडर'],
    verificationOffice: 'पुलिस अधीक्षक बीजापुर',
    supervisoryOffice: 'पुलिस अधीक्षक बीजापुर',
    surrenderDate: '24/07/2025', surrenderLocation: 'बीजापुर, छत्तीसगढ़',
    surrenderOrigin: 'district',
    surrenderYear: '2025', regiment: 'वज्र-2008', subDivision: 'भैरमगढ़',
    familyGroupInfo: 'सुक्की माडवी पद- प्लाटून न०12 पार्टी सदस्य (पत्नी)',
    incident: 'सितम्बर 2024 में प्लाटून नंबर 13 कमांडर ढितरू ओयाम के नेत्रत्व में 50 - 60 की संख्या में ग्राम हजरा में मिलिशियाँ के लिए एकत्रित हुए थे, तभी 03 सितम्बर 2024 को पुलिस गश्त सचजित होने पर सभी मिलिशिया सदस्य फरार हो गए।',
    reports: [
      { idempotencyKey: 'seed-report-0001', reportingPlace: 'thana', personStatus: 'alive', isHomeAddress: true, reportedAt: '2026-05-16T14:05:00.000Z', currentActivity: 'व्यक्ति थाने में उपस्थित हुआ। एक स्थानीय सामाजिक संस्था के साथ जुड़कर युवाओं को मुख्यधारा से जोड़ने का कार्य कर रहा है।' },
      { idempotencyKey: 'seed-report-babloo-02', reportingPlace: 'thana', personStatus: 'alive', isHomeAddress: true, reportedAt: '2026-05-10T11:30:00.000Z', currentActivity: 'माह में नियमित रूप से थाना रिपोर्टिंग कर रहा है। व्यवहार सामान्य है। परिवार के साथ निवास कर रहा है।' },
      { idempotencyKey: 'seed-report-babloo-03', reportingPlace: 'village', personStatus: 'alive', isHomeAddress: true, reportedAt: '2026-05-02T09:15:00.000Z', currentActivity: 'ग्राम पंचायत में स्वच्छता अभियान में भाग ले रहा है। स्थानीय प्रशासन के साथ सहयोग कर रहा है।' },
      { idempotencyKey: 'seed-report-babloo-04', reportingPlace: 'thana', personStatus: 'alive', isHomeAddress: true, reportedAt: '2026-04-22T16:45:00.000Z', currentActivity: 'इस माह कृषि कार्य में लगा हुआ है। खेतों में धान की फसल की बुवाई कर रहा है।' },
    ],
  },
  {
    serialNumber: 'BJP/2025/0002',
    name: 'महेन्द्र कुमार मड़कम', phone: '+919753402185', thana: 'नारायणपुर',
    currentAddress: 'ग्राम धनोरा, थाना नारायणपुर, जिला नारायणपुर',
    permanentAddress: 'ग्राम धनोरा, जिला नारायणपुर, छत्तीसगढ़',
    designation: 'दस्ते का सदस्य',
    category: 'thana', alertLevel: 'normal',
    aliases: [],
    verificationOffice: 'पुलिस अधीक्षक नारायणपुर',
    supervisoryOffice: 'पुलिस अधीक्षक नारायणपुर',
    surrenderDate: '18/04/2024', surrenderLocation: 'थाना नारायणपुर',
    surrenderYear: '2024', regiment: 'वज्र-2018', subDivision: 'नारायणपुर',
    familyGroupInfo: 'माता, पिता एवं छोटा भाई, धनोरा ग्राम में निवासरत',
    incident: 'मार्च 2024 में ग्राम धनोरा के निकट वन क्षेत्र में सक्रिय दस्ते के साथ गश्त के दौरान पहचाना गया। पुलिस के समक्ष आत्मसमर्पण कर दिया।',
    reports: [
      { idempotencyKey: 'seed-report-mahendra-01', reportingPlace: 'thana', personStatus: 'alive', isHomeAddress: true, reportedAt: '2026-06-02T10:20:00.000Z', currentActivity: 'माह में नियमित रूप से थाना रिपोर्टिंग कर रहा है। परिवार के साथ धनोरा ग्राम में निवासरत।' },
      { idempotencyKey: 'seed-report-mahendra-02', reportingPlace: 'village', personStatus: 'alive', isHomeAddress: true, reportedAt: '2026-05-20T08:40:00.000Z', currentActivity: 'ग्राम धनोरा में कृषि कार्य में संलग्न है। मनरेगा कार्यों में भी भाग ले रहा है।' },
    ],
  },
  {
    serialNumber: 'BJP/2025/0003',
    name: 'किरण बाई नेताम', phone: '+918319641027', thana: 'दंतेवाड़ा',
    currentAddress: 'ग्राम गोमपाड, थाना दंतेवाड़ा, जिला दंतेवाड़ा',
    permanentAddress: 'ग्राम गोमपाड, जिला दंतेवाड़ा, छत्तीसगढ़',
    designation: 'महिला संगठन सदस्य',
    category: 'surrendered', alertLevel: 'warning', alertTag: 'नज़र रखें', alertDate: '2026-05-28',
    dateOfBirth: '1995-11-02', fatherName: 'रामधर नेताम', motherName: 'फूलबाई नेताम', spouseName: 'सुरेश नेताम',
    aliases: [],
    verificationOffice: 'पुलिस अधीक्षक दंतेवाड़ा',
    supervisoryOffice: 'पुलिस अधीक्षक दंतेवाड़ा',
    surrenderDate: '22/11/2022', surrenderLocation: 'थाना दंतेवाड़ा',
    surrenderOrigin: 'other',
    surrenderYear: '2022', regiment: 'वज्र-2011', subDivision: 'दक्षिण दंतेवाड़ा',
    familyGroupInfo: 'पति एवं दो पुत्र, गोमपाड ग्राम में निवासरत',
    incident: 'जनवरी 2023 में दंतेवाड़ा शहर के समीप महिला संगठन की बैठक में भाग लेते हुए गिरफ्तार की गई, बाद में जमानत पर रिहा।',
    reports: [
      { idempotencyKey: 'seed-report-kiran-01', reportingPlace: 'thana', personStatus: 'alive', isHomeAddress: true, reportedAt: '2026-05-28T12:10:00.000Z', currentActivity: 'थाना दंतेवाड़ा में उपस्थिति दर्ज कराई। महिला स्व-सहायता समूह से जुड़कर सिलाई कार्य कर रही है।' },
      { idempotencyKey: 'seed-report-kiran-02', reportingPlace: 'village', personStatus: 'alive', isHomeAddress: true, reportedAt: '2026-05-12T15:35:00.000Z', currentActivity: 'ग्राम गोमपाड में सामान्य जनजीवन व्यतीत कर रही है। परिवार के साथ निवासरत।' },
    ],
  },
  {
    serialNumber: 'BJP/2025/0004',
    name: 'राजेंद्र कश्यप', phone: '+917049528963', thana: 'सुकमा',
    currentAddress: 'ग्राम छिंदगढ़, थाना सुकमा, जिला सुकमा',
    permanentAddress: 'ग्राम छिंदगढ़, जिला सुकमा, छत्तीसगढ़',
    designation: 'सीनियर कैडर',
    category: 'jail', alertLevel: 'critical', alertTag: 'सक्रिय अलर्ट', alertDate: '2026-06-10',
    aliases: [],
    verificationOffice: 'पुलिस अधीक्षक सुकमा',
    supervisoryOffice: 'पुलिस अधीक्षक सुकमा',
    surrenderLocation: 'न्यायिक हिरासत',
    regiment: 'वज्र-2007', subDivision: 'सुकमा पश्चिम',
    familyGroupInfo: 'पत्नी एवं तीन बच्चे, छिंदगढ़ ग्राम में निवासरत',
    incident: 'फरवरी 2025 में सुकमा-चिंतागुफा मार्ग पर आईईडी विस्फोट की योजना में संलिप्त पाया गया। वर्तमान में न्यायिक हिरासत में है।',
    reports: [
      { idempotencyKey: 'seed-report-rajendra-01', reportingPlace: 'thana', personStatus: 'alive', isHomeAddress: false, reportedAt: '2026-06-10T09:00:00.000Z', currentActivity: 'वर्तमान में न्यायिक हिरासत में है। अद्यतन स्थिति सामान्य, नियमित पेशी जारी।' },
    ],
  },
];

async function seedUsers(): Promise<void> {
  for (const u of USERS) {
    await prisma.user.upsert({
      where: { phone: u.phone },
      update: { name: u.name, role: u.role, designation: u.designation, thana: u.thana },
      create: u,
    });
  }
}

async function seedCadre(c: SeedCadre, assignedOfficerId: number, reportedById: number): Promise<void> {
  const data = {
    serialNumber: c.serialNumber,
    name: c.name,
    phone: c.phone,
    thana: c.thana,
    currentAddress: c.currentAddress,
    permanentAddress: c.permanentAddress,
    designation: c.designation,
    category: c.category,
    alertLevel: c.alertLevel,
    alertTag: c.alertTag ?? null,
    alertDate: c.alertDate ? new Date(c.alertDate) : null,
    aliases: [...c.aliases],
    verificationOffice: c.verificationOffice,
    supervisoryOffice: c.supervisoryOffice,
    surrenderDate: parseDMY(c.surrenderDate),
    surrenderLocation: c.surrenderLocation ?? null,
    surrenderOrigin: c.surrenderOrigin ?? null,
    surrenderYear: c.surrenderYear ?? null,
    regiment: c.regiment ?? null,
    subDivision: c.subDivision ?? null,
    familyGroupInfo: c.familyGroupInfo ?? null,
    incident: c.incident ?? null,
    // ADR-036. `@db.Date` — a bare YYYY-MM-DD becomes midnight UTC, which is what
    // we want (no time component to drift across zones).
    dateOfBirth: c.dateOfBirth ? new Date(c.dateOfBirth) : null,
    fatherName: c.fatherName ?? null,
    motherName: c.motherName ?? null,
    spouseName: c.spouseName ?? null,
    assignedOfficerId,
    // ADR-027. Re-seeding must produce a KNOWN state, and "who last touched this"
    // is part of it. Without this, a re-seed leaves whoever last edited a cadre
    // still credited on a record whose values it just overwrote — the profile reads
    // "अंतिम बदलाव — एडमिन" next to data the admin never entered.
    lastEditedAt: null,
    lastEditedById: null,
  };

  const existing = await prisma.cadre.findFirst({ where: { name: c.name, phone: c.phone } });
  const cadre = existing
    ? await prisma.cadre.update({ where: { id: existing.id }, data })
    : await prisma.cadre.create({ data });

  for (const r of c.reports) {
    const fields = {
      cadreId: cadre.id,
      reportedById,
      reportingPlace: r.reportingPlace,
      specificLocation: c.thana,
      personStatus: r.personStatus,
      currentPhone: c.phone,
      currentActivity: r.currentActivity,
      isHomeAddress: r.isHomeAddress,
      reportedAt: new Date(r.reportedAt),
    };
    // Reconcile existing rows to the canonical data on re-run (keeps the seed a
    // true source of truth), then create when absent.
    await prisma.report.upsert({
      where: { idempotencyKey: r.idempotencyKey },
      update: fields,
      create: { ...fields, idempotencyKey: r.idempotencyKey },
    });
  }
}

async function initQueueSchema(databaseUrl: string): Promise<void> {
  const boss = createQueue(databaseUrl);
  await boss.start(); // creates the pgboss schema + tables (idempotent)
  await boss.stop({ graceful: false });
}

async function main(): Promise<void> {
  // Seed is a boot script; Prisma injects .env, so read DATABASE_URL directly.
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required to seed the database');
  }

  await seedUsers();
  const officer = await prisma.user.findUniqueOrThrow({ where: { phone: '+919770000001' } });
  for (const c of CADRES) {
    await seedCadre(c, officer.id, officer.id);
  }
  await initQueueSchema(databaseUrl);

  process.stdout.write(
    `Seed complete: ${USERS.length} users, ${CADRES.length} cadres, ` +
      `${CADRES.reduce((n, c) => n + c.reports.length, 0)} reports, and pg-boss schema initialised.\n`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    await prisma.$disconnect();
    process.stderr.write(`Seed failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
