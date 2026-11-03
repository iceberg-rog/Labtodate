'use client';

import { useEffect, useState } from 'react';

const DEFAULT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

/**
 * A moment shown in the READER's own time zone.
 *
 * toLocaleString() in a server component formats in the SERVER's zone, which
 * is UTC here — so an admin read 01:48 PM for the very message a buyer read as
 * 02:48 PM in Amsterdam, and the two sides disagreed about when anything had
 * been said. The buyer-facing thread is a client component and was already
 * correct; this makes the server-rendered screens agree with it.
 *
 * First paint keeps the server's UTC string so the markup hydrates without a
 * mismatch, then the reader's real zone replaces it on mount.
 */
export function LocalTime({
  iso,
  options,
}: {
  iso: string;
  options?: Intl.DateTimeFormatOptions;
}) {
  const opts = options ?? DEFAULT;
  const key = JSON.stringify(opts);
  const [text, setText] = useState(() =>
    new Date(iso).toLocaleString('en-US', { ...opts, timeZone: 'UTC' }),
  );
  useEffect(() => {
    setText(new Date(iso).toLocaleString('en-US', JSON.parse(key) as Intl.DateTimeFormatOptions));
  }, [iso, key]);
  return <time dateTime={iso}>{text}</time>;
}
