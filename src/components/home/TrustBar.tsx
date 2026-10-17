import { prisma } from '@/lib/db';
import { LIVE_PRODUCT_WHERE } from '@/lib/marketplace/queries';
import { isPlaceholderBrand } from '@/lib/catalog/jsonld';
import { getCatalogPolicy } from '@/lib/catalog/policy';

/**
 * Brand trust bar. Pure typography (no logo files) — Stripe/Linear style.
 * Static (no marquee animation), centered and wrapping responsively.
 */
export async function TrustBar() {
  const policy = await getCatalogPolicy();
  const brands = await prisma.brand.findMany({
    where: { products: { some: LIVE_PRODUCT_WHERE } },
    select: {
      name: true,
      slug: true,
      _count: { select: { products: { where: LIVE_PRODUCT_WHERE } } },
    },
  });

  // "Other" is an importer placeholder, not a brand anyone makes.
  const top = brands
    .filter((b) => b._count.products > 0 && !isPlaceholderBrand(b, policy.placeholderBrands))
    .sort((a, b) => b._count.products - a._count.products)
    .slice(0, 10);

  if (top.length === 0) return null;

  return (
    <section data-hud="BRANDS" className="border-y border-[hsl(var(--teal)/0.1)] bg-[hsl(var(--teal)/0.025)]">
      <div className="container-px py-10">
        <p className="hud-label mb-6 text-center">Brands in our catalogue</p>
        <ul className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 max-w-5xl mx-auto">
          {top.map((b, i) => (
            <li key={b.name} className="inline-flex items-center gap-3">
              <span
                className="font-mono text-[12.5px] uppercase tracking-[0.26em] text-foreground/70"
              >
                {b.name}
              </span>
              {i < top.length - 1 && (
                <span className="h-1 w-1 rounded-full bg-accent/70" aria-hidden />
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
