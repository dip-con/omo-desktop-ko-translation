// Exclusion proof (plan (c)). The synthetic conversation fixture is loaded with the ko mod off and then on. The text of
// every exclusion zone must be byte-identical in the two runs. The zone list is the FACTS exclusionSelectors plus the
// mod's own zones, written here on purpose, so it does not follow mods/ko/host.mjs. G5_EVIDENCE_DIR writes the evidence.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const PAGE_SRC = read('mods/ko/page.js');
const FACTS = JSON.parse(read('docs/app-facts.json')).exclusionSelectors.map((e) => e.selector);
const ZONES = [...FACTS, '[data-diff]', '.xterm', '[data-omo-mod]', 'kbd[data-slot="kbd"]'];
const FIXTURE = pathToFileURL(path.join(root, 'test-local/fixtures/conversation.html')).href;

const ZONE_SCRIPT = '(function (selectors) { var out = {}; selectors.forEach(function (sel) {' +
  ' var els = Array.prototype.slice.call(document.querySelectorAll(sel));' +
  ' out[sel] = { count: els.length, text: els.map(function (e) {' +
  ' return (e.tagName === "INPUT" || e.tagName === "TEXTAREA" ? e.value : "") + "|" + e.textContent; }).join("\\u0001") }; });' +
  ' return JSON.stringify(out); })(' + JSON.stringify(ZONES) + ');';
const MESSAGE_SCRIPT = 'JSON.stringify(Array.prototype.map.call(document.querySelectorAll(".message"), function (e) { return e.textContent; }))';
const SIDEBAR_SCRIPT = 'JSON.stringify(Array.prototype.map.call(document.querySelectorAll(".sidebar-title"), function (e) { return e.textContent; }))';
const PAGE_HOST = '(function () {' +
  ' window.__koPending = {}; var seq = 0;' +
  ' window.__koDeliver = function (id, json) { var p = window.__koPending[id]; delete window.__koPending[id];' +
  '   var m = JSON.parse(json); if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error)); };' +
  ' var omoMods = { call: function (method, args) { return new Promise(function (resolve, reject) {' +
  '   var id = ++seq; window.__koPending[id] = { resolve: resolve, reject: reject };' +
  '   window.koCall(JSON.stringify({ id: id, method: method, args: args })); }); } };' +
  ' (function (omoMods) {\n' + PAGE_SRC + '\n })(omoMods);' +
  '})();';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ko-g5x-'));
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

// Loads the fixture in a fresh target. mode 'on' installs the mod with the live bridge and waits for the idle mark.
async function loadFixture(mode) {
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
  return {
    zones: JSON.parse(await evaluate(ZONE_SCRIPT)),
    messages: JSON.parse(await evaluate(MESSAGE_SCRIPT)),
    sidebar: JSON.parse(await evaluate(SIDEBAR_SCRIPT)),
  };
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

describe('exclusion proof on the synthetic conversation', () => {
  it('every exclusion zone has identical text with the ko mod off and on', async () => {
    // Given: the same fixture loaded twice; When: the zone text is hashed per selector; Then: every hash matches and each zone exists
    const off = await loadFixture('off');
    const on = await loadFixture('on');
    const rows = ZONES.map((sel) => ({
      selector: sel,
      countOff: off.zones[sel].count,
      countOn: on.zones[sel].count,
      sha256Off: sha256(off.zones[sel].text),
      sha256On: sha256(on.zones[sel].text),
    }));
    rows.forEach((r) => { r.equal = r.sha256Off === r.sha256On; });
    const evidence = {
      fixture: 'test-local/fixtures/conversation.html (synthetic, not the app)',
      zones: rows,
      messagesOff: off.messages,
      messagesOn: on.messages,
      sidebarOff: off.sidebar,
      sidebarOn: on.sidebar,
      verdict: rows.every((r) => r.equal && r.countOff > 0) ? 'PASS' : 'FAIL',
    };
    if (process.env.G5_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.G5_EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.G5_EVIDENCE_DIR, 'g5-exclusion.json'), JSON.stringify(evidence, null, 2) + '\n');
    }
    // Messages sit inside div[role=log] (a facts zone): they must not change. The sidebar titles are outside every zone:
    // they must change with the mod on, so an equal message text cannot come from a translator that does nothing.
    assert.deepEqual(on.messages, off.messages);
    assert.deepEqual(on.messages, ['Settings', 'Cancel', 'SettingsCancel']);
    assert.deepEqual(off.sidebar, ['Settings', 'Cancel']);
    assert.deepEqual(on.sidebar, ['설정', '취소']);
    for (const r of rows) assert.ok(r.countOff > 0, 'no ' + r.selector + ' in the fixture');
    for (const r of rows) assert.equal(r.sha256On, r.sha256Off, 'zone text changed for ' + r.selector);
  });
});
