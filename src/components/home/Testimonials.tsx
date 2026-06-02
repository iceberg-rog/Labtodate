import { Star } from 'lucide-react';
import { TESTIMONIALS } from '@/lib/seed-data/testimonials';
import { HOME_DEFAULTS } from '@/lib/home-sections';
import { prisma } from '@/lib/db';

export async function Testimonials({
  heading = HOME_DEFAULTS.testHeading,
  meta = HOME_DEFAULTS.testMeta,
}: {
  heading?: string;
  meta?: string;
} = {}) {
  let list: { quote: string; author: string; role: string | null; company: string | null; rating: number }[] = [];
  try {
    const rows = await prisma.testimonial.findMany({
      where: { published: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: 6,
    });
    list = rows;
  } catch {
    /* table may not exist on first boot */
  }
  if (list.length === 0) list = TESTIMONIALS;
  return (
    <section className="border-y border-foreground/5 bg-foreground/[0.02]">
      <div className="container-px py-24">
        <div className="text-center mb-14 max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-2 mb-4">
            <div className="flex items-center gap-0.5">
              {[...Array(5)].map((_, i) => (
                <Star key={i} className="h-5 w-5 fill-[hsl(82_76%_45%)] text-[hsl(82_76%_45%)]" />
              ))}
            </div>
            <span className="text-sm text-muted-foreground">{meta}</span>
          </div>
          <h2
            className="text-3xl md:text-5xl font-bold text-foreground"
            style={{ letterSpacing: '-0.035em' }}
          >
            {heading}
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {list.map((t, idx) => (
            <figure
              key={`${t.author}-${idx}`}
              className={`relative rounded-3xl p-7 ${
                idx === 1
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card border border-border'
              }`}
            >
              <div className="flex items-center gap-1 mb-5">
                {[...Array(t.rating)].map((_, i) => (
                  <Star
                    key={i}
                    className={`h-4 w-4 ${
                      idx === 1
                        ? 'fill-accent text-accent'
                        : 'fill-[hsl(82_76%_45%)] text-[hsl(82_76%_45%)]'
                    }`}
                  />
                ))}
              </div>
              <blockquote
                className="text-base md:text-lg leading-relaxed font-medium"
                style={{ letterSpacing: '-0.015em' }}
              >
                &ldquo;{t.quote}&rdquo;
              </blockquote>
              <figcaption className={`mt-7 pt-5 border-t ${idx === 1 ? 'border-white/15' : 'border-border'}`}>
                <div className="flex items-center gap-3">
                  <div
                    className={`h-10 w-10 rounded-full flex items-center justify-center text-xs font-bold ${
                      idx === 1
                        ? 'bg-accent text-accent-foreground'
                        : 'bg-primary/10 text-primary'
                    }`}
                  >
                    {t.author
                      .split(/\s+/)
                      .map((p) => p[0])
                      .filter((c) => c.match(/[A-Z]/i))
                      .slice(0, 2)
                      .join('')}
                  </div>
                  <div>
                    <div className="text-sm font-bold">{t.author}</div>
                    <div className={`text-xs ${idx === 1 ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                      {[t.role, t.company].filter(Boolean).join(', ')}
                    </div>
                  </div>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
