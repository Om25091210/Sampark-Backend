// Server-templated Hindi copy for Notification rows (Hindi-first rule, root CLAUDE.md).
// Written once at creation time and never re-derived client-side, so the mobile
// inbox and the SNS/FCM push payload always show byte-identical text. Tier labels
// are reused verbatim from mobile src/constants/recency.ts so the two sides never
// disagree on vocabulary.

export function cadreChangeApprovedCopy(cadreName: string): { title: string; body: string } {
  return {
    title: 'बदलाव स्वीकृत',
    body: `${cadreName} के लिए आपका प्रस्तावित बदलाव स्वीकृत हो गया है।`,
  };
}

export function cadreChangeRejectedCopy(
  cadreName: string,
  reason: string,
): { title: string; body: string } {
  return {
    title: 'बदलाव अस्वीकृत',
    body: `${cadreName} के लिए आपका प्रस्तावित बदलाव अस्वीकृत हुआ। कारण: ${reason}`,
  };
}

export function officerReassignCopy(cadreName: string): { title: string; body: string } {
  return {
    title: 'कैडर सौंपा गया',
    body: `${cadreName} अब आपको सौंपा गया है।`,
  };
}

export function thanaTransferCopy(
  cadreName: string,
  fromThana: string,
  toThana: string,
): { title: string; body: string } {
  return {
    title: 'कैडर स्थानांतरित',
    body: `${cadreName} अब थाना ${toThana} में है (पूर्व: ${fromThana})।`,
  };
}

export type EscalationTierLabel = 'सतर्क' | 'जोखिम' | 'उच्च जोखिम';

export function escalationCopy(
  cadreName: string,
  tierLabel: EscalationTierLabel,
): { title: string; body: string } {
  return {
    title: `रिपोर्टिंग लंबित — ${tierLabel}`,
    body: `${cadreName} की रिपोर्टिंग समय सीमा पार हो गई है (${tierLabel})।`,
  };
}
