/**
 * Blocking theme bootstrap, rendered in <head> so it runs before the body paints. The site is dark only (the owner
 * removed the light mode): it sets the `.dark` class up front and clears a light choice saved by an older visit.
 *
 * It also marks <html class="js">: the homepage stations are pinned scroll scenes only with scripts on (without them
 * they stack as plain sections).
 */
export function ThemeScript() {
  const js = `(function(){var e=document.documentElement;e.classList.add('js');e.classList.add('dark');e.style.colorScheme='dark';try{localStorage.removeItem('theme');}catch(x){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
}
