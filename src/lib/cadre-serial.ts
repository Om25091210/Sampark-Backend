import type { Prisma } from '@prisma/client';

// Server-assigned only — never client-generated, never cached client-side. This is
// deliberate so a future offline path for cadre creation (v1 is online-only) cannot
// reintroduce a collision: a client-generated serial could collide across two
// officers' offline queues, but `nextval()` on a DB sequence physically cannot repeat
// no matter how many concurrent applies race it. The "DIG-" prefix additionally
// guarantees this can never collide with an ADR-038-imported `serialNumber` (those
// are plain paper-register numbers with no such prefix).
//
// Must be called from inside the same transaction that inserts the Cadre row.
// `nextval()` itself is not transactional — a rolled-back transaction does not
// return the number to the sequence — but a rare gap in the numbering is harmless,
// while a collision is not.
export async function nextCadreSerialNumber(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('cadre_serial_number_seq') AS n`;
  return `DIG-${rows[0]!.n.toString().padStart(6, '0')}`;
}
