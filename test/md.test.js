// The tiny Markdown→HTML renderer for the in-app help (src/browser/md.js) —
// pure (no DOM), so it runs under node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdToHtml } from '../src/browser/md.js';

test('mdToHtml: headings / lists / bold / code / links / fenced / raw <kbd>', () => {
  assert.match(mdToHtml('### Hi'), /^<h3>Hi<\/h3>$/);
  assert.match(mdToHtml('- a\n- b'), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(mdToHtml('a **bold** b'), /<p>a <b>bold<\/b> b<\/p>/);
  assert.match(mdToHtml('use `code`'), /<code>code<\/code>/);
  assert.match(mdToHtml('[t](http://x)'), /<a href="http:\/\/x" target="_blank" rel="noopener">t<\/a>/);
  // fenced code: escaped + verbatim
  assert.match(mdToHtml('```\ncurl <x> | sh\n```'), /<pre>curl &lt;x&gt; \| sh<\/pre>/);
});

test('mdToHtml: raw <kbd> passes through, and a bare number is NOT mistaken for a code placeholder', () => {
  const html = mdToHtml('press <kbd>Tab</kbd> 5 times `x`');
  assert.match(html, /<kbd>Tab<\/kbd> 5 times <code>x<\/code>/); // <kbd> intact, " 5 " survives, code restored
});
