#!/usr/bin/env node
// Launches the installed OmO desktop app with the QA child environment, measures it over CDP,
// and writes docs/app-facts.json (happy run). --negative launches without the debug port and
// checks that the port refuses connections. Only the PIDs this script started are ever closed.
//
// Usage: node tools/probe-app.mjs --out <dir> [--negative]
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { importLoader } from './loader-import.mjs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { connect } = await importLoader('cdp.mjs');
const { spawnQaApp, describeQaEnv } = await importLoader('qa-env.mjs');
const { buildAnchors, sectionStamp, assembleExclusions, buildCardStyle, snapshotFacts } = await importLoader('app-facts.mjs');
const { summarizePageShape, pageShapeCollector, openSettings, pollSurface, settingsSurfaceCollector, summarizeSettingsSurface } = await importLoader('page-shape.mjs');
const { measureContentRuns } = await importLoader('content-region.mjs');
const { segmentOf, pathOf } = await importLoader('dom-path.mjs');

// Expression evaluated in the page: the same segmentOf/pathOf source as loader/dom-path.mjs, then pageContentProbe.
const pageContentExpr = () => `(() => { const segmentOf = ${segmentOf.toString()}; const pathOf = ${pathOf.toString()}; return (${pageContentProbe.toString()})(pathOf); })()`;
const {
  assertNoOwnerProcess,
  runWithLaunchedApp,
  selectStopTargets,
  confirmStopTarget,
  stopRecordFor,
  choosePort,
  classifyProbeResults,
} = await importLoader('stop-select.mjs');
const { readConfigAppExe } = await importLoader('deps.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const APP_DIR = path.dirname(readConfigAppExe());
const APP_EXE = `${APP_DIR}/OmO.exe`;
const PLANNING_BUILD = '2026.1024.2';
const SETTINGS_PATHS_MIN = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeoutP = (ms) => new Promise((r) => setTimeout(() => r(false), ms).unref());

// ---------- QA child environment: built and checked by loader/qa-env.mjs ----------
const OS_HOME = os.userInfo().homedir;

// ---------- ports, HTTP polling ----------
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function getJson(port, p) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(2000) });
  if (!r.ok) throw new Error(`${p} HTTP ${r.status}`);
  return r.json();
}

async function pollUntil(label, fn, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  let last = 'no value';
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e.message;
    }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${label}: ${last}`);
}

// ---------- process helpers (identity by ExecutablePath; never by image name) ----------
function psJsonArray(script) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    timeout: 60000,
  });
  if (!out.trim()) return [];
  const v = JSON.parse(out);
  return Array.isArray(v) ? v : [v];
}

// One query per call: pid, parent pid, executable, command line, creation time (ms, UTC).
function queryProcesses() {
  const rows = psJsonArray(
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{n='Created';e={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } }} | ConvertTo-Json -Compress",
  );
  return rows.map((p) => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    exePath: p.ExecutablePath ?? '',
    commandLine: p.CommandLine ?? '',
    createdMs: Date.parse(p.Created),
  }));
}

// One TCP probe: 'refused', 'open', 'timeout' or 'error:<code>'.
function portState(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      s.destroy();
      resolve('timeout');
    }, 2000);
    s.once('connect', () => {
      clearTimeout(timer);
      s.destroy();
      resolve('open');
    });
    s.once('error', (e) => {
      clearTimeout(timer);
      resolve(e.code === 'ECONNREFUSED' ? 'refused' : `error:${e.code}`);
    });
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Closes the app this script started: CDP Browser.close if a browser socket is open, otherwise a
// window close on our own PID. Then polls (bounded) until no process created after launch runs from
// APP_DIR. Survivors are recorded with command line, parent PID and creation time, re-queried by PID,
// and stopped one PID at a time (no tree kill) only when the fresh record still matches.
async function closeOurs(run, browser) {
  if (browser) {
    try {
      await browser.send('Browser.close', {}, { timeoutMs: 10000 });
    } catch (e) {
      run.browserCloseError = e.message;
    }
  } else if (run.pid && isAlive(run.pid)) {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$p = Get-Process -Id ${run.pid} -ErrorAction SilentlyContinue; if ($p) { $null = $p.CloseMainWindow() }`,
    ]);
  }
  const opts = { launchTimeMs: run.launchTimeMs, appDir: APP_DIR, preLaunchPids: run.preLaunchPids };
  const remaining = () => selectStopTargets(queryProcesses(), opts);
  const end = Date.now() + 60000;
  let targets = remaining();
  while (targets.length > 0 && Date.now() < end) {
    await sleep(500);
    targets = remaining();
  }
  run.exitedGracefully = targets.length === 0;
  run.survivors = targets;
  run.stopRecords = [];
  for (const planned of targets) {
    const fresh = queryProcesses().find((p) => p.pid === planned.pid);
    const { confirmed, goneBeforeStop } = stopRecordFor(fresh, planned);
    const rec = { ...planned, confirmed, goneBeforeStop, stopped: false };
    if (confirmed) {
      execFileSync('taskkill', ['/PID', String(planned.pid), '/F']);
      rec.stopped = true;
    }
    run.stopRecords.push(rec);
  }
  if (targets.length > 0) {
    const end2 = Date.now() + 15000;
    let left = remaining();
    while (left.length > 0 && Date.now() < end2) {
      await sleep(500);
      left = remaining();
    }
    run.exitedAfterForce = left.length === 0;
  }
}

// ---------- in-page code (converted to strings with .toString(); no escaping needed) ----------
function pageHomeFacts() {
  const c = (s) => document.querySelectorAll(s).length;
  const ex = ['pre', 'code', '.ProseMirror', 'textarea', 'input', '[contenteditable]', '[role="log"]', '[role="tree"]'];
  const boot = document.querySelector('#boot-shell');
  return {
    href: location.href,
    title: document.title,
    bootShell: boot ? boot.getAttribute('data-boot-shell-state') : 'absent',
    anchors: {
      root: c('#root'),
      settingsTrigger: c('[data-settings-trigger]'),
      sidebarNavItem: c('[data-sidebar-nav-item]'),
      settingsNavPath: c('[data-settings-nav-path]'),
    },
    exclusions: Object.fromEntries(ex.map((s) => [s, c(s)])),
    menus: { menubar: c('[role="menubar"]'), menu: c('[role="menu"]') },
  };
}

function pageNavInfo() {
  const nav = Array.from(document.querySelectorAll('[data-settings-nav-path]'));
  const style = (e) => {
    const cs = getComputedStyle(e);
    return {
      tag: e.tagName.toLowerCase(),
      color: cs.color,
      background: cs.backgroundColor,
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      borderTopWidth: cs.borderTopWidth,
      borderRadius: cs.borderRadius,
      borderTop: cs.borderTop,
      padding: cs.padding,
    };
  };
  return {
    count: nav.length,
    paths: nav.map((e) => e.getAttribute('data-settings-nav-path')),
    item: nav[0] ? style(nav[0]) : null,
    container: nav[0] && nav[0].parentElement ? style(nav[0].parentElement) : null,
    card: document.querySelector('[data-settings-surface="outer"]') ? style(document.querySelector('[data-settings-surface="outer"]')) : null,
  };
}

async function pageContentProbe(pathOf) {
  const SAFE = /^[a-z0-9:_\/.-]{1,40}$/i;
  const countById = (id) => document.querySelectorAll('[id="' + id + '"]').length;
  // One node per ancestor-or-self, outermost first; each key is the path from the document element down.
  const chainOf = (el) => {
    const nodes = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) nodes.unshift(e);
    return nodes.map((e) => ({ key: pathOf(e, countById), tag: e.tagName.toLowerCase(), id: e.id && SAFE.test(e.id) ? e.id : null }));
  };
  const navs = Array.from(document.querySelectorAll('[data-settings-nav-path]'));
  if (navs.length < 2) return { error: 'need at least 2 settings nav items' };
  const first = navs[0];
  const second = navs[1];
  // navRoot is the lowest common ancestor of ALL nav items, so changes inside any nav item are not content.
  let navRoot = first.parentElement;
  for (const n of navs) while (!navRoot.contains(n)) navRoot = navRoot.parentElement;
  const navKeys = new Set();
  for (const n of navs) for (const node of chainOf(n)) navKeys.add(node.key);
  const navRootKey = chainOf(navRoot).pop().key;
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const muts = [];
    const mo = new MutationObserver((recs) => {
      for (const rec of recs) {
        const t = rec.target.nodeType === 1 ? rec.target : rec.target.parentElement;
        if (t && !navRoot.contains(t)) muts.push(t);
      }
    });
    mo.observe(document.body, { subtree: true, childList: true, characterData: true });
    second.click();
    const end = Date.now() + 5000;
    while (muts.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    mo.disconnect();
    const appRoot = document.querySelector('#root');
    const live = muts.filter((m) => m.isConnected && appRoot && appRoot.contains(m));
    runs.push({
      mutations: muts.length,
      liveMutations: live.length,
      targets: live.map(chainOf),
      navKeys: Array.from(navKeys),
      navRootKey,
    });
    first.click();
    await new Promise((r) => setTimeout(r, 500));
  }
  return { runs };
}

function injectProbe() {
  const MARK = 'data-omo-mod-probe';
  const place = () => {
    if (document.querySelector('[' + MARK + ']')) return;
    const nav = document.querySelector('[data-settings-nav-path]');
    if (!nav || !nav.parentElement) return;
    const el = document.createElement('div');
    el.setAttribute(MARK, 'PROBE');
    el.textContent = 'PROBE';
    el.style.cssText = 'padding:4px 8px;font-size:12px;opacity:0.7;';
    nav.parentElement.appendChild(el);
  };
  place();
  new MutationObserver(place).observe(document, { childList: true, subtree: true });
}

// ---------- CDP helpers ----------
async function evalIn(cl, expr, { awaitPromise = false, contextId } = {}) {
  const r = await cl.send(
    'Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise, contextId },
    { timeoutMs: 30000 },
  );
  if (r.exceptionDetails) {
    throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result.value;
}

const callFn = (fn) => `(${fn.toString()})()`;

async function waitForPage(cl, expr, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await evalIn(cl, expr)) return true;
    await sleep(250);
  }
  return false;
}

async function shot(cl, file) {
  const r = await cl.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs: 30000 });
  const buf = Buffer.from(r.data, 'base64');
  fs.writeFileSync(file, buf);
  return { file: path.basename(file), bytes: buf.length };
}

async function bindingRoundTrip(cl) {
  const tree = await cl.send('Page.getFrameTree');
  const frameId = tree.frameTree.frame.id;
  const nonce = crypto.randomUUID();
  cl.on('Runtime.bindingCalled', async (p) => {
    if (p.name !== '__omoModsCall') return;
    await cl.send('Runtime.evaluate', {
      contextId: p.executionContextId,
      expression: `globalThis.__omoModsResolve(${JSON.stringify('ack:' + p.payload)})`,
    });
  });
  await cl.send('Runtime.addBinding', { name: '__omoModsCall', executionContextName: 'omo-mods' });
  const { executionContextId } = await cl.send('Page.createIsolatedWorld', {
    frameId,
    worldName: 'omo-mods',
    grantUniveralAccess: false,
  });
  await cl.send('Runtime.evaluate', {
    contextId: executionContextId,
    expression: `globalThis.__omoRT = new Promise((r) => { globalThis.__omoModsResolve = r; }); globalThis.__omoModsCall(${JSON.stringify(nonce)}); 'sent'`,
    returnByValue: true,
  });
  const r = await cl.send(
    'Runtime.evaluate',
    { contextId: executionContextId, expression: 'globalThis.__omoRT', awaitPromise: true, returnByValue: true },
    { timeoutMs: 15000 },
  );
  const mainWorld = await evalIn(cl, "typeof window.__omoModsCall");
  return { roundTrip: r.result.value === 'ack:' + nonce, mainWorldTypeof: mainWorld };
}

// ---------- app fingerprint (asar header read in memory only) ----------
function readAsarFile(asarPath, inner) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerPickle = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonLen);
    fs.readSync(fd, json, 0, jsonLen, 16);
    const header = JSON.parse(json.toString('utf8'));
    let node = header;
    for (const seg of inner.split('/')) node = node.files[seg];
    if (!node || node.size === undefined) throw new Error(`asar entry not found: ${inner}`);
    const buf = Buffer.alloc(node.size);
    fs.readSync(fd, buf, 0, node.size, 8 + headerPickle + Number(node.offset));
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function fingerprint() {
  const pkg = JSON.parse(readAsarFile(`${APP_DIR}/resources/app.asar`, 'package.json').toString('utf8'));
  const bm = JSON.parse(fs.readFileSync(`${APP_DIR}/resources/omo-runtime/win32-x64/bundle-manifest.json`, 'utf8'));
  return {
    appVersion: pkg.version,
    client: shaFile(`${APP_DIR}/resources/omo-server/client/index.html`),
    runtime: { omoRef: bm.omoRef, omoSha: bm.resolvedShas && bm.resolvedShas.omo },
    plugin: shaFile(`${APP_DIR}/resources/omo-runtime/win32-x64/plugin/extensions/omo.js`),
  };
}

// Writes docs/app-facts.json. The probe generates the keys in `facts`; any other key already in the file
// (hand-added, e.g. profilePickup) is kept after them.
export function writeAppFacts(repoDir, facts) {
  const file = path.join(repoDir, 'docs', 'app-facts.json');
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const kept = Object.fromEntries(Object.entries(prev).filter(([k]) => !(k in facts)));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...facts, ...kept }, null, 2) + '\n');
}

// ---------- modes ----------
const INJECT_CODE = `(${injectProbe.toString()})()`;

async function happy(outDir) {
  const port = await freePort();
  const preLaunch = queryProcesses();
  try {
    assertNoOwnerProcess(preLaunch, { appDir: APP_DIR });
  } catch (e) {
    console.error(`owner check failed: ${e.message}`);
    process.exitCode = 4;
    return;
  }
  const launchTimeMs = Date.now();
  let launched;
  try {
    launched = spawnQaApp(spawn, APP_EXE, { parentEnv: process.env, osHome: OS_HOME, port });
  } catch (e) {
    if (e.exitCode !== 4) throw e;
    console.error(`child env check failed: ${e.violations.join('; ')}`);
    process.exitCode = 4;
    return;
  }
  const { child, env } = launched;
  let run = null;
  const save = () => fs.writeFileSync(path.join(outDir, 'run-happy.json'), JSON.stringify(run, null, 2) + '\n');
  const step = (s) => {
    run.steps.push({ at: new Date().toISOString(), s });
    save();
  };
  let browser = null;
  let cl = null;
  await runWithLaunchedApp({
    launch: async () => launched,
    body: async () => {
    run = { mode: 'happy', port, launchTimeMs, pid: child.pid, preLaunchPids: preLaunch.map((p) => p.pid), steps: [] };
    run.childEnv = describeQaEnv(env);
  try {
    child.on('error', (e) => {
      run.spawnError = e.message;
    });
    child.unref();
    run.pid = child.pid;
    step(`spawned pid ${child.pid}`);

    const version = await pollUntil('/json/version', () => getJson(port, '/json/version'));
    run.browserVersion = { Browser: version.Browser, webSocketDebuggerUrl: version.webSocketDebuggerUrl };
    browser = await connect(version.webSocketDebuggerUrl);
    step('browser socket open');

    const targets = await pollUntil('page target', async () => {
      const l = await getJson(port, '/json/list');
      return l.some((t) => t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.startsWith('data:')) ? l : null;
    });
    run.targets = targets.map((t) => ({ type: t.type, url: t.url, title: t.title }));
    const pages = targets.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.startsWith('data:'));
    const main = pages.find((t) => t.url.startsWith('omo://')) ?? pages[0];
    run.mainTargetRule = pages.some((t) => t.url.startsWith('omo://')) ? 'first page with omo:// scheme' : 'first page (no omo:// target seen)';
    run.mainTargetUrl = main.url;

    cl = await connect(main.webSocketDebuggerUrl);
    await cl.send('Page.enable');
    await cl.send('Runtime.enable');
    step(`attached main target ${main.url}`);

    const bootDone = await waitForPage(
      cl,
      "(() => { const b = document.querySelector('#boot-shell'); return !b || b.getAttribute('data-boot-shell-state') === 'done'; })()",
      90000,
    );
    if (!bootDone) throw new Error('boot shell did not reach done');
    const home = await evalIn(cl, callFn(pageHomeFacts));
    let measuredAt = sectionStamp({}, 'exclusions');
    step('measured home');
    run.homeShape = summarizePageShape(await evalIn(cl, callFn(pageShapeCollector)));

    await openSettings({ evalIn, cl, record: run, collect: () => evalIn(cl, callFn(pageShapeCollector)) });
    await waitForPage(cl, "document.querySelectorAll('[data-settings-nav-path]').length >= 1", 30000);
    const surfacePoll = await pollSurface({ evalIn, cl });
    run.cardFound = surfacePoll.found;
    run.cardPolledMs = surfacePoll.polledMs;
    run.settingsSurface = summarizeSettingsSurface(await evalIn(cl, callFn(settingsSurfaceCollector)));
    const nav = await evalIn(cl, callFn(pageNavInfo));
    const content = measureContentRuns((await evalIn(cl, pageContentExpr(), { awaitPromise: true })).runs);
    measuredAt = sectionStamp(measuredAt, 'settingsNav');
    measuredAt = sectionStamp(measuredAt, 'contentSelector');
    measuredAt = sectionStamp(measuredAt, 'cardStyle');
    step('measured settings nav and content');

    const beforeShot = await shot(cl, path.join(outDir, 'shot-before-injection.png'));
    await cl.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT_CODE });
    await evalIn(cl, INJECT_CODE);
    const injected = await waitForPage(cl, "!!document.querySelector('[data-omo-mod-probe]')", 15000);
    const afterShot = await shot(cl, path.join(outDir, 'shot-after-injection.png'));
    step(`injected=${injected}`);

    const binding = await bindingRoundTrip(cl);
    step(`binding ${JSON.stringify(binding)}`);

    const loaded = new Promise((res) => cl.on('Page.loadEventFired', () => res(true)));
    await cl.send('Page.reload', { ignoreCache: false });
    await Promise.race([loaded, timeoutP(60000)]);
    await waitForPage(cl, "(() => { const b = document.querySelector('#boot-shell'); return !b || b.getAttribute('data-boot-shell-state') === 'done'; })()", 90000);
    const navAfterReload = await evalIn(cl, "document.querySelectorAll('[data-settings-nav-path]').length");
    if (navAfterReload === 0) {
      await openSettings({ evalIn, cl, record: run, collect: () => evalIn(cl, callFn(pageShapeCollector)) });
      await waitForPage(cl, "document.querySelectorAll('[data-settings-nav-path]').length >= 1", 30000);
    }
    const reloadKeepsInjection = await waitForPage(cl, "!!document.querySelector('[data-omo-mod-probe]')", 20000);
    measuredAt = sectionStamp(measuredAt, 'bindingReload');
    step(`reload: nav before=${navAfterReload} injection after reload=${reloadKeepsInjection}`);

    const fp = fingerprint();
    const failures = [];
    if (nav.count < SETTINGS_PATHS_MIN) failures.push(`settingsNav.count ${nav.count} < ${SETTINGS_PATHS_MIN}`);
    if (!reloadKeepsInjection) failures.push('injection did not survive reload');
    if (!binding.roundTrip) failures.push('binding round trip failed');
    if (binding.mainWorldTypeof !== 'undefined') failures.push('binding visible in main world');
    if (!content.ancestor) failures.push(content.unstable ? 'content selector unstable' : 'content selector not measured');
    if (!injected) failures.push('probe not injected');
    if (!main.url.startsWith('omo://')) failures.push('no omo:// main target');

    const facts = {
      verdict: failures.length ? 'blocked' : 'ok',
      failures,
      fingerprint: fp,
      appVersion: fp.appVersion,
      planningBuild: PLANNING_BUILD,
      buildChangedFromPlanning: fp.appVersion !== PLANNING_BUILD,
      mainTarget: main.url.replace(/\/$/, ''),
      mainTargetUrl: main.url,
      mainTargetRule: run.mainTargetRule,
      mainTargetMatchRule: 'match by protocol and host: new URL(u).protocol === "omo:" && new URL(u).host === "app"; never by URL.origin (it is the string "null" for omo://)',
      targetsSeen: run.targets,
      bootShell: home.bootShell,
      anchorCounts: home.anchors,
      anchors: buildAnchors(nav.paths, content.ancestor),
      settingsNav: { count: nav.count, paths: nav.paths },
      contentSelector: content.ancestor,
      contentProbe: content,
      nativeCardStyle: buildCardStyle(nav.card),
      cardFound: run.cardFound,
      cardPolledMs: run.cardPolledMs,
      settingsSurface: run.settingsSurface,
      ...assembleExclusions({ homeCounts: home.exclusions }),
      nativeSurfaces: {
        dom: home.menus,
        native: 'OS-native menus and tray are outside the page; not measurable over CDP',
      },
      ...snapshotFacts(fp.client, fs.existsSync(path.join(REPO, 'fixtures', 'live', String(fp.client))), null),
      contentSelectorSource: 'live-measurement',
      settingsTrigger: { selector: '[data-settings-trigger]', homeCount: home.anchors.settingsTrigger },
      reloadKeepsInjection,
      bindingRoundTrip: binding.roundTrip,
      bindingMainWorldTypeof: binding.mainWorldTypeof,
      screenshots: [beforeShot, afterShot],
      measuredAt,
    };
    run.facts = facts;
    if (facts.verdict === 'ok') writeAppFacts(REPO, facts);
    fs.writeFileSync(path.join(outDir, 'facts-happy.json'), JSON.stringify(facts, null, 2) + '\n');
    step(`verdict ${facts.verdict} ${failures.join('; ')}`);
    if (facts.verdict !== 'ok') process.exitCode = 1;
  } catch (e) {
    run.error = e.message;
    save();
    process.exitCode = 1;
  }
    },
    stop: async () => {
    if (cl) cl.close();
    if (run.pid) {
      await closeOurs(run, browser);
    }
    if (browser) browser.close();
    save();
    },
  });
}

async function negative(outDir) {
  const happyFile = path.join(outDir, 'run-happy.json');
  const happyRecord = fs.existsSync(happyFile) ? JSON.parse(fs.readFileSync(happyFile, 'utf8')) : null;
  let port;
  try {
    port = choosePort(happyRecord, process.argv);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
    return;
  }
  const portBefore = await portState(port);
  if (portBefore !== 'refused') {
    console.error(`port ${port} is not closed before launch: ${portBefore}`);
    process.exitCode = 4;
    return;
  }
  const preLaunch = queryProcesses();
  try {
    assertNoOwnerProcess(preLaunch, { appDir: APP_DIR });
  } catch (e) {
    console.error(`owner check failed: ${e.message}`);
    process.exitCode = 4;
    return;
  }
  const launchTimeMs = Date.now();
  let launched;
  try {
    launched = spawnQaApp(spawn, APP_EXE, { parentEnv: process.env, osHome: OS_HOME });
  } catch (e) {
    if (e.exitCode !== 4) throw e;
    console.error(`child env check failed: ${e.violations.join('; ')}`);
    process.exitCode = 4;
    return;
  }
  const { child, env } = launched;
  let run = null;
  const save = () => fs.writeFileSync(path.join(outDir, 'run-negative.json'), JSON.stringify(run, null, 2) + '\n');
  await runWithLaunchedApp({
    launch: async () => launched,
    body: async () => {
    run = { mode: 'negative', port, portSource: happyRecord ? 'happy-run record' : '--port', portClosedBeforeLaunch: portBefore, launchTimeMs, pid: child.pid, preLaunchPids: preLaunch.map((p) => p.pid), attempts: [] };
    run.childEnv = describeQaEnv(env);
  try {
    child.on('error', (e) => {
      run.spawnError = e.message;
    });
    child.unref();
    run.pid = child.pid;
    run.aliveAtProbe = [];
    for (let i = 0; i < 6; i++) {
      run.aliveAtProbe.push(isAlive(child.pid));
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
        run.attempts.push({ ok: true });
      } catch (e) {
        run.attempts.push({ ok: false, code: e.cause?.code ?? e.code ?? null });
      }
      await sleep(500);
    }
    const cls = classifyProbeResults(run.attempts);
    run.portRefused = cls.allRefused;
    run.anyOpen = cls.anyOpen;
    run.appAliveAtCheck = run.aliveAtProbe.every(Boolean) && isAlive(child.pid);
    run.verdict = run.portRefused && run.appAliveAtCheck ? 'ok: port refused, app running without the variable' : 'FAILED';
    save();
  } catch (e) {
    run.error = e.message;
    process.exitCode = 1;
    save();
  }
    },
    stop: async () => {
    if (run.pid) await closeOurs(run, null);
    save();
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[process.argv.indexOf('--out') + 1];
  if (!out || process.argv.indexOf('--out') < 0) {
    console.error('usage: node tools/probe-app.mjs --out <dir> [--negative]');
    process.exit(2);
  }
  fs.mkdirSync(out, { recursive: true });
  if (process.argv.includes('--negative')) await negative(out);
  else await happy(out);
}
