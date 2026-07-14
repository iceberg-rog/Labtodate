type JsonLdData = Record<string, unknown> | Record<string, unknown>[];

/**
 * Emits a JSON-LD <script> for Google structured data (rich results). Server
 * component — drop it anywhere in a page's tree. The `<` escaping prevents the
 * serialized JSON from ever breaking out of the <script> element.
 *
 * Usage:
 *   <JsonLd data={{ '@context': 'https://schema.org', '@type': 'Product', … }} />
 */
export function JsonLd({ data }: { data: JsonLdData }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}
