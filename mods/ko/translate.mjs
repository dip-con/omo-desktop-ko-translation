// Pure text rule for the ko mod. An exact registered string wins. Otherwise the first pattern in object order that
// matches the whole text supplies the translation, with $1..$9 taken from its capture groups (same semantics as
// the ko dictionary checks). Leading and trailing whitespace is kept. Unregistered text, and text longer than
// MAX_PATTERN_TEXT characters for patterns, comes back unchanged. An invalid pattern is skipped and reported by
// invalidPatterns; it never throws.
export const MAX_PATTERN_TEXT = 300;
const compiled = new WeakMap();

function compile(patterns) {
  if (patterns === undefined || patterns === null) return { rules: [], invalid: [] };
  let c = compiled.get(patterns);
  if (c === undefined) {
    const rules = [];
    const invalid = [];
    for (const [source, tpl] of Object.entries(patterns)) {
      try {
        rules.push({ rx: new RegExp(source), tpl });
      } catch {
        invalid.push(source);
      }
    }
    c = { rules, invalid };
    compiled.set(patterns, c);
  }
  return c;
}

export function invalidPatterns(patterns) {
  return [...compile(patterns).invalid];
}

export function translateText(text, entries, patterns) {
  const lead = /^\s*/.exec(text)[0];
  const rest = text.slice(lead.length);
  const core = rest.trimEnd();
  if (core === '') return text;
  const trail = rest.slice(core.length);
  if (Object.hasOwn(entries, core)) return lead + entries[core] + trail;
  if (core.length > MAX_PATTERN_TEXT) return text;
  for (const { rx, tpl } of compile(patterns).rules) {
    const m = rx.exec(core);
    if (m !== null && m[0] === core) return lead + core.replace(rx, tpl) + trail;
  }
  return text;
}
