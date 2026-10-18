import Link from 'next/link';
import type { PolicyBlock } from '@/lib/legal/policy-text';

/** Renders a legal text parsed by renderPolicyBlocks inside a LegalShell. */
export function PolicyText({ blocks, contact }: { blocks: PolicyBlock[]; contact: { href: string; label: string } }) {
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === 'h2' ? (
          <h2 key={i}>{b.parts.map((p) => ('text' in p ? p.text : '')).join('')}</h2>
        ) : (
          <p key={i}>
            {b.parts.map((p, j) =>
              'contact' in p ? (
                <a key={j} href={contact.href}>
                  {contact.label}
                </a>
              ) : 'href' in p ? (
                <Link key={j} href={p.href}>
                  {p.text}
                </Link>
              ) : (
                <span key={j}>{p.text}</span>
              ),
            )}
          </p>
        ),
      )}
    </>
  );
}
