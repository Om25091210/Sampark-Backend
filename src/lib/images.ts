// Image type knowledge, shared by the multipart upload routes and the bulk avatar
// backfill. The mobile client uploads report photos as image/jpeg or image/png (see
// report.service.ts uploadPhoto); anything else is rejected at the edge.

export const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export function isAllowedImageType(mimetype: string): boolean {
  return mimetype in EXT_BY_TYPE;
}

// Leading `data:image/jpeg;base64,` that a browser or Apps Script's own encoder may
// prepend. Stripped rather than rejected — it is the same bytes with a label.
const DATA_URI_PREFIX = /^data:[^;,]*;base64,/i;

/**
 * Decodes a base64 payload into bytes, or null if it is not usable base64.
 *
 * `Buffer.from(s, 'base64')` never throws — it silently skips characters outside the
 * alphabet and truncates. So a corrupt string yields a short buffer rather than an
 * error, which is why callers must still `sniffImageType` the result: the sniff, not
 * the decode, is what proves the payload is an image.
 */
export function decodeBase64Image(raw: string): Buffer | null {
  const stripped = raw.replace(DATA_URI_PREFIX, '').replace(/\s/g, '');
  if (stripped === '') return null;
  const buf = Buffer.from(stripped, 'base64');
  return buf.length === 0 ? null : buf;
}

/**
 * The image type implied by the leading magic bytes, or null if the bytes are neither
 * JPEG nor PNG.
 *
 * Deliberately sniffed rather than taken from a caller-declared content type: the
 * backfill source is images pulled out of Google Sheet cells, where the declared type
 * is whatever the extraction script guessed. The bytes are the only claim that cannot
 * be wrong.
 */
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length >= PNG.length && PNG.every((b, i) => buf[i] === b)) {
    return 'image/png';
  }
  return null;
}
