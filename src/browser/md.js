// A tiny, dependency-free Markdown→HTML renderer — JUST the subset the in-app
// help uses: `### headings`, `- lists`, paragraphs, `**bold**`, `` `code` ``,
// ```fenced``` code, and `[links](url)`. Inline raw HTML passes through (so
// `<kbd>Tab</kbd>` works) — the help content is OUR trusted .md bundled at build
// time, so inline HTML isn't sanitised (don't feed this user input). Output maps
// onto the existing `.help-body` CSS (h3/p/ul/li/code/kbd/pre/a).
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const NUL = '\x00';

// Inline: code spans (escaped) → bold → links; everything else (incl. raw <kbd>)
// is left untouched. Code is stashed behind a NUL sentinel so its contents aren't
// re-processed and a bare number in prose can't be mistaken for a placeholder.
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(`<code>${esc(c)}</code>`); return NUL + (codes.length - 1) + NUL; });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => `<a href="${esc(h)}" target="_blank" rel="noopener">${t}</a>`);
  return s.replace(/\x00(\d+)\x00/g, (_, i) => codes[+i]);
}

export function mdToHtml(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) { // fenced code (contents escaped, verbatim)
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      out.push(`<pre>${esc(buf.join('\n'))}</pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/); // heading
    if (h) { const n = Math.min(6, h[1].length); out.push(`<h${n}>${inline(h[2].trim())}</h${n}>`); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) { // bullet list (consecutive items)
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`); i++; }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    const para = []; // paragraph (until a blank line or the next block)
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*[-*]\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('');
}
