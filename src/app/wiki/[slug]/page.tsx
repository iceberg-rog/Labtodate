import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { slug: string } }) {
  const article = await prisma.wikiArticle.findUnique({ where: { slug: params.slug } });
  return { title: article?.title ?? 'Not found' };
}

export default async function WikiArticlePage({ params }: { params: { slug: string } }) {
  const article = await prisma.wikiArticle.findUnique({
    where: { slug: params.slug },
    include: { author: { select: { name: true } } },
  });
  if (!article || article.status !== 'PUBLISHED') notFound();

  return (
    <article className="container-px py-12 max-w-3xl mx-auto">
      <Link href="/wiki" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6">
        <ChevronLeft className="h-4 w-4" /> Back to wiki
      </Link>
      {article.category && <Badge variant="accent">{article.category}</Badge>}
      <h1 className="text-4xl md:text-5xl font-bold tracking-tight mt-4" style={{ letterSpacing: '-0.035em' }}>
        {article.title}
      </h1>
      <p className="mt-4 text-sm text-muted-foreground">By {article.author.name}</p>
      <div className="prose-article mt-10 text-foreground" dangerouslySetInnerHTML={{ __html: article.body }} />
    </article>
  );
}
