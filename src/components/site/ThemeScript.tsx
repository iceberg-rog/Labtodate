/**
 * Blocking, no-flash theme bootstrap. Rendered in <head> so it runs before the
 * body paints: it resolves the saved preference (localStorage 'theme') or the
 * OS setting and toggles the `.dark` class on <html> up-front. Without this the
 * page would paint light first, then flip to dark on hydration (FOUC).
 *
 * Kept dependency-free and inline; the matching runtime toggle lives in
 * ThemeToggle.tsx.
 */
export function ThemeScript() {
  const js = `(function(){try{var t=localStorage.getItem('theme');var m=window.matchMedia('(prefers-color-scheme: dark)').matches;var d=t==='dark'||(t!=='light'&&m);var e=document.documentElement;e.classList.toggle('dark',d);e.style.colorScheme=d?'dark':'light';}catch(e){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
}
