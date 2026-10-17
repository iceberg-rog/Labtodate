/**
 * Blocking, no-flash theme bootstrap. Rendered in <head> so it runs before the
 * body paints: it resolves the saved preference (localStorage 'theme'), else
 * the admin default (Settings → Brand → THEME_DEFAULT: dark | light | system),
 * and toggles the `.dark` class on <html> up-front. Without this the page
 * would paint one theme first, then flip on hydration (FOUC).
 *
 * It also marks <html class="js">: the homepage stations are pinned scroll
 * scenes only with scripts on (without them they stack as plain sections).
 *
 * Kept dependency-free and inline; the matching runtime toggle lives in
 * ThemeToggle.tsx.
 */
export function ThemeScript({ fallback = 'dark' }: { fallback?: string }) {
  const def = fallback === 'light' || fallback === 'system' ? fallback : 'dark';
  const js = `(function(){document.documentElement.classList.add('js');try{var t=localStorage.getItem('theme');var f=${JSON.stringify(def)};var d=t==='dark'||(t!=='light'&&(f==='dark'||(f==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches)));var e=document.documentElement;e.classList.toggle('dark',d);e.style.colorScheme=d?'dark':'light';}catch(e){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
}
