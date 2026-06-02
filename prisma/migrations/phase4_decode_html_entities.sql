-- Phase 4 cleanup: decode the HTML entities that bled into product titles
-- during the original import (e.g. "Varian 240FS &#8211; AAS" should render
-- as "Varian 240FS – AAS"). Same treatment for summary/description, brand
-- names, category names — any user-visible text field.
--
-- Restricted to the common entities we actually see in the data; adding more
-- is safe (no-op if the substring isn't present).

DO $$
DECLARE
  tbl text;
  col text;
BEGIN
  FOR tbl, col IN VALUES
    ('Product',  'title'),
    ('Product',  'summary'),
    ('Product',  'description'),
    ('Brand',    'name'),
    ('Category', 'name'),
    ('Category', 'description'),
    ('Company',  'name'),
    ('Company',  'description'),
    ('BlogPost', 'title'),
    ('BlogPost', 'excerpt')
  LOOP
    EXECUTE format($f$
      UPDATE %1$I
      SET %2$I = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                 %2$I,
                 '&#8211;', E'–'),
                 '&#8212;', E'—'),
                 '&#8216;', E'‘'),
                 '&#8217;', E'’'),
                 '&#8220;', E'“'),
                 '&#8221;', E'”'),
                 '&#8230;', E'…'),
                 '&#038;',  '&'),
                 '&#39;',   ''''),
                 '&#xa0;',  ' '),
                 '&nbsp;',  ' '),
                 '&amp;',   '&'),
                 '&quot;',  '"'),
                 '&apos;',  ''''),
                 '&lt;',    '<'),
                 '&gt;',    '>'),
                 '&ndash;', E'–'),
                 '&mdash;', E'—'),
                 '&ldquo;', E'“'),
                 '&rdquo;', E'”')
      WHERE %2$I IS NOT NULL AND %2$I ~ '&[#a-zA-Z0-9]+;'
    $f$, tbl, col);
  END LOOP;
END $$;
