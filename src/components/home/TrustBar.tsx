import { prisma } from '@/lib/db';

/**
 * Brand trust bar. Pure typography (no logo files) — Stripe/Linear style.
 * Static (no marquee animation), centered and wrapping responsively.
 */
export async function TrustBar() {
  const brands = await prisma.brand.findMany({
    where: { products: { some: { status: 'PUBLISHED' } } },
    select: {
      name: true,
      _count: { select: { products: { where: { status: 'PUBLISHED' } } } },
    },
  });

  const top = brands
    .filter((b) => b._count.products > 0)
    .sort((a, b) => b._count.products - a._count.products)
    .slice(0, 10);

  if (top.length === 0) return null;

  return (
    <section className="border-y border-foreground/5 bg-card/40">
      <div className="container-px py-10">
        <p className="text-center text-[10px] font-bold uppercase tracking-[0.32em] text-muted-foreground/70 mb-6">
          Genuine &amp; compatible parts from
        </p>
        <ul className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 max-w-5xl mx-auto">
          {top.map((b, i) => (
            <li key={b.name} className="inline-flex items-center gap-3">
              <span
                className="text-[15px] font-semibold tracking-tight text-foreground/80"
                style={{ letterSpacing: '-0.015em' }}
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
