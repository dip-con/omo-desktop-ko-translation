// Pure text rule: an exact entry wins; otherwise the first pattern (object order) that matches the whole text,
// with $1..$9 from its capture groups. Surrounding whitespace is kept. Text longer than MAX_PATTERN_TEXT skips
// patterns. Unknown text comes back unchanged. An invalid pattern is skipped (see invalidPatterns), never thrown.
export const MAX_PATTERN_TEXT = 300;
const compiled = new WeakMap();

function compile(patterns) {
  let c = compiled.get(patterns);
  if (c === undefined) {
    c = { rules: [], invalid: [] };
    for (const [source, tpl] of Object.entries(patterns)) {
      try {
        c.rules.push({ rx: new RegExp(source), tpl });
      } catch {
        c.invalid.push(source);
      }
    }
    compiled.set(patterns, c);
  }
  return c;
}

export const invalidPatterns = (patterns = {}) => [...compile(patterns).invalid];

export function translateText(text, entries, patterns = {}) {
  const lead = /^\s*/.exec(text)[0];
  const core = text.slice(lead.length).trimEnd();
  if (core === '') return text;
  const trail = text.slice(lead.length + core.length);
  if (Object.hasOwn(entries, core)) return lead + entries[core] + trail;
  if (core.length > MAX_PATTERN_TEXT) return text;
  for (const { rx, tpl } of compile(patterns).rules) {
    const m = rx.exec(core);
    if (m !== null && m[0] === core) return lead + core.replace(rx, tpl) + trail;
  }
  return text;
}
