// Loop-stop record (S1) and input attributes inside zones (S2) on the real page with the live bridge.
// Uses the ko.json through mods/ko/host.mjs and a local Chrome from tools/chrome.mjs.
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
import { handle } from '../mods/ko/host.mjs';
import { killChrome, launchChrome, removeTempDir } from '../tools/chrome.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAGE_SRC = fs.readFileSync(path.join(root, 'mods/ko/page.js'), 'utf8');
const PAGE_HOST = '(function () {' +
  ' window.__koPending = {}; var seq = 0;' +
  ' window.__koDeliver = function (id, json) { var p = window.__koPending[id]; delete window.__koPending[id];' +
  '   var m = JSON.parse(json); if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error)); };' +
  ' var omoMods = { call: function (method, args) { return new Promise(function (resolve, reject) {' +
  '   var id = ++seq; window.__koPending[id] = { resolve: resolve, reject: reject };' +
  '   window.koCall(JSON.stringify({ id: id, method: method, args: args })); }); } };' +
  ' (function (omoMods) {\n' + PAGE_SRC + '\n })(omoMods);' +
  '})();';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ko-la-'));
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

// Installs the page with the live bridge on a fresh body and waits for the idle mark.
async function openPage(html) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, { sessionId: sid });
  await cdp.send('Runtime.addBinding', { name: 'koCall' }, { sessionId: sid });
  cdp.on('Runtime.bindingCalled', (p, s) => {
    if (s !== sid || p.name !== 'koCall') return;
    const req = JSON.parse(p.payload);
    let reply;
    try {
      reply = { ok: true, value: handle(req.method, req.args) };
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
  await evaluate("document.body.innerHTML = '" + html + "'");
  const idle = evaluate("new Promise(function (resolve) { var po = new PerformanceObserver(function (list) {" +
    " if (list.getEntries().some(function (e) { return e.name === 'ko:idle'; })) { po.disconnect(); resolve(true); } });" +
    " po.observe({ entryTypes: ['mark'] }); })");
  await evaluate(PAGE_HOST);
  await idle;
  return { evaluate };
}

// Subscribes to the next ko:batch measure; await it after the action that triggers a batch.
const nextBatch = (evaluate) => evaluate("new Promise(function (resolve) { var po = new PerformanceObserver(function () {" +
  " po.disconnect(); resolve(true); }); po.observe({ entryTypes: ['measure'] }); })");

describe('loop-stop record (S1)', () => {
  it('records one ko:loop-stopped mark per node after the 4th flip, none before, none for an unrelated node', async () => {
    // Given: a translated node a, a sentinel c that queues a batch each step, and an unrelated node b; When: a flips back to English once per step for 5 steps; Then: marks are 0, 0, 0, 1, 1 and b has none
    const { evaluate } = await openPage('<div id="root"><span id="a">Settings</span><span id="b">Cancel</span><span id="c">S0</span></div>');
    const step = async (n) => {
      const waiting = nextBatch(evaluate);
      await evaluate("(function () { document.getElementById('a').firstChild.nodeValue = 'Settings';" +
        " document.getElementById('c').firstChild.nodeValue = 'S" + n + "'; return true; })()");
      await waiting;
    };
    const marks = () => evaluate("JSON.stringify(performance.getEntriesByName('ko:loop-stopped').map(function (e) { return e.detail; }))").then(JSON.parse);
    for (let n = 1; n <= 3; n += 1) {
      await step(n);
      assert.equal((await marks()).length, 0, 'marks after flip ' + n);
    }
    await step(4);
    const afterFourth = await marks();
    assert.equal(afterFourth.length, 1, 'marks after the 4th flip');
    assert.equal(afterFourth[0].text, 'Settings');
    assert.equal(afterFourth[0].kind, 'text');
    await step(5);
    assert.equal((await marks()).length, 1, 'marks after a 5th flip');
    assert.equal((await marks()).filter((m) => m.text === 'Cancel').length, 0, 'unrelated node recorded');
  });
});

describe('input attributes inside zones (S2)', () => {
  it('translates a top-level input placeholder and leaves one inside div[role=log] alone', async () => {
    // Given: two inputs with placeholder Cancel, one top level and one inside div[role=log]; When: the page runs; Then: only the top-level one changes
    const { evaluate } = await openPage('<div id="root"><input id="top" placeholder="Cancel"><div role="log"><input id="inside" placeholder="Cancel"></div></div>');
    const seen = JSON.parse(await evaluate("JSON.stringify({ top: document.getElementById('top').placeholder, inside: document.getElementById('inside').placeholder })"));
    assert.deepEqual(seen, { top: '취소', inside: 'Cancel' });
  });
});
