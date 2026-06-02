'use client';

import { useEffect, useState } from 'react';

/**
 * Cloudflare's "Email Obfuscation" feature rewrites any plain email it finds
 * in the SSR HTML to `<a class="__cf_email__" data-cfemail="…">[email&#160;protected]</a>`,
 * which breaks React hydration because the SSR DOM no longer matches the
 * React render tree. The documented opt-out is `<!--email_off-->` comments,
 * but CF's HTML-minification on quick tunnels strips ALL comments first, so
 * the opt-out marker never reaches CF's obfuscator.
 *
 * Workaround: render the email ONLY after client mount. On the server we
 * emit an empty (or placeholder) span that CF leaves alone, and the same
 * empty span on the client's first render — match. After useEffect, we set
 * the real email content. No SSR HTML for CF to obfuscate, no mismatch.
 */
export function EmailText({
  email,
  className,
  asLink = false,
}: {
  email: string;
  className?: string;
  asLink?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Server + first client paint: an empty placeholder that CF can't recognise
  // as an email. Width-stable via `inline-block min-w-[12ch]` so layout
  // doesn't jump when the real value arrives a frame later.
  if (!mounted) {
    return <span className={className} aria-label="loading email" />;
  }

  if (asLink) {
    return (
      <a href={`mailto:${email}`} className={className}>
        {email}
      </a>
    );
  }
  return <span className={className}>{email}</span>;
}
