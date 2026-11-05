#!/usr/bin/env node
// Measures the ko mod over the app snapshots in fixtures/live (gitignored). Each screen is loaded into headless Chrome
// (tools/chrome.mjs), mods/ko/page.js runs with its bridge served by mods/ko/host.mjs, and the text nodes that
// contain Latin letters outside the exclusion zones and keep-english are counted before and after.
// Two ratios per screen. strictRatio counts every such node. The gated ratio, which the gate uses, leaves out nodes
// that are not human-language (nonLinguisticClass), nodes in DATA_REGION_SELECTORS (user-authored skill text) and
// nodes in KEYCAP_REGION_SELECTORS (key chips) and nodes in THREAD_CONTENT_SELECTORS (the owner's own session content).
// Every removed string is written to data-rule-removed.json and to its screen's excluded list, each with the rule that removed it.
// Attach mode (--cdp-port, --base-url) measures a window that is already open: there a candidate that already holds Hangul
// counts as translated and shows the mod at work for the on-pass check, home is skipped unless --screens names it, a base
// url that routes in its hash is never navigated, and every string the run writes or prints goes through tools/redact.mjs.
// Usage: node tools/coverage.mjs --out <dir> [--captures <dir>]
// Exit 1 when a screen's gated ratio leaves more than 5% of its nodes in English, a settings screen is under 95%
// gated-translated, or a page script throws.
import { isEntry } from './is-entry.mjs';
import fs from 'node:fs';
import { importLoader } from './loader-import.mjs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const connect = async (...args) => (await importLoader('cdp.mjs')).connect(...args);
import { EXCLUSION_SELECTORS, handle, KEY_CHIP_SELECTORS } from '../mods/ko/host.mjs';
import { killChrome, launchChrome, removeTempDir } from './chrome.mjs';
// Pure redaction helpers for captured app DOM. No I/O.
// redactHtml replaces conversation titles, local paths, account identity and token-like strings
// with fixed markers and returns per-category counts. residualScan counts what is still visible.

const redactHtml = (() => {
const MARK = {
  path: '[redacted-path]',
  email: '[redacted-email]',
  token: '[redacted-token]',
  account: '[redacted]',
  title: '[redacted-title]',
};

// A path segment may contain one space followed by a non-space character ("내 작업"); Hangul is not excluded.
const SEG = String.raw`[^\\/\s"'<>&]`;
const WIN_PATH = new RegExp(String.raw`(?<![A-Za-z])[A-Za-z]:[\\/]+(?:(?:${SEG}|\s(?=${SEG}))+[\\/]*)*`, 'gu');
const standalone = (name) => new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
const UNIX_PATH = /\/(?:Users|home)\/[^\s"'<>&]*/g;
const REDACT_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const TOKENS = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
];
const ACCOUNT_ATTR = /(\s(?:data-)?(?:user|account|email|avatar|token|session|profile)[-\w]*\s*=\s*)("[^"]*"|'[^']*')/gi;
const AVATAR_IMG = /<img\b[^>]*>/gi;

// The sidebar drag key carries the project folder name after a [redacted-path] marker: redact the whole value.
const DRAG_KEY = /(\sdata-sidebar-project-drag-key\s*=\s*)("[^"]*"|'[^']*')/gi;

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function redactHtml(html, { title = '', projectName = '', userName = '' } = {}) {
  const counts = { path: 0, email: 0, token: 0, account: 0, avatarSrc: 0, title: 0, project: 0, user: 0, dragKey: 0 };
  let out = html;
  const bump = (k) => () => {
    counts[k] += 1;
    return MARK[k] ?? '[redacted]';
  };
  out = out.replace(DRAG_KEY, (_m, lead) => {
    counts.dragKey += 1;
    return `${lead}"${MARK.account}"`;
  });
  out = out.replace(WIN_PATH, bump('path'));
  out = out.replace(UNIX_PATH, bump('path'));
  if (projectName) out = out.replace(standalone(projectName), bump('project'));
  if (userName) out = out.replace(standalone(userName), bump('user'));
  out = out.replace(REDACT_EMAIL, bump('email'));
  for (const re of TOKENS) out = out.replace(re, bump('token'));
  out = out.replace(ACCOUNT_ATTR, (_m, lead) => {
    counts.account += 1;
    return `${lead}"${MARK.account}"`;
  });
  out = out.replace(AVATAR_IMG, (tag) => {
    if (!/avatar|profile|user/i.test(tag)) return tag;
    return tag.replace(/\ssrc\s*=\s*("[^"]*"|'[^']*')/gi, () => {
      counts.avatarSrc += 1;
      return ` src="${MARK.account}"`;
    });
  });
  const t = title.trim();
  if (t.length >= 2) {
    for (const needle of [t, escapeHtml(t)]) {
      const parts = out.split(needle);
      if (parts.length > 1) {
        counts.title += parts.length - 1;
        out = parts.join(MARK.title);
      }
    }
  }
  return { html: out, counts };
}

return redactHtml;
})();

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_UNTRANSLATED = 0.05;
const MIN_SETTINGS_TRANSLATED = 0.95;
const WAIT_MS = 20000;
const STRING_CAP = 200;
const CAPTURE_SCREENS = new Set(['home', 'settings/general', 'settings/appearance']);
const EXCL = EXCLUSION_SELECTORS.join(', ');

// The skill descriptions on settings/tools are text the user wrote for installed skills, not app copy. They have no
// stable id (ids are generated per render), so the marker is structural: the description span sits in a settings row
// whose h3 label starts with SKILL_LABEL_PREFIX. The structural selector alone also matches app-copy descriptions,
// so the label check is required. This is a weak marker, recorded as such in the DoneClaim.
export const DATA_REGION_SELECTORS = ['[data-slot="settings-row"] div.items-baseline > span.truncate'];
export const SKILL_LABEL_PREFIX = 'skill:';

// Key chips: every key cap in the app is a kbd element with data-slot="kbd" (188 on settings/keybindings).
// A word such as Home or Delete inside a key chip is a key name, not UI copy, so the chip is excluded from the gate.
export const KEYCAP_REGION_SELECTORS = KEY_CHIP_SELECTORS;

// Owner session content on home, excluded as one thread-content region. Each selector is one stable attribute:
//  - '[data-assistant-citation-source]': the body of every chat message on the thread, the owner's prompt and the reply (DONE).
//    It is on both roles; data-assistant-citation-role is on the user side only, so it missed the reply.
//  - '[data-live-activity-label]': the live line of a delegated run ('Ran Reply ... subagent'); the only one on home.
//  - '[data-base-ui-tooltip-trigger] > h1': the thread title in the header.
//  - '[data-sidebar-thread-title]': the thread title in the sidebar.
// Home chrome in the same timeline ('Work Log', 'Worked for 39s', 'Start a thread') carries none of these and stays counted.
export const THREAD_CONTENT_SELECTORS = ['[data-assistant-citation-source]', '[data-live-activity-label]', '[data-base-ui-tooltip-trigger] > h1', '[data-sidebar-thread-title]'];

// Non-linguistic values: numbers with units, versions, digits and punctuation, emails, urls, paths, redaction
// placeholders, key names, and ' · ' composites whose parts are all non-linguistic. Anything with an ordinary word is not matched.
const KEYCAPS = new Set(['Ctrl', 'Alt', 'Shift', 'Meta', 'Cmd', 'Win', 'Fn', 'Esc']);
const MODIFIERS = new Set(['Ctrl', 'Alt', 'Shift', 'Meta', 'Cmd', 'Win', 'Fn']);
// Words that are also ordinary UI words: they match only inside a combo with a modifier, or inside a key chip.
const KEY_WORDS = new Set(['Home', 'End', 'Delete', 'Space', 'Tab', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Insert',
  'Menu', 'Back', 'Backspace', 'PageUp', 'PageDown']);
const FUNCTION_KEY = /^F(?:[1-9]|1[0-2])$/;
const NUMBER_UNIT = /^[+-]?\d[\d,.]*\s*(?:[KMGT]?B|ms|s|px|fps|%)(?:\/s)?$/;
const VERSION = /^v?\d+(?:\.\d+)+(?:-[\w.]+)?(?:\s*·\s*PID\s+\d+)?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const WIN_PATH = /^[A-Za-z]:[\\/]\S*$/;
const POSIX_PATH = /^\/(?:[\w.~-]+\/)+[\w.~-]*$/;
const REDACTION = /^\[redacted(?:-[a-z]+)?\]$/;
const DIGITS = /^[\d\s.,:()[\]/%+-]+$/;

// A key name is a keycap when it is never an ordinary UI word (modifiers, Esc, F-keys), or a combo that has a modifier
// (Ctrl+Home, Shift+Tab, Ctrl+K). A bare ordinary word such as Home is not a keycap here.
function isKeycap(s) {
  if (KEYCAPS.has(s) || FUNCTION_KEY.test(s)) return true;
  const parts = s.split('+');
  const keyPart = (p) => KEYCAPS.has(p) || KEY_WORDS.has(p) || FUNCTION_KEY.test(p) || /^[A-Za-z0-9]$/.test(p);
  return parts.length > 1 && parts.some((p) => MODIFIERS.has(p)) && parts.every(keyPart);
}

// Provider ids and short codes shown on settings/models. The id is the non-linguistic part of a provider row; the display name
// (for example 'Routeway (routeway)') is product copy and stays counted. A new provider id shows up as a gate leftover.
const PROVIDER_IDS = new Set(['antigravity-ocx', 'openai-opencodex', 'commandcode', 'commandcode-anthropic', 'explabs', 'opencode',
  'opencode-go', 'ollama', 'ollama-local', 'orcarouter', 'routeway', 'nvidia', 'zai', 'CO', 'EX', 'OO']);
// A model id is a vendor/model handle (moonshotai/Kimi-K3) or one hyphenated handle with a digit (gpt-5.6-sol). A model list is model ids
// joined by ', ', with the ' · On' status suffix.
const MODEL_VENDOR = /^[A-Za-z][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MODEL_HANDLE = /^[A-Za-z][A-Za-z0-9.]*(?:-[A-Za-z0-9.:]+)+$/;
// A letter-only model id: lowercase letters, digits and hyphens, at least one letter and one hyphen (big-pickle, jev-latest).
// It counts only as a member of a comma-separated model list ending in ' · On', so a hyphenated word such as 'open-source' or 'open-source, read-only' stays counted.
const LETTER_MODEL_ID = /^(?=.*[a-z])[a-z0-9]+(?:-[a-z0-9]+)+$/;
// The model part of a vendor handle must hold a digit or a hyphen, so 'Read/s', 'and/or' and 'Input/Output' are not ids.
// Trade-off, decided: the shape is deliberately digit/hyphen based. A vendor handle whose model part is a bare lowercase word
// (thinkingmachines/inkling) stays counted by design: the only shape that excludes it would also exclude ordinary lowercase
// UI text such as true/false. Such a node shows as a small non-zero ratio on settings/models and is not a gate failure.
function isModelId(p) {
  if (MODEL_VENDOR.test(p)) return /[\d-]/.test(p.slice(p.indexOf('/') + 1));
  return MODEL_HANDLE.test(p) && /\d/.test(p);
}

// Package names on settings/open-source-licenses. Enumerated, not word-shaped: 'pele' and 'katex' have no separator, and a
// shape rule would also match English words such as 'hooks'. Each name is one the screen shows.
const PACKAGE_NAMES = new Set(['@types/trusted-types', 'dompurify', 'katex', 'mdast-util-math', 'micromark-extension-llm-math',
  'pele', 'remark-math', 'unist-util-remove-position']);
// License line: one SPDX id, or ids joined by ' AND ', optionally followed by ' · ' and a platform list ('Desktop, Web').
// 'KaTeX mathematical fonts' is not a license line and stays counted.
const SPDX_IDS = new Set(['ISC', 'MIT', 'OFL-1.1']);
const PLATFORMS = new Set(['Desktop', 'Web']);
function isLicenseLine(s) {
  const parts = s.split(' · ');
  if (parts.length === 1) return SPDX_IDS.has(s);
  if (parts.length !== 2) return false;
  return parts[0].split(' AND ').every((id) => SPDX_IDS.has(id)) && parts[1].split(', ').every((p) => PLATFORMS.has(p));
}
// Provider display name in the 'Name (provider-id)' shape. Only that shape is excluded: the trailing id must be one of
// PROVIDER_IDS. A name without such an id, for example 'Routeway (Provider API)', stays counted.
const PROVIDER_NAME = /^.+ \(([^()]+)\)$/;

// Returns the rule class that matches the text, or null when the text is human-language.
export function nonLinguisticClass(text) {
  const s = text.trim();
  if (s === '') return null;
  if (REDACTION.test(s)) return 'redaction';
  if (URL_RE.test(s)) return 'url';
  if (EMAIL.test(s)) return 'email';
  if (WIN_PATH.test(s) || POSIX_PATH.test(s)) return 'path';
  if (isKeycap(s)) return 'keycap';
  if (VERSION.test(s)) return 'version';
  if (NUMBER_UNIT.test(s)) return 'number-unit';
  if (/^·\s+\d+d$/.test(s)) return 'relative-timestamp';
  if (s === 'daily-normal') return 'model-profile-id';
  if (PROVIDER_IDS.has(s)) return 'provider-id';
  if (PACKAGE_NAMES.has(s)) return 'package-name';
  if (isLicenseLine(s)) return 'license-name';
  const named = PROVIDER_NAME.exec(s);
  if (named !== null && PROVIDER_IDS.has(named[1])) return 'provider-display-name';
  if (isModelId(s)) return 'model-id';
  const list = s.endsWith(' · On') ? s.slice(0, -' · On'.length) : s;
  const ids = list.split(', ');
  if ((list !== s || list.includes(', ')) && ids.every(isModelId)) return 'model-id-list';
  if (s.endsWith(' · On') && list.includes(', ') && ids.every((p) => isModelId(p) || LETTER_MODEL_ID.test(p))) return 'model-id-list';
  if (/\d/.test(s) && DIGITS.test(s)) return 'digits';
  const parts = s.split(' · ');
  if (parts.length > 1 && parts.every((p) => nonLinguisticClass(p) !== null)) return 'composite';
  return null;
}

export function isNonLinguistic(text) {
  return nonLinguisticClass(text) !== null;
}

// Records each candidate text node with its original value and its region flags; no node is changed here.
function candidatesExpr(keep) {
  return 'window.__koCands = (function (keep, excl, region, label, keySel, threadSel) {' +
    ' var keepSet = new Set(keep); var out = []; var keepOut = []; var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);' +
    ' var sib = function (x) { return x ? (x.textContent || "").trim().slice(0, 80) : null; };' +
    ' for (var n = walker.nextNode(); n; n = walker.nextNode()) {' +
    '   var v = n.nodeValue.trim();' +
    '   if (!/[A-Za-z]/.test(v)) continue;' +
    '   var el = n.parentElement;' +
    '   if (!el || el.closest(excl) !== null || el.getClientRects().length === 0) continue;' +
    '   if (keepSet.has(v)) { keepOut.push(v); continue; }' +
    '   var row = el.closest("[data-slot=settings-row]"); var h = row ? row.querySelector("h3") : null;' +
    '   var inRegion = el.matches(region) && h !== null && h.textContent.trim().indexOf(label) === 0;' +
    '   out.push({ node: n, original: n.nodeValue, region: inRegion, inKey: el.closest(keySel) !== null, inThread: el.closest(threadSel) !== null,' +
    '     parentTag: el.tagName.toLowerCase(), parentText: el.textContent.trim().slice(0, 200),' +
    '     prev: sib(n.previousSibling), next: sib(n.nextSibling) });' +
    ' }' +
    ' window.__koKeep = keepOut; return out; })(' + JSON.stringify(keep) + ', ' + JSON.stringify(EXCL) + ', ' +
    JSON.stringify(DATA_REGION_SELECTORS.join(', ')) + ', ' + JSON.stringify(SKILL_LABEL_PREFIX) + ', ' +
    JSON.stringify(KEYCAP_REGION_SELECTORS.join(', ')) + ', ' +
    JSON.stringify(THREAD_CONTENT_SELECTORS.join(', ')) + ');' +
    ' window.__koCands.length;';
}

// One row per candidate node after the page ran: its English value, whether it changed, and its context.
const AFTER = '(function () {' +
  ' var nodes = window.__koCands.map(function (c) {' +
  '   return { en: c.original.trim(), changed: c.node.nodeValue !== c.original, now: c.node.nodeValue.trim(), region: c.region, inKey: c.inKey, inThread: c.inThread,' +
  '     parentTag: c.parentTag, parentText: c.parentText, prev: c.prev, next: c.next }; });' +
  ' var overflow = Array.prototype.filter.call(document.querySelectorAll("button, [role=button], [role=menuitem]"), function (el) {' +
  '   return el.getClientRects().length > 0 && el.scrollWidth > el.clientWidth; }).length;' +
  ' return JSON.stringify({ nodes: nodes, overflow: overflow,' +
  '   batches: performance.getEntriesByName("ko:batch").map(function (e) { return e.duration; }) });' +
  '})();';

// Resolves on the ko:idle mark, which page.js sets when its queue and in-flight batches are empty.
const WAIT_IDLE = '(function () { return new Promise(function (resolve) {' +
  ' var po = new PerformanceObserver(function (list) {' +
  '   if (list.getEntries().some(function (e) { return e.name === "ko:idle"; })) { po.disconnect(); resolve(true); } });' +
  ' po.observe({ entryTypes: ["mark"] }); }); })();';

// Installs the bridge and runs page.js as the body of function (omoMods) { ... }, as the loader does.
function bootstrap(src) {
  return [
    '(function () {',
    '  window.__koPending = {};',
    '  var seq = 0;',
    '  window.__koDeliver = function (id, json) {',
    '    var p = window.__koPending[id];',
    '    delete window.__koPending[id];',
    '    var m = JSON.parse(json);',
    '    if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));',
    '  };',
    '  var omoMods = { call: function (method, args) {',
    '    return new Promise(function (resolve, reject) {',
    '      var id = ++seq;',
    '      window.__koPending[id] = { resolve: resolve, reject: reject };',
    '      window.koCall(JSON.stringify({ id: id, method: method, args: args }));',
    '    });',
    '  } };',
    '  (function (omoMods) {',
    src,
    '  })(omoMods);',
    '})();',
  ].join('\n');
}

// Attach mode: the browser endpoint and the first page target of a Chrome already listening on the port.
async function browserWsUrl(port) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/version');
  return (await res.json()).webSocketDebuggerUrl;
}
async function pageTargetId(port) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/list');
  const page = (await res.json()).find((t) => t.type === 'page');
  if (!page) throw new Error('no page target on port ' + port);
  return page.id;
}

// Serves one snapshot folder on loopback. The snapshots link their CSS as omo://app/assets/<name>.css, which only the app's
// own scheme can serve, so the server rewrites that prefix to its own origin and serves <name> from the css folder.
export function serveSnapshots(snapDir) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).slice(1);
    let file = null;
    if (/^[^/]+\.html$/.test(rel)) file = path.join(snapDir, rel);
    else if (rel.startsWith('assets/') && /^[^/]+\.css$/.test(rel.slice('assets/'.length))) file = path.join(snapDir, 'css', rel.slice('assets/'.length));
    if (file === null || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (file.endsWith('.html')) {
      const base = 'http://127.0.0.1:' + server.address().port + '/';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file, 'utf8').split('omo://app/').join(process.env.OMO_COVERAGE_TEST_NO_CSS ? 'omo://app/' : base));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port + '/' })));
}

// Styled-render check. The app stylesheets are the <link> sheets whose href is .../assets/<name>.css. The check needs at
// least one such sheet with rules, and one app rule whose selector matches an element and whose first declared property
// computes to the declared value. The expected value is normalised on a probe element, so colour syntax does not matter.
// Without the app CSS no app sheet loads and the check fails. The snapshot's inline <style> blocks are not counted.
function stylePage() {
  var sheets = Array.prototype.slice.call(document.styleSheets);
  var appSheets = sheets.filter(function (s) {
    return s.ownerNode && s.ownerNode.tagName === 'LINK' && typeof s.href === 'string' && s.href.indexOf('/assets/') !== -1 && s.href.slice(-4) === '.css';
  });
  var appRules = [];
  var appSheetsWithRules = 0;
  appSheets.forEach(function (s) {
    try {
      var rules = Array.prototype.slice.call(s.cssRules);
      if (rules.length > 0) appSheetsWithRules += 1;
      rules.forEach(function (r) { if (r.type === 1) appRules.push(r); });
    } catch (e) { }
  });
  var normalizer = document.createElement('div');
  document.body.appendChild(normalizer);
  var probe = null;
  var checked = 0;
  for (var i = 0; i < appRules.length && probe === null && checked < 400; i += 1) {
    var rule = appRules[i];
    var sel = rule.selectorText || '';
    if (sel === '' || sel.indexOf(':') !== -1 || rule.style.length === 0) continue;
    var el = null;
    try { el = document.querySelector(sel); } catch (e) { el = null; }
    if (el === null) continue;
    checked += 1;
    var prop = rule.style[0];
    normalizer.style.cssText = '';
    normalizer.style.setProperty(prop, rule.style.getPropertyValue(prop));
    var expected = getComputedStyle(normalizer).getPropertyValue(prop);
    var actual = getComputedStyle(el).getPropertyValue(prop);
    if (expected !== '' && expected === actual) probe = { selector: sel.slice(0, 80), property: prop, value: actual };
  }
  normalizer.remove();
  var cssRules = 0;
  sheets.forEach(function (s) { try { cssRules += s.cssRules.length; } catch (e) { } });
  return JSON.stringify({ sheets: sheets.length, cssRules: cssRules, appSheets: appSheets.length,
    appSheetsWithRules: appSheetsWithRules, appRules: appRules.length, probe: probe,
    bodyFont: getComputedStyle(document.body).fontFamily, styled: appSheetsWithRules > 0 && probe !== null });
}
const STYLE_EXPR = '(' + stylePage.toString() + ')();';

// Overflow probe: buttons, menu items and roles, the same selector as before. A hit overflows its box. koreanButtons
// counts visible buttons whose text holds Hangul, so the mod-on pass can be told apart from the English pass.
function overflowProbe() {
  var els = Array.prototype.slice.call(document.querySelectorAll('button, [role=button], [role=menuitem]'));
  var hits = [];
  var visible = 0;
  var korean = 0;
  els.forEach(function (el, i) {
    if (el.getClientRects().length === 0) return;
    visible += 1;
    var text = (el.textContent || '').trim();
    if (/[\uAC00-\uD7A3]/.test(text)) korean += 1;
    if (el.scrollWidth > el.clientWidth) hits.push({ i: i, tag: el.tagName.toLowerCase(), text: text.slice(0, 60) });
  });
  var clipped = [];
  Array.prototype.slice.call(document.querySelectorAll('*')).forEach(function (el, i) {
    if (el.getClientRects().length === 0 || el.scrollWidth <= el.clientWidth) return;
    var tag = el.tagName.toLowerCase();
    var cs = getComputedStyle(el);
    var cell = tag === 'td' || tag === 'th' || el.getAttribute('role') === 'cell';
    if (!cell && cs.overflow !== 'hidden' && cs.textOverflow !== 'ellipsis') return;
    clipped.push({ i: i, tag: tag, text: (el.textContent || '').trim().slice(0, 60) });
  });
  return JSON.stringify({ hits: hits, visibleButtons: visible, koreanButtons: korean, clipped: clipped });
}
const OVERFLOW_EXPR = '(' + overflowProbe.toString() + ')();';

function withTimeout(promise, label) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out after ' + WAIT_MS + 'ms')), WAIT_MS);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

function p95(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

// Scores one screen's nodes: region nodes first, then key chips, then rule classes, then the gated remainder.
// removedRows lists, per class, the distinct strings removed from the gate on this screen (capped, with a flag).
// Report only: a changed node that still shows a Latin word outside keep-english (for example 'Settings 저장됨').
// The gate does not use this number; it is printed and written so the gate cannot hide it.
function leftoverLatin(value, keepList) {
  let v = value;
  for (const k of keepList.slice().sort((a, b) => b.length - a.length)) v = v.split(k).join(' ');
  return /[A-Za-z]{2,}/.test(v);
}

// Report only: keep-english strings that the page shows as copy: two or more words of two or more letters, or one word of
// four or more letters (for example 'across'), and not a non-linguistic value. Not part of the gate.
export function isCopyLike(v) {
  const words = v.match(/[A-Za-z]{2,}/g) || [];
  return (words.length >= 2 || /^[A-Za-z]{4,}$/.test(v.trim())) && !isNonLinguistic(v);
}
export function keepHiddenOf(keepTexts) {
  const copy = keepTexts.filter(isCopyLike);
  const distinct = [...new Set(copy)].sort();
  return { nodes: copy.length, distinct: distinct.length, capped: distinct.length > 20, strings: distinct.slice(0, 20) };
}

// Attach mode: the window can show translator output before the candidates are taken: the ko mod attached in the window,
// or, with --open-by-click, the page.js this tool ran for an earlier screen, which keeps observing the page. The app ships no
// Hangul copy, so a candidate that already holds Hangul was written by a translator and counts as translated, like a node the
// on pass changed; like one, it is listed in changedStillLatin when it keeps a Latin word outside keep-english. keep-english
// cannot decide this alone: translations keep product names and units it does not list. A Latin-only candidate is left as it
// is, so an English leftover still counts as untranslated. onPassChangedNodes stays the on pass's own count.
const HANGUL = /[\uAC00-\uD7A3]/;
export function markPreTranslated(nodes) {
  return nodes.map((n) => (n.changed || !HANGUL.test(n.en) ? n : { ...n, changed: true, preTranslated: true }));
}

export function scoreScreen(screen, nodes, ruleClassCounts, keepList, keepTexts) {
  const gated = [];
  const removed = new Map();
  let dataRegionNodes = 0;
  let dataRuleNodes = 0;
  const hide = (cls, en) => {
    ruleClassCounts[cls] = (ruleClassCounts[cls] || 0) + 1;
    if (!removed.has(cls)) removed.set(cls, new Set());
    removed.get(cls).add(en);
  };
  for (const n of nodes) {
    if (n.region) {
      dataRegionNodes += 1;
      hide('region', n.en);
      continue;
    }
    if (n.inKey) {
      dataRuleNodes += 1;
      hide('keycap-region', n.en);
      continue;
    }
    if (n.inThread) {
      dataRuleNodes += 1;
      hide('thread-content', n.en);
      continue;
    }
    const cls = nonLinguisticClass(n.en);
    if (cls !== null) {
      dataRuleNodes += 1;
      hide(cls, n.en);
      continue;
    }
    gated.push(n);
  }
  const removedRows = [...removed].map(([cls, set]) => {
    const strings = [...set].sort();
    return { screen, class: cls, distinct: strings.length, capped: strings.length > STRING_CAP, strings: strings.slice(0, STRING_CAP) };
  });
  const changedStill = gated.filter((n) => n.changed && leftoverLatin(n.now, keepList)).map((n) => n.now);
  const strictNotTranslated = nodes.filter((n) => !n.changed).length;
  const untranslated = gated.filter((n) => !n.changed);
  return {
    screen,
    total: gated.length,
    translated: gated.length - untranslated.length,
    notTranslated: untranslated.length,
    untranslatedRatio: gated.length === 0 ? 0 : untranslated.length / gated.length,
    strictTotal: nodes.length,
    strictNotTranslated,
    strictRatio: nodes.length === 0 ? 0 : strictNotTranslated / nodes.length,
    dataRuleNodes,
    dataRegionNodes,
    removedRows,
    changedStillLatin: changedStill.length,
    changedStillLatinStrings: [...new Set(changedStill)].sort().slice(0, 20),
    keepHidden: keepHiddenOf(keepTexts),
    excluded: [...removed].flatMap(([cls, set]) => [...set].sort().map((text) => ({ text, rule: cls }))),
    remaining: [...new Set(untranslated.map((n) => n.en))],
    remainingDetail: untranslated.map((n) => ({ en: n.en, parentTag: n.parentTag, parentText: n.parentText, prev: n.prev, next: n.next })),
  };
}

// Failure rules for one screen row. Pure, so the tests can drive it with synthetic rows. A skipped row fails nothing.
export function screenFailures(s, allowMissing = false) {
  if (s.status === 'skipped') return [];
  if (s.status) return allowMissing ? [] : [s.screen + ' ' + s.status + ' (pass --allow-missing to accept)'];
  const out = [];
  if (s.untranslatedRatio > MAX_UNTRANSLATED) out.push(s.screen + ' gated untranslated ' + s.untranslatedRatio.toFixed(3));
  if (s.screen !== 'home' && 1 - s.untranslatedRatio < MIN_SETTINGS_TRANSLATED) out.push(s.screen + ' gated translated under 95%');
  if (!s.styleCheck.styled) out.push(s.screen + ' rendered without app CSS');
  if (s.newOverflow > 0) out.push(s.screen + ' newOverflow ' + s.newOverflow + ' (overflow only with the mod on)');
  // The mod must have acted on the screen. An attach row also carries preTranslatedNodes, the nodes already Korean when the
  // candidates were taken; they show the mod at work too, so there only a screen with neither fails.
  const alreadyKorean = s.preTranslatedNodes ?? 0;
  if (s.onPassChangedNodes === 0 && alreadyKorean === 0) {
    out.push(s.screen + ' mod changed 0 nodes on the on pass' + ('preTranslatedNodes' in s ? ' and none was already Korean' : ''));
  }
  if (s.visibleButtons > 0 && s.onPassKoreanButtons === 0) out.push(s.screen + ' no Korean button on the on pass');
  return out;
}

// New overflow: an element that overflows only in the mod-on pass, matched by its index in the selector list.
export function newOverflowOf(offHits, onHits) {
  const off = new Set(offHits.map((h) => h.i));
  return onHits.filter((h) => !off.has(h.i));
}

// Attach mode with --open-by-click: the app keeps its URL at /, so a settings screen is opened from the page itself.
// Clicks the settings trigger, then the [data-settings-nav-path] item for the path, and waits (bounded, 5 s) for the
// page to change before it is measured. The snapshot file is not needed in this mode.
// The nav item is clicked directly when it is already rendered (the trigger is gone once a settings view is open). Otherwise
// the trigger is clicked and the item is polled for up to 3 s. After the click the wait ends once the DOM has been quiet for
// 300 ms after at least one mutation, capped at 5 s in total.
export function openBySettingsClick(navPath) {
  const itemSel = JSON.stringify('[data-settings-nav-path="' + navPath + '"]');
  const noItem = JSON.stringify('no nav item ' + navPath);
  return '(async function () {' +
    ' var sel = ' + itemSel + ';' +
    ' var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };' +
    ' var item = document.querySelector(sel);' +
    ' if (!item) {' +
    '   var trigger = document.querySelector("[data-settings-trigger]"); if (!trigger) return "no settings trigger";' +
    '   trigger.click();' +
    '   var deadline = Date.now() + 3000;' +
    '   while (!(item = document.querySelector(sel)) && Date.now() < deadline) await wait(50);' +
    '   if (!item) return ' + noItem + ';' +
    ' }' +
    ' await new Promise(function (resolve) {' +
    '   var cap = setTimeout(finish, 5000); var quiet = null; var obs = null;' +
    '   function finish() { clearTimeout(cap); clearTimeout(quiet); if (obs) obs.disconnect(); resolve(); }' +
    '   obs = new MutationObserver(function () { clearTimeout(quiet); quiet = setTimeout(finish, 300); });' +
    '   obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });' +
    '   item.click();' +
    ' });' +
    ' return "ok"; })()';
}

// The screens one run measures, in order. --screens names them exactly. Without it every screen runs, except home in attach
// mode: in the app home is the owner's live chat thread, whose text must not reach the output, so attach mode measures it
// only when --screens names it.
const HOME_SKIP_REASON = 'attach mode measures home only when --screens names it: in the app it is the live chat thread';
export function screensToRun(all, wanted, attach) {
  if (wanted !== null) return wanted.split(',').map((name) => all.find((s) => s.screen === name) || { screen: name, file: null });
  return attach ? all.map((s) => (s.screen === 'home' ? { ...s, skipReason: HOME_SKIP_REASON } : s)) : all;
}

// The row of a screen the run does not open, or null. A navigated screen is not opened when the base url routes in its hash,
// as the app's main window does (omo://app/#/<env>/<thread>): base-url + file then changes only the fragment, which loads no
// file and fires no load event, so the load wait could only time out.
export function unopenedRow({ screen, file, skipReason }, baseUrl, byClick) {
  if (skipReason) return { screen, status: 'skipped', reason: skipReason };
  if (!byClick && file !== null && baseUrl.includes('#')) {
    return { screen, status: 'not opened: the base url routes in its hash, so ' + file + ' cannot load' };
  }
  return null;
}

// Attach mode writes what a live window shows, so every string of the output (coverage.json rows with remaining,
// remainingDetail and parent text, the data-rule-removed.json strings, the printed table) goes through tools/redact.mjs
// before it is written or printed. Only strings change; numbers and keys stay, so every count stays as measured.
export function redactStrings(value) {
  if (typeof value === 'string') return redactHtml(value).html;
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactStrings(v)]));
  return value;
}

async function main() {
  const outDir = arg('--out');
  const attachPort = arg('--cdp-port');
  const allowMissing = process.argv.includes('--allow-missing');
  const openByClick = process.argv.includes('--open-by-click');
  if (!outDir) {
    console.error('usage: node tools/coverage.mjs --out <dir> [--captures <dir>] [--cdp-port <n> --base-url <url> [--screens a,b]]');
    process.exit(2);
  }
  if (attachPort && !arg('--base-url')) {
    console.error('attach mode needs --base-url <url>');
    process.exit(2);
  }
  const capDir = arg('--captures');
  const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
  const facts = JSON.parse(read('docs/app-facts.json'));
  const keepEnglish = Object.keys(JSON.parse(read('mods/ko/keep-english.json')).entries);
  const pageSrc = read('mods/ko/page.js');
  const snapDir = path.join(repo, 'fixtures/live', facts.fingerprint.client);
  const SCREENS = [{ screen: 'home', file: 'home.html' }].concat(
    facts.settingsNav.paths.map((p) => ({ screen: p.slice(1), file: 'settings-' + p.split('/').pop() + '.html' })),
  );

  const snap = attachPort ? null : await serveSnapshots(snapDir);
  const baseUrl = attachPort ? arg('--base-url') : snap.url;
  fs.mkdirSync(outDir, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ko-cov-'));
  const launched = attachPort ? null : await launchChrome(profile);
  const proc = launched ? launched.proc : null;
  const cdp = await connect(attachPort ? await browserWsUrl(attachPort) : await launched.wsUrl);
  let exceptions = 0;
  const deliverErrors = [];
  const screens = [];
  const batches = [];
  const ruleClassCounts = {};
  const removedAll = [];
  try {
    const { targetId } = attachPort ? { targetId: await pageTargetId(attachPort) } : await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, { sessionId: sid });
    await cdp.send('Runtime.enable', {}, { sessionId: sid });
    await cdp.send('Runtime.addBinding', { name: 'koCall' }, { sessionId: sid });
    cdp.on('Runtime.exceptionThrown', (_p, s) => { if (s === sid) exceptions += 1; });
    cdp.on('Runtime.bindingCalled', (p, s) => {
      if (s !== sid || p.name !== 'koCall') return;
      const req = JSON.parse(p.payload);
      let reply;
      try {
        reply = { ok: true, value: handle(req.method, req.args) };
      } catch (err) {
        reply = { ok: false, error: err.message };
      }
      cdp.send('Runtime.evaluate', { expression: '__koDeliver(' + req.id + ', ' + JSON.stringify(JSON.stringify(reply)) + ')' }, { sessionId: sid })
        .catch((err) => { deliverErrors.push(err.message); });
    });
    const evaluate = async (expression) => {
      const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { sessionId: sid });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
      return res.result.value;
    };

    for (const entry of screensToRun(SCREENS, arg('--screens'), attachPort !== null)) {
      const { screen, file } = entry;
      const byClick = openByClick && screen !== 'home';
      const unopened = unopenedRow(entry, baseUrl, byClick);
      if (unopened !== null) {
        screens.push(unopened);
        continue;
      }
      if (file === null || (!byClick && !fs.existsSync(path.join(snapDir, file)))) {
        screens.push({ screen, status: 'missing screen' });
        continue;
      }
      if (byClick) {
        const opened = await evaluate(openBySettingsClick('/' + screen));
        if (opened !== 'ok') {
          screens.push({ screen, status: 'not opened: ' + opened });
          continue;
        }
      } else {
        const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', (_p, s) => { if (s === sid) resolve(); }));
        await cdp.send('Page.navigate', { url: baseUrl + file }, { sessionId: sid });
        await withTimeout(loaded, screen + ' load');
      }
      const styleCheck = JSON.parse(await evaluate(STYLE_EXPR));
      const offProbe = JSON.parse(await evaluate(OVERFLOW_EXPR));
      const offHits = offProbe.hits;
      const offClipped = offProbe.clipped;
      await evaluate(candidatesExpr(keepEnglish));
      const keepTexts = JSON.parse(await evaluate('JSON.stringify(window.__koKeep || [])'));
      const idle = process.env.OMO_COVERAGE_TEST_NO_MOD ? null : withTimeout(evaluate(WAIT_IDLE), screen + ' idle');
      if (idle !== null) {
        await evaluate(bootstrap(pageSrc));
        await idle;
      }
      const after = JSON.parse(await evaluate(AFTER));
      const onProbe = JSON.parse(await evaluate(OVERFLOW_EXPR));
      const onHits = onProbe.hits;
      const onClipped = onProbe.clipped;
      const newClipped = newOverflowOf(offClipped, onClipped);
      const onPassChangedNodes = after.nodes.filter((n) => n.changed).length;
      const newHits = newOverflowOf(offHits, onHits);
      batches.push(...after.batches);
      const nodes = attachPort ? markPreTranslated(after.nodes) : after.nodes;
      const scored = scoreScreen(screen, nodes, ruleClassCounts, keepEnglish, keepTexts);
      removedAll.push(...scored.removedRows);
      if (capDir && CAPTURE_SCREENS.has(screen)) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, { sessionId: sid });
        fs.mkdirSync(capDir, { recursive: true });
        fs.writeFileSync(path.join(capDir, screen.replace('/', '-') + '.png'), Buffer.from(shot.data, 'base64'));
      }
      const { removedRows, ...row } = scored;
      if (attachPort) row.preTranslatedNodes = nodes.filter((n) => n.preTranslated).length;
      screens.push({ ...row, overflowCount: after.overflow, styleCheck, overflowOff: offHits.length, overflowOn: onHits.length,
        newOverflow: newHits.length, newOverflowList: newHits.slice(0, 20), onPassChangedNodes,
        clippedOff: offClipped.length, clippedOn: onClipped.length, newClipped: newClipped.length, newClippedList: newClipped.slice(0, 20),
        onPassKoreanButtons: onProbe.koreanButtons, visibleButtons: onProbe.visibleButtons });
    }
  } finally {
    if (snap) snap.server.close();
    cdp.close();
    if (proc) await killChrome(proc);
    removeTempDir(profile);
  }

  const failures = [];
  for (const s of screens) failures.push(...screenFailures(s, allowMissing));
  if (exceptions > 0) failures.push('page script threw ' + exceptions + ' exception(s)');
  if (deliverErrors.length > 0) failures.push('bridge reply failed: ' + deliverErrors.join('; '));
  const summary = {
    gate: 'verdict uses the gated ratio (rules, data regions and key chips applied); strictRatio is shown for honesty only',
    screens,
    ruleClassCounts,
    overflowCount: screens.reduce((n, s) => n + (s.overflowCount || 0), 0),
    exceptionThrown: exceptions,
    batchCount: batches.length,
    batchP95Ms: p95(batches),
    failures,
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
  };
  const report = attachPort ? redactStrings(summary) : summary;
  fs.writeFileSync(path.join(outDir, 'coverage.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'data-rule-removed.json'), JSON.stringify(attachPort ? redactStrings(removedAll) : removedAll, null, 2) + '\n');
  const pct = (x) => (100 * x).toFixed(1).padStart(5) + '%';
  for (const s of report.screens) {
    if (s.status) {
      console.log(s.screen.padEnd(30) + ' ' + s.status + (s.reason ? ' (' + s.reason + ')' : ''));
      continue;
    }
    console.log(s.screen.padEnd(30) + ' gated ' + String(s.total).padStart(4) + ' untranslated ' + pct(s.untranslatedRatio) +
      ' | strict ' + String(s.strictTotal).padStart(4) + ' untranslated ' + pct(s.strictRatio) +
      ' | dataRuleNodes ' + String(s.dataRuleNodes).padStart(3) + ' dataRegionNodes ' + String(s.dataRegionNodes).padStart(3) +
      ' | changedStillLatin ' + String(s.changedStillLatin).padStart(3) + ' | keepHidden ' + s.keepHidden.nodes + ' | overflow ' + s.overflowCount);
  }
  console.log('removed by class: ' + JSON.stringify(ruleClassCounts));
  console.log('overflowCount=' + summary.overflowCount + ' batchP95Ms=' + summary.batchP95Ms + ' exceptionThrown=' + exceptions + ' verdict=' + summary.verdict);
  for (const f of report.failures) console.log('FAIL: ' + f);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

if (isEntry(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
