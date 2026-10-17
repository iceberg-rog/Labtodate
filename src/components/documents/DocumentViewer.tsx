import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { documentHref, type DocKind } from '@/lib/documents';
import { DocumentButtons } from './DocumentButtons';

/**
 * Page shell for viewing a document: back link, title, "Download PDF" /
 * "Preview", and the document itself in a sandboxed frame. The frame shows the
 * clean document route (its own HTML page) — so what you see is exactly the
 * PDF, and the website's header/footer can never end up inside the document.
 */
export function DocumentViewer({
  kind,
  orderNumber,
  title,
  number,
  backHref,
  backLabel,
  children,
}: {
  kind: DocKind;
  orderNumber: string;
  title: string;
  number: string;
  backHref: string;
  backLabel: string;
  /** Status banners shown above the document. */
  children?: React.ReactNode;
}) {
  return (
    <div className="container-px py-8 max-w-4xl mx-auto">
      <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ChevronLeft className="h-4 w-4" /> {backLabel}
      </Link>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <p className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground">{title}</p>
          <h1 className="text-2xl font-bold font-mono mt-0.5">{number}</h1>
        </div>
        <DocumentButtons kind={kind} orderNumber={orderNumber} />
      </div>
      {children}
      <iframe
        title={`${title} ${number}`}
        src={documentHref(kind, orderNumber, 'preview')}
        sandbox=""
        className="w-full h-[1180px] rounded-2xl border border-border bg-white"
      />
    </div>
  );
}
