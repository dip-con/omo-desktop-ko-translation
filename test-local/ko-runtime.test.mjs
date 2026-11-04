// Headless checks for the ko mod page. The page runs in Chrome with a stub bridge served by host.mjs.
// Needs the mods/ko/ko.json and a local Chrome (tools/chrome.mjs). Waits are on the ko:batch measure.
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
import { translateText } from '../mods/ko/translate.mjs';
import { killChrome, launchChrome, removeTempDir } from '../tools/chrome.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAGE_SRC = fs.readFileSync(path.join(root, 'mods/ko/page.js'), 'utf8');
const ENTRIES = JSON.parse(fs.readFileSync(path.join(root, 'mods/ko/ko.json'), 'utf8')).entries;
const PAGE_HOST = `(function () {
  window.__koPending = {};
  var seq = 0;
  window.__koDeliver = function (id, json) {
    var p = window.__koPending[id];
    delete window.__koPending[id];
    var m = JSON.parse(json);
    if (m.ok) p.resolve(m.value);
    else p.reject(new Error(m.error));
  };
  var omoMods = {
    call: function (method, args) {
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        window.__koPending[id] = { resolve: resolve, reject: reject };
        window.koCall(JSON.stringify({ id: id, method: method, args: args }));
      });
    },
  };
  (function (omoMods) {
${PAGE_SRC}
  })(omoMods);
})();`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ko-'));
let proc;
let cdp;
let session;
let exceptions = 0;
let deliverErrors = [];

if (loaderAvailable) before(async () => {
  const launched = await launchChrome(profile);
  proc = launched.proc;
  cdp = await connect(await launched.wsUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: session } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  await cdp.send('Runtime.enable', {}, { sessionId: session });
  await cdp.send('Runtime.addBinding', { name: 'koCall' }, { sessionId: session });
  cdp.on('Runtime.exceptionThrown', (_params, sid) => { if (sid === session) exceptions += 1; });
  cdp.on('Runtime.bindingCalled', (params, sid) => {
    if (sid !== session || params.name !== 'koCall') return;
    const req = JSON.parse(params.payload);
    let reply;
    try {
      reply = { ok: true, value: handle(req.method, req.args) };
    } catch (err) {
      reply = { ok: false, error: err.message };
    }
    cdp.send('Runtime.evaluate', { expression: `__koDeliver(${req.id}, ${JSON.stringify(JSON.stringify(reply))})` }, { sessionId: session })
      .catch((err) => { deliverErrors.push(err.message); });
  });
});

if (loaderAvailable) after(async () => {
  cdp.close();
  await killChrome(proc);
  removeTempDir(profile);
});

async function evaluate(expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { sessionId: session });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
  return res.result.value;
}
// Subscribes to the next ko:batch measure. Call it before the action; await the result after the action.
function nextBatch() {
  return evaluate(`new Promise(function (resolve) {
    var po = new PerformanceObserver(function () { po.disconnect(); resolve(true); });
    po.observe({ entryTypes: ['measure'] });
  })`);
}

describe('ko page runtime', () => {
  it('translates registered text and attributes in place and leaves excluded zones alone', async () => {
    // Given: a page with plain text, an attribute and excluded zones; When: the page starts; Then: only the text and attribute change
    await evaluate(`document.body.innerHTML = '<div id="root"><p>  Settings  </p><pre>Settings</pre><input value="Settings" placeholder="Cancel"><span>Unknown label</span></div>'`);
    const batch = nextBatch();
    await evaluate(PAGE_HOST);
    await batch;
    const seen = JSON.parse(await evaluate(`JSON.stringify({
      p: document.querySelector('#root p').textContent,
      pre: document.querySelector('pre').textContent,
      value: document.querySelector('input').value,
      placeholder: document.querySelector('input').placeholder,
      span: document.querySelector('span').textContent,
    })`));
    assert.deepEqual(seen, { p: '  설정  ', pre: 'Settings', value: 'Settings', placeholder: '취소', span: 'Unknown label' });
  });

  it('keeps the same text node when the page resets it to English', async () => {
    // Given: a translated text node; When: the page sets it back to English; Then: the node is the same object and shows Korean again
    await evaluate(`window.__koText = document.querySelector('#root p').firstChild; true`);
    const batch = nextBatch();
    await evaluate(`window.__koText.nodeValue = '  Settings  '; true`);
    await batch;
    const seen = JSON.parse(await evaluate(`JSON.stringify({
      same: document.querySelector('#root p').firstChild === window.__koText,
      value: window.__koText.nodeValue,
      children: document.querySelector('#root p').childNodes.length,
    })`));
    assert.deepEqual(seen, { same: true, value: '  설정  ', children: 1 });
  });

  it('stops touching a node that flips back to English more than three times in a second', async () => {
    // Given: an element translated once; When: it flips back to English four times in one turn; Then: it stays English
    const added = nextBatch();
    await evaluate(`var em = document.createElement('em'); em.textContent = 'Cancel'; document.getElementById('root').append(em); window.__koEm = em.firstChild; true`);
    await added;
    const flipped = nextBatch();
    await evaluate(`for (var i = 0; i < 4; i += 1) window.__koEm.nodeValue = 'Cancel'; true`);
    await flipped;
    assert.equal(await evaluate(`window.__koEm.nodeValue`), 'Cancel');
  });

  it('throws no exception from the page script', () => {
    // Given: the three scenarios above have run; When: the exception log is read; Then: it is empty
    assert.equal(exceptions, 0);
    assert.deepEqual(deliverErrors, []);
  });
});

describe('host translate matches translate.mjs', () => {
  it('returns the same strings as translateText on one case table', () => {
    // Given: exact, whitespace-padded, unregistered and inherited-key inputs; When: the host translates them; Then: each equals translateText
    const cases = ['Settings', '  Cancel\t\n', 'Settings page', 'Unknown label', '   ', 'constructor'];
    assert.deepEqual(handle('translate', [cases]), cases.map((t) => translateText(t, ENTRIES)));
    assert.equal(translateText('  Cancel\t\n', ENTRIES), '  취소\t\n');
  });
});
