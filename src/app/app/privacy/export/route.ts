import { requireSession } from '@/lib/auth-server';
import { audit } from '@/lib/observability';
import { buildPersonalDataExport } from '@/lib/security/gdpr-export';

export const dynamic = 'force-dynamic';

/** "Download my data" (GDPR art. 15 / 20): the person's own data, no staff-internal notes. */
export async function GET() {
  const session = await requireSession({ redirectTo: '/app/profile' });
  const payload = await buildPersonalDataExport(session.user.id);
  if (!payload) return new Response('Not found', { status: 404 });
  await audit('gdpr.export', session.user.id, 'self-service download');
  const day = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // No e-mail address (or other personal data) in the file name.
      'Content-Disposition': `attachment; filename="lab2date-my-data-${day}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
