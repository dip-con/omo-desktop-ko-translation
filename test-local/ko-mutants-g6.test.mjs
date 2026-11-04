// Chrome tests that kill gate survivors (G6 S3): other attributes stay unchanged (M7), the 3rd flip is translated (M8),
// flips more than 1 s apart never stop a node (M10), nodes added or edited inside div[role=log] after load stay
// unchanged (M12, M13), and document.documentElement.lang is the same before and after the mod runs (M14).
// Needs the ko.json and a local Chrome (tools/chrome.mjs).
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ko-g6-'));
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

// Installs the page with the live bridge on a fresh body, runs the optional pre expression, and waits for the idle mark.
async function openPage(html, pre = '') {
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
  await evaluate("document.body.innerHTML = '" + html + "'" + (pre ? '; ' + pre : ''));
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

// One English write to a per step, plus a sentinel write to c so every step queues a batch; resolves on that batch.
const flipper = (evaluate) => async (n) => {
  const waiting = nextBatch(evaluate);
  await evaluate("(function () { document.getElementById('a').firstChild.nodeValue = 'Settings';" +
    " document.getElementById('c').firstChild.nodeValue = 'S" + n + "'; return true; })()");
  await waiting;
};
const LOOP_MARKS = "performance.getEntriesByName('ko:loop-stopped').length";

describe('attributes other than aria-label, title and placeholder (M7)', () => {
  it('translates aria-label but leaves value and alt holding the same dictionary word', async () => {
    // Given: an input with aria-label, value and alt all holding Cancel or Settings; When: the page runs; Then: only aria-label changes
    const { evaluate } = await openPage('<div id="root"><input id="i" type="image" alt="Settings" value="Cancel" aria-label="Cancel"></div>');
    const seen = JSON.parse(await evaluate("JSON.stringify({ aria: document.getElementById('i').getAttribute('aria-label'), value: document.getElementById('i').getAttribute('value'), alt: document.getElementById('i').getAttribute('alt') })"));
    assert.deepEqual(seen, { aria: '취소', value: 'Cancel', alt: 'Settings' });
  });
});

describe('loop limit boundary (M8, M10)', () => {
  it('translates the 3rd flip and records no loop mark', async () => {
    // Given: a translated node a and a sentinel c; When: a flips back to English once per step, three steps; Then: a is translated and no mark exists
    const { evaluate } = await openPage('<div id="root"><span id="a">Settings</span><span id="c">S0</span></div>');
    const step = flipper(evaluate);
    for (let n = 1; n <= 3; n += 1) await step(n);
    assert.equal(await evaluate("document.getElementById('a').textContent"), '설정');
    assert.equal(await evaluate(LOOP_MARKS), 0);
  });

  it('does not stop a node whose flips are more than one second apart', async () => {
    // Given: a translated node a and a sentinel c; When: a flips back four times, with a 1.1 s timer between flips (time is the behavior under test); Then: a is translated and no mark exists
    const { evaluate } = await openPage('<div id="root"><span id="a">Settings</span><span id="c">S0</span></div>');
    const step = flipper(evaluate);
    for (let n = 1; n <= 4; n += 1) {
      await step(n);
      if (n < 4) await evaluate('new Promise(function (resolve) { setTimeout(resolve, 1100); })');
    }
    assert.equal(await evaluate("document.getElementById('a').textContent"), '설정');
    assert.equal(await evaluate(LOOP_MARKS), 0);
  });
});

describe('live nodes inside div[role=log] (M12, M13)', () => {
  it('leaves a node added to div[role=log] after load unchanged, while a sentinel outside it is translated', async () => {
    // Given: an empty div[role=log] and a root; When: a Settings span is appended to the log and a Cancel span to the root in one task; Then: the log span is unchanged and the root span is translated
    const { evaluate } = await openPage('<div id="root"><div role="log"></div></div>');
    const waiting = nextBatch(evaluate);
    await evaluate("(function () { var s = document.createElement('span'); s.id = 'z'; s.textContent = 'Settings';" +
      " document.querySelector('[role=\"log\"]').appendChild(s);" +
      " var k = document.createElement('span'); k.id = 'k'; k.textContent = 'Cancel'; document.getElementById('root').appendChild(k); return true; })()");
    await waiting;
    assert.equal(await evaluate("document.getElementById('k').textContent"), '취소');
    assert.equal(await evaluate("document.getElementById('z').textContent"), 'Settings');
  });

  it('leaves a text node inside div[role=log] unchanged after its text is edited to a dictionary word', async () => {
    // Given: a Settings span inside div[role=log] and a sentinel outside it; When: the log text is edited to Cancel in the same task as the sentinel write; Then: the log text stays Cancel and the sentinel is translated
    const { evaluate } = await openPage('<div id="root"><div role="log"><span id="m">Settings</span></div><span id="k">S0</span></div>');
    const waiting = nextBatch(evaluate);
    await evaluate("(function () { document.getElementById('m').firstChild.nodeValue = 'Cancel';" +
      " document.getElementById('k').firstChild.nodeValue = 'Cancel'; return true; })()");
    await waiting;
    assert.equal(await evaluate("document.getElementById('k').textContent"), '취소');
    assert.equal(await evaluate("document.getElementById('m').textContent"), 'Cancel');
  });
});

describe('document language (M14)', () => {
  it('leaves document.documentElement.lang the same string before and after the mod runs', async () => {
    // Given: the page language set to en before the mod is installed; When: the mod runs; Then: the value is still en
    const { evaluate } = await openPage('<div id="root"><span>Cancel</span></div>',
      "document.documentElement.lang = 'en'; window.__langBefore = document.documentElement.lang;");
    assert.equal(await evaluate('window.__langBefore'), 'en');
    assert.equal(await evaluate('document.documentElement.lang'), 'en');
  });
});
