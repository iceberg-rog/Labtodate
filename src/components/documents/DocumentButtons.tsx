import { Download, ExternalLink } from 'lucide-react';
import { documentHref, type DocKind } from '@/lib/documents';

/**
 * "Download PDF" (+ "Preview") for an order's proforma invoice / invoice.
 * Plain links to the auth-checked document routes — the PDF is generated on
 * the server from the document template, never by printing a website page.
 */
export function DocumentButtons({
  kind,
  orderNumber,
  size = 'md',
  label,
  preview = true,
}: {
  kind: DocKind;
  orderNumber: string;
  size?: 'sm' | 'md';
  /** Defaults to "Download PDF". */
  label?: string;
  preview?: boolean;
}) {
  const sm = size === 'sm';
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <a
        href={documentHref(kind, orderNumber, 'pdf')}
        data-doc={`${kind}-pdf`}
        className={
          sm
            ? 'inline-flex items-center gap-1 h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90'
            : 'inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:bg-primary/90 shadow-sm'
        }
      >
        <Download className={sm ? 'h-3.5 w-3.5' : 'h-4 w-4'} /> {label ?? 'Download PDF'}
      </a>
      {preview && (
        <a
          href={documentHref(kind, orderNumber, 'preview')}
          target="_blank"
          rel="noopener"
          data-doc={`${kind}-preview`}
          className={
            sm
              ? 'inline-flex items-center gap-1 h-8 px-3 rounded-full border border-border text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted'
              : 'inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground hover:bg-muted'
          }
        >
          <ExternalLink className={sm ? 'h-3.5 w-3.5' : 'h-4 w-4'} /> Preview
        </a>
      )}
    </span>
  );
}
