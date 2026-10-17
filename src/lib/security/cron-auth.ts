import { timingSafeEqual } from 'node:crypto';

/** X-Cron-Secret must equal CRON_SECRET (constant-time). No secret configured = refused. */
export function cronAuthorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET || '';
  const got = req.headers.get('x-cron-secret') || '';
  if (!expected || expected.includes('change-me')) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}
