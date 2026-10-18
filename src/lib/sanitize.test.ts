import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTextEntities, sanitizeRichHtml } from './sanitize';

test('an imported <h1> becomes a <h2> (the page title is the only h1)', () => {
  assert.equal(sanitizeRichHtml('<h1 class="x">Agilent 1200</h1><p>Pump</p>'), '<h2 class="x">Agilent 1200</h2><p>Pump</p>');
  assert.equal(sanitizeRichHtml('<h2>Specs</h2>'), '<h2>Specs</h2>');
});

test('still strips scripts and handlers', () => {
  assert.equal(sanitizeRichHtml('<p onclick="x()">a</p><script>alert(1)</script>'), '<p>a</p>');
});

test('decodeTextEntities decodes text references and keeps markup ones', () => {
  assert.equal(decodeTextEntities('<p>GCMS &#8211; 6890N, 1.8&#8243; &deg;C &ndash; &#x2013;</p>'), '<p>GCMS – 6890N, 1.8″ °C – –</p>');
  // Markup-significant and spacing references stay encoded: the HTML means the same.
  assert.equal(decodeTextEntities('a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39; &#60; &nbsp;e'), 'a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39; &#60; &nbsp;e');
  // Unknown names are left as written; plain text with "&" is untouched.
  assert.equal(decodeTextEntities('R&D &madeup; AT&T'), 'R&D &madeup; AT&T');
  // Idempotent.
  const once = decodeTextEntities('x &#8211; y');
  assert.equal(decodeTextEntities(once), once);
});
