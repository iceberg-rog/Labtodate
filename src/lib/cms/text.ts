import { escapeHtml } from '@/lib/email-html';

/**
 * The text format of every admin-editable text (document texts, e-mail bodies,
 * site texts). It is deliberately tiny so nothing typed in the admin can ever
 * become code:
 *
 *   {{customer.name}}   a placeholder from the list the editor offers
 *   **bold**            bold
 *   - item              a bullet list (lines starting with "- ")
 *   blank line          new paragraph; a single line break stays a line break
 *
 * Everything else is shown literally: "<b>" prints as the characters < b >.
 * Values substituted for placeholders are escaped as well.
 *
 * Site texts (not documents or e-mails) may also use links, when the caller
 * turns them on with `links: true`:
 *
 *   [Sell equipment](/sell)   a link to a page of the site, an e-mail
 *                             (mailto:…), a phone (tel:…) or https://…
 *
 * and "link fields" (`linkVars`): a placeholder such as {{support.contact}}
 * that renders as a ready link (the support e-mail, or the contact page).
 */

export type Vars = Record<string, string | number | null | undefined>;

/** A placeholder that renders as a link in rich text (its plain value is the label). */
export interface LinkValue {
  href: string;
  label: string;
}

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)\s*\}\}/gi;
const LINK = /\[([^\]\n]+)\]\(([^()\s]+)\)/g;

/**
 * A link target typed in a text, or null when it is not allowed: only paths of
 * this site ("/sell", not "//host"), "#anchors", mailto:, tel: and http(s)://.
 */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (!h || /[\\\s<>"'`*]/.test(h)) return null;
  if (/^\/(?!\/)/.test(h) || /^#[\w-]*$/.test(h)) return h;
  if (/^mailto:[^@]+@[^@]+\.[^@]+$/i.test(h)) return h;
  if (/^tel:\+?[0-9()-]+$/i.test(h)) return h;
  if (/^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(h)) return h;
  return null;
}

/** "[label](target)" → "label" (plain-text use of a text that may hold links). */
export function stripLinks(text: string): string {
  return text.replace(LINK, '$1');
}

/** Every placeholder name used in a text, in order, without duplicates. */
export function placeholdersIn(text: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const m of (text ?? '').matchAll(PLACEHOLDER)) out.add(m[1].toLowerCase());
  return [...out];
}

/** Placeholders in `text` that are not in `allowed` (misspelt or unknown). */
export function unknownPlaceholders(text: string | null | undefined, allowed: Iterable<string>): string[] {
  const ok = new Set([...allowed].map((a) => a.toLowerCase()));
  return placeholdersIn(text).filter((p) => !ok.has(p));
}

/** Stray "{{" or "}}" that will not be recognised as a placeholder. */
export function hasBrokenPlaceholder(text: string | null | undefined): boolean {
  const stripped = (text ?? '').replace(PLACEHOLDER, '');
  return stripped.includes('{{') || stripped.includes('}}');
}

function valueOf(vars: Vars, name: string): string {
  const v = vars[name.toLowerCase()];
  return v === null || v === undefined ? '' : String(v);
}

/** Plain-text fill (subjects, single-line labels, the text part of e-mails). */
export function fillPlain(text: string | null | undefined, vars: Vars): string {
  return (text ?? '').replace(PLACEHOLDER, (_, name: string) => valueOf(vars, name));
}

interface InlineOpts {
  links?: boolean;
  linkVars?: Record<string, LinkValue>;
}
interface InlineState {
  hadText: boolean;
  hadValue: boolean;
}

/** Escaped text with its placeholders filled (link fields become links). */
function textHtml(segment: string, vars: Vars, linkVars: Record<string, LinkValue> | undefined, st: InlineState): string {
  const parts: string[] = [];
  let last = 0;
  for (const m of segment.matchAll(PLACEHOLDER)) {
    const before = segment.slice(last, m.index);
    if (before.trim()) st.hadText = true;
    parts.push(escapeHtml(before));
    const link = linkVars?.[m[1].toLowerCase()];
    const href = link ? safeHref(link.href) : null;
    if (link && link.label.trim()) {
      st.hadValue = true;
      parts.push(href ? `<a href="${escapeHtml(href)}">${escapeHtml(link.label)}</a>` : escapeHtml(link.label));
    } else {
      const value = valueOf(vars, m[1]);
      if (value.trim()) st.hadValue = true;
      parts.push(escapeHtml(value).replace(/\r\n?|\n/g, '<br>'));
    }
    last = (m.index ?? 0) + m[0].length;
  }
  const rest = segment.slice(last);
  if (rest.trim()) st.hadText = true;
  parts.push(escapeHtml(rest));
  return parts.join('');
}

/** Inline HTML for one line: escaped text, placeholders, **bold** (and links when allowed). */
function inlineHtml(line: string, vars: Vars, opts: InlineOpts = {}): { html: string; onlyEmptyPlaceholders: boolean } {
  const st: InlineState = { hadText: false, hadValue: false };
  let html = '';
  if (opts.links) {
    let last = 0;
    for (const m of line.matchAll(LINK)) {
      html += textHtml(line.slice(last, m.index), vars, opts.linkVars, st);
      // The label is text only (no link fields inside a link).
      const label = textHtml(m[1], vars, undefined, st);
      const href = safeHref(fillPlain(m[2], vars));
      html += href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
      last = (m.index ?? 0) + m[0].length;
    }
    html += textHtml(line.slice(last), vars, opts.linkVars, st);
  } else {
    html = textHtml(line, vars, opts.linkVars, st);
  }
  // **bold** — applied after escaping; "*" is not an escaped character (and
  // never part of an allowed link target).
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const usedPlaceholders = line.match(PLACEHOLDER) !== null;
  return { html, onlyEmptyPlaceholders: usedPlaceholders && !st.hadText && !st.hadValue };
}

/**
 * Rich text → HTML (paragraphs, line breaks, bullet lists, bold). A paragraph
 * made only of placeholders that are all empty is dropped, so an optional
 * value never leaves an empty line behind.
 */
export function fillRich(
  text: string | null | undefined,
  vars: Vars,
  style: { p?: string; ul?: string; li?: string; headings?: boolean } & InlineOpts = {},
): string {
  const src = (text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!src) return '';
  const inline: InlineOpts = { links: style.links, linkVars: style.linkVars };
  const pStyle = style.p ? ` style="${style.p}"` : '';
  const ulStyle = style.ul ? ` style="${style.ul}"` : '';
  const liStyle = style.li ? ` style="${style.li}"` : '';
  const blocks = src.split(/\n\s*\n/);
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    let para: string[] = [];
    let list: string[] = [];
    const flushPara = () => {
      if (para.length) out.push(`<p${pStyle}>${para.join('<br>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list.length) out.push(`<ul${ulStyle}>${list.map((li) => `<li${liStyle}>${li}</li>`).join('')}</ul>`);
      list = [];
    };
    for (const raw of lines) {
      // Pages (Terms, FAQ…) may use "## Heading" / "### Sub-heading" lines.
      const heading = style.headings ? /^(#{2,3})\s+(.*)$/.exec(raw) : null;
      if (heading) {
        flushPara();
        flushList();
        const tag = heading[1].length === 2 ? 'h2' : 'h3';
        out.push(`<${tag}>${inlineHtml(heading[2], vars, inline).html}</${tag}>`);
        continue;
      }
      const bullet = /^\s*[-•]\s+(.*)$/.exec(raw);
      const { html, onlyEmptyPlaceholders } = inlineHtml(bullet ? bullet[1] : raw, vars, inline);
      if (onlyEmptyPlaceholders) continue;
      if (bullet) {
        flushPara();
        list.push(html);
      } else {
        flushList();
        para.push(html);
      }
    }
    flushPara();
    flushList();
  }
  return out.join('');
}

/** Rich text → plain text for the text/plain part of an e-mail. */
export function fillRichPlain(text: string | null | undefined, vars: Vars): string {
  return fillPlain(text, vars)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^\s*•\s+/gm, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Validate an admin-entered text against the placeholders allowed in that
 * spot. Returns readable problems (empty = fine).
 */
export function checkText(label: string, text: string | null | undefined, allowed: Iterable<string>, opts: { required?: boolean; max?: number } = {}): string[] {
  const problems: string[] = [];
  const value = text ?? '';
  if (opts.required && !value.trim()) problems.push(`${label}: cannot be empty.`);
  if (opts.max && value.length > opts.max) problems.push(`${label}: at most ${opts.max} characters (now ${value.length}).`);
  const unknown = unknownPlaceholders(value, allowed);
  if (unknown.length) problems.push(`${label}: unknown field${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `{{${u}}}`).join(', ')}. Use "Insert field" to pick one.`);
  if (hasBrokenPlaceholder(value)) problems.push(`${label}: a field is not closed — write it as {{field.name}}.`);
  return problems;
}

/**
 * Links in a text that allows them: every "[label](target)" must point to a
 * page of this site (/…), an e-mail (mailto:…), a phone (tel:…) or https://….
 * A target may start with a field (e.g. {{site.url}}/sell or mailto:{{support.email}}).
 */
export function checkLinks(label: string, text: string | null | undefined): string[] {
  const problems: string[] = [];
  for (const m of (text ?? '').matchAll(LINK)) {
    const target = m[2];
    const ok = placeholdersIn(target).length
      ? /^(\{\{|\/(?!\/)|#|mailto:|tel:|https?:\/\/)/i.test(target)
      : safeHref(target) !== null;
    if (!ok) problems.push(`${label}: the link “${m[0]}” must point to a page of this site (/…), an e-mail (mailto:…), a phone (tel:…) or a web address (https://…).`);
  }
  return problems;
}
