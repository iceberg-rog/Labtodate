import { escapeHtml } from '@/lib/email-html';
import { settingString } from '@/lib/settings';

/**
 * An e-mail / page text from the settings (Settings → Email texts) with its
 * {PLACEHOLDERS} filled. Returns plain text and HTML (the template and every
 * value escaped; values in bold). Unknown placeholders stay visible.
 */
export function settingText(key: string, vars: Record<string, string>, bold: string[] = []): { text: string; html: string } {
  const tpl = settingString(key);
  const text = tpl.replace(/\{([A-Z_]+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
  const html = escapeHtml(tpl).replace(/\{([A-Z_]+)\}/g, (m, k: string) => {
    if (!(k in vars)) return m;
    const v = escapeHtml(vars[k]);
    return bold.includes(k) ? `<strong>${v}</strong>` : v;
  });
  return { text, html };
}
