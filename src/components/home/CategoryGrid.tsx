import Link from 'next/link';
import Image from 'next/image';
import { ArrowUpRight } from 'lucide-react';
import { getTopCategoriesWithImage } from '@/lib/marketplace/queries';
import { InstrumentIllustration, type IllustrationName } from '@/components/illustrations/instruments';

/** Fallback illustration when a category has no usable real photo. */
function illustrationFor(name: string): IllustrationName {
  const n = name.toLowerCase();
  if (/mass spec|lcms|ms\b|spectromet/.test(n)) return 'massspec';
  if (/microscop|imaging/.test(n)) return 'microscope';
  if (/centrifug/.test(n)) return 'centrifuge';
  if (/spectroscop|aas|ir|uv/.test(n)) return 'detector';
  if (/balance|sample prep|general/.test(n)) return 'balance';
  if (/autosampler/.test(n)) return 'autosampler';
  if (/\bgc\b|gas chromatograph/.test(n)) return 'gc';
  if (/hplc|\blc\b/.test(n)) return 'hplc';
  if (/pump|fluidic|vacuum|gas gener/.test(n)) return 'pcr';
  return 'detector';
}

const GRADIENTS = [
  'from-[hsl(168_45%_92%)] to-[hsl(82_50%_90%)]',
  'from-[hsl(82_50%_92%)] to-[hsl(168_40%_90%)]',
  'from-[hsl(168_40%_91%)] to-[hsl(168_30%_94%)]',
  'from-[hsl(82_45%_91%)] to-[hsl(82_35%_94%)]',
];

export async function CategoryGrid() {
  const categories = await getTopCategoriesWithImage(12);
  if (categories.length === 0) return null;

  return (
    <section id="categories" className="container-px py-24">
      <div className="flex items-end justify-between mb-12 gap-6 flex-wrap">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary mb-2">Categories</p>
          <h2
            className="text-3xl md:text-5xl font-bold text-foreground max-w-2xl"
            style={{ letterSpacing: '-0.035em' }}
          >
            Every instrument your lab needs, in one place.
          </h2>
        </div>
        <Link
          href="/marketplace"
          className="inline-flex items-center gap-2 px-5 py-3 rounded-full border-2 border-foreground/10 text-sm font-semibold text-foreground hover:bg-foreground hover:text-background transition-colors group"
        >
          Browse all
          <ArrowUpRight className="h-4 w-4 group-hover:rotate-45 transition-transform" />
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {categories.map((c, i) => (
          <Link
            key={c.slug}
            href={`/marketplace?category=${c.slug}`}
            className="group relative rounded-2xl border border-border bg-card overflow-hidden transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-[0_22px_50px_-24px_rgba(15,79,64,0.4)]"
          >
            <div className="relative aspect-[4/3] overflow-hidden bg-white">
              {c.image ? (
                <Image
                  src={c.image}
                  alt={c.name}
                  fill
                  sizes="(min-width:1024px) 25vw, (min-width:768px) 33vw, 50vw"
                  className="object-contain p-4 transition-transform duration-500 group-hover:scale-[1.06]"
                />
              ) : (
                <div className={`absolute inset-0 bg-gradient-to-br ${GRADIENTS[i % GRADIENTS.length]}`}>
                  <div className="absolute inset-0 p-7">
                    <InstrumentIllustration name={illustrationFor(c.name)} />
                  </div>
                </div>
              )}
              <div className="absolute top-3 right-3 h-8 w-8 rounded-full bg-white/85 backdrop-blur flex items-center justify-center text-foreground translate-y-1.5 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all">
                <ArrowUpRight className="h-4 w-4" />
              </div>
            </div>
            <div className="px-4 py-3.5 border-t border-border">
              <h3 className="text-sm font-bold leading-tight line-clamp-1">{c.name}</h3>
              <div className="mt-1.5 flex items-center justify-between">
                <span className="text-xs font-semibold text-muted-foreground tabular-nums">
                  {c.count.toLocaleString()} listings
                </span>
                <span className="text-xs font-semibold text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                  Browse →
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
