import type { TermsBlock } from '@/lib/catalog/texts';

/**
 * A supplier-programme text from Admin → Settings → Suppliers (headings and
 * paragraphs, {CONTACT} as a link). `compact` renders it inside panel cards
 * instead of a legal page.
 */
export function ProgrammeText({
  blocks,
  contactHref,
  contactLabel,
  compact = false,
}: {
  blocks: TermsBlock[];
  contactHref: string;
  contactLabel: string;
  compact?: boolean;
}) {
  return (
    <>
      {blocks.map((b, i) => {
        const parts = b.parts.map((part, j) =>
          'contact' in part ? (
            <a key={j} href={contactHref} className={compact ? 'font-semibold text-primary hover:underline' : undefined}>
              {contactLabel}
            </a>
          ) : (
            <span key={j}>{part.text}</span>
          ),
        );
        if (b.kind === 'h2') return compact ? <p key={i} className="font-semibold mt-3 first:mt-0">{parts}</p> : <h2 key={i}>{parts}</h2>;
        return <p key={i} className={compact ? 'mt-1 text-muted-foreground' : undefined}>{parts}</p>;
      })}
    </>
  );
}
