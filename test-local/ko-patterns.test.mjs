// Runtime patterns. The live loop checks every pattern in mods/ko/ko.json with a sample built from its own source;
// the Chrome test shows a pattern rendering on the page, with a control page that has no patterns. Needs the gitignored
// ko.json and a local Chrome (tools/chrome.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it as nodeIt } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hasLoader } from '../tools/loader-dir.mjs';
import { importLoader } from '../tools/loader-import.mjs';
const loaderAvailable = hasLoader();
let skippedIntegrationTests = 0;
const it = (name, fn) => {
  if (!loaderAvailable) skippedIntegrationTests += 1;
  return nodeIt(name, { skip: loaderAvailable ? false : 'LOADER_DIR not set or invalid' }, fn);
};
if (!loaderAvailable) after(() => console.log(`LOADER_DIR not set or invalid; ${skippedIntegrationTests} integration tests skipped`));
const connect = loaderAvailable ? (await importLoader('cdp.mjs')).connect : null;
import { translateText } from '../mods/ko/translate.mjs';
import { killChrome, launchChrome, removeTempDir } from '../tools/chrome.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAGE_SRC = fs.readFileSync(path.join(root, 'mods/ko/page.js'), 'utf8');
const KO = JSON.parse(fs.readFileSync(path.join(root, 'mods/ko/ko.json'), 'utf8'));
const PAGE_PATTERNS = { '^(\\d+) tools? loaded\\.$': '도구 $1개를 불러왔어요.' };

// Builds one input that the source matches: non-capturing groups keep their first alternative, capture groups get a
// sample value (a number for \d groups), quantifiers are dropped, and escapes become the literal character.
function sampleFor(source) {
  let s = source.replace(/^\^/, '').replace(/\$$/, '');
  let prev;
  do {
    prev = s;
    s = s.replace(/\(\?:([^()]*)\)/g, (_, body) => body.split('|')[0]);
  } while (s !== prev);
  s = s.replace(/\(([^()]*)\)/g, (_, body) => body.replace(/\\d[+*?]?/g, '7').replace(/\\S[+*?]?/g, 'Sample').replace(/\.[+*]?/g, 'Sample'));
  s = s.replace(/[?*+]/g, '');
  s = s.replace(/\\d/g, '1').replace(/\\S/g, 'x').replace(/\\(.)/g, '$1');
  return s;
}

describe('every live ko.json pattern', () => {
  for (const [source, tpl] of Object.entries(KO.patterns ?? {})) {
    it('renders a sample of ' + source + ' and leaves its output unchanged on a second pass', () => {
      // Given: a sample built from the pattern's own source; When: the pattern and then the full set run; Then: the sample is translated and stable
      const sample = sampleFor(source);
      assert.ok(new RegExp(source).test(sample), 'sample does not match: ' + sample);
      const out = translateText(sample, {}, { [source]: tpl });
      assert.notEqual(out, sample);
      assert.equal(translateText(out, {}, KO.patterns), out);
    });
  }
});

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ko-pat-'));
let proc;
let cdp;

if (loaderAvailable) before(async () => {
  const launched = await launchChrome(profile);
  proc = launched.proc;
  cdp = await connect(await launched.wsUrl);
});

if (loaderAvailable) after(async () => {
  cdp.close();
  await killChrome(proc);
  removeTempDir(profile);
});

// Renders '3 tools loaded.' in a fresh target. The bridge translates with the given patterns (none for the control).
async function renderedText(patterns) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, { sessionId: sid });
  await cdp.send('Runtime.addBinding', { name: 'koCall' }, { sessionId: sid });
  cdp.on('Runtime.bindingCalled', (p, s) => {
    if (s !== sid || p.name !== 'koCall') return;
    const req = JSON.parse(p.payload);
    let reply;
    try {
      if (req.method === 'config') reply = { ok: true, value: { exclusionSelectors: ['pre'] } };
      else if (req.method === 'translate') reply = { ok: true, value: req.args[0].map((t) => translateText(t, {}, patterns)) };
      else throw new Error('unknown method ' + req.method);
    } catch (err) {
      reply = { ok: false, error: err.message };
    }
    cdp.send('Runtime.evaluate', { expression: '__koDeliver(' + req.id + ', ' + JSON.stringify(JSON.stringify(reply)) + ')' }, { sessionId: sid });
  });
  const evaluate = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { sessionId: sid });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result.value;
  };
  await evaluate("document.body.innerHTML = '<div id=\"root\"><span>3 tools loaded.</span></div>'");
  const idle = evaluate("new Promise(function (resolve) { var po = new PerformanceObserver(function (list) {" +
    " if (list.getEntries().some(function (e) { return e.name === 'ko:idle'; })) { po.disconnect(); resolve(true); } });" +
    " po.observe({ entryTypes: ['mark'] }); })");
  const pageHost = '(function () {' +
    ' window.__koPending = {}; var seq = 0;' +
    ' window.__koDeliver = function (id, json) { var p = window.__koPending[id]; delete window.__koPending[id];' +
    '   var m = JSON.parse(json); if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error)); };' +
    ' var omoMods = { call: function (method, args) { return new Promise(function (resolve, reject) {' +
    '   var id = ++seq; window.__koPending[id] = { resolve: resolve, reject: reject };' +
    '   window.koCall(JSON.stringify({ id: id, method: method, args: args })); }); } };' +
    ' (function (omoMods) {\n' + PAGE_SRC + '\n })(omoMods);' +
    '})();';
  await evaluate(pageHost);
  await idle;
  return evaluate("document.querySelector('span').textContent");
}

describe('a runtime pattern renders on the page', () => {
  it('turns "3 tools loaded." into Korean through a pattern', async () => {
    // Given: a page whose bridge has the pattern; When: the page runs; Then: the span shows the Korean rendering
    assert.equal(await renderedText(PAGE_PATTERNS), '도구 3개를 불러왔어요.');
  });

  it('control: with no patterns the same text stays English', async () => {
    // Given: a page whose bridge has no patterns; When: the page runs; Then: the span keeps the English text
    assert.equal(await renderedText({}), '3 tools loaded.');
  });
});
