// Long-task check (plan (b)). A synthetic message streams 2000 text nodes in 20 timer chunks. With the ko mod off and on,
// the longtask entries (>= 50 ms) are intersected with the translator batches (ko:batch measures). With the mod on, no
// long task may overlap a translator batch. G5_EVIDENCE_DIR writes the evidence file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it as nodeIt } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const FIXTURE = pathToFileURL(path.join(root, 'test-local/fixtures/streaming.html')).href;
const LONG_KO = JSON.parse(fs.readFileSync(path.join(root, 'mods/ko/ko.json'), 'utf8')).entries[JSON.parse(/var LONG = (".*?");/.exec(fs.readFileSync(path.join(root, 'test-local/fixtures/streaming.html'), 'utf8'))[1])];
const PAGE_HOST = '(function () {' +
  ' window.__koPending = {}; var seq = 0;' +
  ' window.__koDeliver = function (id, json) { var p = window.__koPending[id]; delete window.__koPending[id];' +
  '   var m = JSON.parse(json); if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error)); };' +
  ' var omoMods = { call: function (method, args) { return new Promise(function (resolve, reject) {' +
  '   var id = ++seq; window.__koPending[id] = { resolve: resolve, reject: reject };' +
  '   window.koCall(JSON.stringify({ id: id, method: method, args: args })); }); } };' +
  ' (function (omoMods) {\n' + PAGE_SRC + '\n })(omoMods);' +
  '})();';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ko-g5lt-'));
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

// Runs one streaming pass in a fresh target. mode 'on' installs the mod (live bridge) before the stream starts.
async function streamPass(mode) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, { sessionId: sid });
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
  const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', (_p, s) => { if (s === sid) resolve(); }));
  await cdp.send('Page.navigate', { url: FIXTURE }, { sessionId: sid });
  await loaded;
  if (mode === 'on') {
    const idle = evaluate("new Promise(function (resolve) { var po = new PerformanceObserver(function (list) {" +
      " if (list.getEntries().some(function (e) { return e.name === 'ko:idle'; })) { po.disconnect(); resolve(true); } });" +
      " po.observe({ entryTypes: ['mark'] }); })");
    await evaluate(PAGE_HOST);
    await idle;
  }
  // Subscribe to stream-done before the stream starts, then start it.
  const done = evaluate("new Promise(function (resolve) { window.addEventListener('stream-done', function () { resolve(performance.now()); }); })");
  await evaluate('window.__startStream(); true');
  const doneAt = await done;
  if (mode === 'on') {
    // Wait for an idle mark that comes after the stream finished, so the last batch is included.
    await evaluate("new Promise(function (resolve) { var po = new PerformanceObserver(function (list) {" +
      ' if (list.getEntries().some(function (e) { return e.name === "ko:idle" && e.startTime > ' + doneAt + '; })) { po.disconnect(); resolve(true); } });' +
      " po.observe({ type: 'mark', buffered: true }); })");
  }
  const nodes = await evaluate("document.querySelectorAll('#stream > div').length");
  const longWritten = await evaluate("Array.prototype.filter.call(document.querySelectorAll('#stream > div'), function (d) { return d.textContent === " + JSON.stringify(LONG_KO) + "; }).length");
  const longTasks = await evaluate('window.__lt.slice()');
  const batches = await evaluate("performance.getEntriesByName('ko:batch').map(function (e) { return { start: e.startTime, duration: e.duration }; })");
  return { nodes, longTasks, batches, longWritten };
}

const overlaps = (a, b) => a.start < b.start + b.duration && b.start < a.start + a.duration;

function p95(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((x, y) => x - y);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

describe('long tasks against translator batches', () => {
  it('no long task overlaps a translator batch while the message streams with the mod on', async () => {
    // Given: a streamed message of 2000 nodes with the mod off and on; When: long tasks are intersected with batches; Then: none overlaps a batch
    const off = await streamPass('off');
    const on = await streamPass('on');
    const overlapping = on.longTasks.filter((lt) => on.batches.some((b) => overlaps(lt, b)));
    const evidence = {
      fixture: 'test-local/fixtures/streaming.html (synthetic, not the app)',
      nodesStreamed: { off: off.nodes, on: on.nodes },
      longTasksOff: off.longTasks.length,
      longTasksOn: on.longTasks.length,
      batchesOn: on.batches.length,
      batchP95Ms: p95(on.batches.map((b) => b.duration)),
      overlappingLongTasksWithBatch: overlapping.length,
      verdict: overlapping.length === 0 && on.batches.length > 0 ? 'PASS' : 'FAIL',
    };
    if (process.env.G5_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.G5_EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.G5_EVIDENCE_DIR, 'g5-longtask.json'), JSON.stringify(evidence, null, 2) + '\n');
    }
    assert.equal(on.nodes, 2000);
    assert.ok(on.batches.length > 0, 'the translator ran no batch');
    assert.equal(overlapping.length, 0, overlapping.length + ' long task(s) overlap a translator batch');
    assert.equal(on.longWritten, 20, 'the long texts were not written by the translator');
    assert.equal(off.longWritten, 0, 'the mod-off run translated the long texts');
    assert.ok(on.longTasks.length <= off.longTasks.length, on.longTasks.length + ' long tasks with the mod on, ' + off.longTasks.length + ' with it off');
  });
});
