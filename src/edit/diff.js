// @ts-check
// A tiny dependency-free line diff (LCS) → a unified-style hunk string, for the
// `--diff` preview on edits. Zero runtime deps (the project invariant); good
// enough for the small, localized changes coir's edits produce.

/**
 * Longest-common-subsequence over two line arrays → for each line a tag:
 * ' ' common, '-' removed (in a only), '+' added (in b only).
 * @param {string[]} a @param {string[]} b
 * @returns {Array<{tag:string, text:string}>}
 */
function lcsLines(a, b) {
  const m = a.length, n = b.length;
  // DP table of LCS lengths (m+1 × n+1). Fine for the file sizes coir edits.
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ tag: ' ', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ tag: '-', text: a[i] }); i++; }
    else { out.push({ tag: '+', text: b[j] }); j++; }
  }
  while (i < m) out.push({ tag: '-', text: a[i++] });
  while (j < n) out.push({ tag: '+', text: b[j++] });
  return out;
}

/**
 * A unified-ish diff of two texts: only changed regions, with `context` lines
 * around each. Returns '' when identical. Line counts in the hunk header are
 * 1-based old/new starts.
 * @param {string} oldText @param {string} newText
 * @param {{context?:number}} [opts]
 * @returns {string}
 */
export function unifiedDiff(oldText, newText, { context = 2 } = {}) {
  if (oldText === newText) return '';
  const a = oldText.split('\n'), b = newText.split('\n');
  const d = lcsLines(a, b);
  // Find changed spans (runs containing a +/-), expanded by `context` common lines.
  const keep = new Array(d.length).fill(false);
  for (let i = 0; i < d.length; i++) {
    if (d[i].tag !== ' ') {
      for (let k = Math.max(0, i - context); k <= Math.min(d.length - 1, i + context); k++) keep[k] = true;
    }
  }
  const lines = [];
  let oi = 0, ni = 0;       // 0-based positions in a / b as we walk d
  let hunk = null;          // { oStart, nStart, body:[] }
  const flush = () => {
    if (!hunk) return;
    lines.push(`@@ -${hunk.oStart + 1} +${hunk.nStart + 1} @@`);
    lines.push(...hunk.body);
    hunk = null;
  };
  for (let i = 0; i < d.length; i++) {
    const { tag, text } = d[i];
    if (keep[i]) {
      if (!hunk) hunk = { oStart: oi, nStart: ni, body: [] };
      hunk.body.push(`${tag}${text}`);
    } else {
      flush();
    }
    if (tag !== '+') oi++;
    if (tag !== '-') ni++;
  }
  flush();
  return lines.join('\n');
}
