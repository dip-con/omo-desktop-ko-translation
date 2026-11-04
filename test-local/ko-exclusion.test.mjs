// Key chips are an exclusion zone: the page must leave a kbd[data-slot=kbd] chip alone and translate the same word in a
// plain span. Uses a fixture dictionary, never the live ko.json. KO_EXCLUSION_CONTROL=1 drops the chip selector from the
// config the page receives; the test must then fail (the control row).
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
import { EXCLUSION_SELECTORS, KEY_CHIP_SELECTORS } from '../mods/ko/host.mjs';
import { translateText } from '../mods/ko/translate.mjs';
import { killChrome, launchChrome, removeTempDir } from '../tools/chrome.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAGE_SRC = fs.readFileSync(path.join(root, 'mods/ko/page.js'), 'utf8');
const FIXTURE = { Home: '홈' };
const CONTROL = process.env.KO_EXCLUSION_CONTROL === '1';
const CONFIG_SELECTORS = CONTROL
  ? EXCLUSION_SELECTORS.filter((s) => !KEY_CHIP_SELECTORS.includes(s))
  : EXCLUSION_SELECTORS;
const PAGE = '<div id="root"><kbd data-slot="kbd">Home</kbd><span>Home</span></div>';

// Bridge answers for the page: config gives the exclusion list, translate uses the fixture dictionary only.
function answer(method, args) {
  if (method === 'config') return { exclusionSelectors: CONFIG_SELECTORS };
  if (method === 'translate') return args[0].map((t) => translateText(t, FIXTURE));
  throw new Error('unknown method ' + method);
}

const PAGE_HOST = '(function () {' +
  ' window.__koPending = {}; var seq = 0;' +
  ' window.__koDeliver = function (id, json) { var p = window.__koPending[id]; delete window.__koPending[id];' +
  '   var m = JSON.parse(json); if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error)); };' +
  ' var omoMods = { call: function (method, args) { return new Promise(function (resolve, reject) {' +
  '   var id = ++seq; window.__koPending[id] = { resolve: resolve, reject: reject };' +
  '   window.koCall(JSON.stringify({ id: id, method: method, args: args })); }); } };' +
  ' (function (omoMods) {\n' + PAGE_SRC + '\n })(omoMods);' +
  '})();';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ko-chip-'));
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

// Installs the page in a fresh target and resolves with the two node texts once the page is idle.
async function translatedPage() {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, { sessionId: sid });
  await cdp.send('Runtime.addBinding', { name: 'koCall' }, { sessionId: sid });
  cdp.on('Runtime.bindingCalled', (p, s) => {
    if (s !== sid || p.name !== 'koCall') return;
    const req = JSON.parse(p.payload);
    let reply;
    try {
      reply = { ok: true, value: answer(req.method, req.args) };
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
  await evaluate("document.body.innerHTML = '" + PAGE + "'");
  const idle = evaluate("new Promise(function (resolve) { var po = new PerformanceObserver(function (list) {" +
    " if (list.getEntries().some(function (e) { return e.name === 'ko:idle'; })) { po.disconnect(); resolve(true); } });" +
    " po.observe({ entryTypes: ['mark'] }); })");
  await evaluate(PAGE_HOST);
  await idle;
  return JSON.parse(await evaluate("JSON.stringify({ kbd: document.querySelector('kbd').textContent," +
    " span: document.querySelector('span').textContent })"));
}

describe('key chips are an exclusion zone', () => {
  it('leaves a key chip alone and translates the same word in a plain span', async () => {
    // Given: a kbd[data-slot=kbd] chip and a span, both reading Home; When: the page runs; Then: the chip keeps Home and the span gets the fixture value
    const seen = await translatedPage();
    assert.deepEqual(seen, { kbd: 'Home', span: '홈' });
  });
});
