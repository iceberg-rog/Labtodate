import sanitizeHtml from 'sanitize-html';

/**
 * Allowlist-based HTML sanitizer for rich text that is rendered with
 * dangerouslySetInnerHTML. Covers two untrusted (or semi-trusted) sources:
 *   - Product descriptions imported as raw WooCommerce HTML from third-party
 *     shops, and seller-submitted descriptions.
 *   - Admin-authored blog / wiki / case-study bodies (defence in depth against
 *     a compromised author account).
 *
 * Strips <script>, event-handler attributes (onerror/onload/…), <iframe>,
 * <object>, <form>, and javascript:/data: URLs on links — the vectors that
 * turn stored HTML into stored XSS. Keeps ordinary formatting, tables, images
 * and safe links.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'pre', 'code', 'span', 'div',
    'strong', 'b', 'em', 'i', 'u', 's', 'small', 'mark', 'sub', 'sup',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'a', 'img', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
    col: ['span'],
    '*': ['class'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  // Force safe rel/target on every link so sanitized content can't tabnab.
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'nofollow noopener noreferrer', target: '_blank' }),
  },
  disallowedTagsMode: 'discard',
};

export function sanitizeRichHtml(dirty: string | null | undefined): string {
  if (!dirty) return '';
  return sanitizeHtml(dirty, OPTIONS);
}
