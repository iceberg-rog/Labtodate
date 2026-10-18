import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LegalShell } from '@/components/site/LegalShell';
import { ProgrammeText } from '@/components/seller/ProgrammeText';
import { siteName } from '@/lib/brand/identity';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { sellerProgramme } from '@/lib/sellers/programme';

export const dynamic = 'force-dynamic';

/**
 * How selling through us works, for suppliers. Public only while the owner
 * runs an open supplier programme (Settings → Suppliers → Public supplier
 * programme page); otherwise the page does not exist (404, noindex) —
 * suppliers join by agreement. The texts are the owner's settings, so the
 * page never states a commission or payout term the business does not run
 * (it used to promise “8 % commission, payout 3 business days after
 * delivery” from env defaults — D15).
 */
export async function generateMetadata(): Promise<Metadata> {
  await ensureSettingsLoaded();
  if (!sellerProgramme().isPublic) return { title: 'Page not found', robots: { index: false, follow: false } };
  return { title: `Selling through ${siteName()}` };
}

export default async function SellerProgrammePage() {
  await ensureSettingsLoaded();
  const programme = sellerProgramme();
  if (!programme.isPublic) notFound();
  // Wiki articles are admin-managed content: only link the seller guide once
  // it is published (it 404'd before).
  const sellerGuide = await prisma.wikiArticle.findFirst({
    where: { slug: 'seller-guide', status: 'PUBLISHED' },
    select: { slug: true },
  });

  return (
    <LegalShell title={`Selling through ${siteName()}`}>
      <ProgrammeText blocks={programme.terms} contactHref={programme.contactHref} contactLabel={programme.contactLabel} />
      <h2>How you are paid</h2>
      <ProgrammeText blocks={programme.payout} contactHref={programme.contactHref} contactLabel={programme.contactLabel} />
      {sellerGuide && (
        <p>
          More in the <a href={`/wiki/${sellerGuide.slug}`}>seller guide</a>.
        </p>
      )}
    </LegalShell>
  );
}
