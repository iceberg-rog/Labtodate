// Seed and importer accounts use placeholder addresses (sales@<shop>.import,
// *.example, *.local) that real mail servers reject outright. Callers that
// notify a seller check this and route to an intake inbox instead; company /
// staff copies to such an address are skipped. Pure — safe to import anywhere.
const PLACEHOLDER_TLDS = new Set(['import', 'example', 'ex', 'local', 'localhost', 'test', 'invalid']);

export function isDeliverableEmail(addr: string | null | undefined): addr is string {
  const m = /@[^@\s]+\.([a-z0-9-]+)$/i.exec((addr ?? '').trim());
  return !!m && !PLACEHOLDER_TLDS.has(m[1].toLowerCase());
}
