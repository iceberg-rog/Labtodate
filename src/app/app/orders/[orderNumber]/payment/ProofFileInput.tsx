'use client';

import { useState } from 'react';

const MAX_BYTES = 8_000_000; // keep in sync with buyerSubmitPaymentProof

/**
 * Receipt picker that enforces the advertised 8 MB limit in the browser, so an
 * oversized scan is caught before upload with a clear message (the server
 * re-checks; this just avoids a wasted upload and the request-size limit).
 */
export function ProofFileInput() {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <input
        type="file"
        name="proof"
        accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
        className="block mx-auto text-sm"
        onChange={(e) => {
          const input = e.currentTarget;
          const f = input.files?.[0];
          const msg =
            f && f.size > MAX_BYTES
              ? `This file is ${(f.size / 1_000_000).toFixed(1)} MB — the limit is 8 MB. Please upload a smaller scan or photo.`
              : '';
          // setCustomValidity blocks the submit with the browser's own bubble.
          input.setCustomValidity(msg);
          setError(msg || null);
        }}
      />
      {error && (
        <p role="alert" className="text-xs font-semibold text-red-700 dark:text-red-300 mt-2">{error}</p>
      )}
    </>
  );
}
