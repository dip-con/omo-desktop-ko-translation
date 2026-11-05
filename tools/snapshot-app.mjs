#!/usr/bin/env node
// Launches the installed OmO desktop app with the QA child environment and saves redacted DOM and
// CSS snapshots over CDP: the home screen, one existing conversation (or the empty state), and every
// settings page listed in docs/app-facts.json. Conversation-view exclusion counts are measured too.
// Only the PID this script started, and its descendants captured before close, are ever stopped.
//
// Usage: node tools/snapshot-app.mjs --ev <evidenceDir> --snap <fixturesLiveDir>
// Prints counts only; no page content or titles are printed.
import { isEntry } from './is-entry.mjs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { importLoader, importLoaderTool } from './loader-import.mjs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveApp } from './app-paths.mjs';
import { listProcesses } from './processes.mjs';
const { connect } = await importLoader('cdp.mjs');
const { spawnQaApp, describeQaEnv } = await importLoader('qa-env.mjs');
const { runWithLaunchedApp } = await importLoader('stop-select.mjs');
const { redactHtml, residualScan } = await importLoaderTool('redact.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
// APP_DIR is the app bundle: every OmO process runs an executable inside it.
const { bundle: APP_DIR, resources: RESOURCES, exe: APP_EXE } = await resolveApp();
const CLIENT = path.join(RESOURCES, 'omo-server', 'client');
const BOOT_DONE =
  "(() => { const b = document.querySelector('#boot-shell'); return !b || b.getAttribute('data-boot-shell-state') === 'done'; })()";

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : null;
};
const EV = argOf('--ev');
const SNAP = argOf('--snap');
const EXPECT_VERSION = argOf('--expect-version');
const IS_ENTRY = isEntry(import.meta.url);
if (IS_ENTRY && (!EV || !SNAP)) {
  console.error('usage: node tools/snapshot-app.mjs --ev <evidenceDir> --snap <fixturesLiveDir> [--expect-version <v>]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const shaFile = (p) => sha256(fs.readFileSync(p));

// ---------- timeline (written at every event) ----------
const timeline = { spawnAt: null, pid: null, envRecord: null, browserCloseAt: null, browserCloseError: null, closeTree: [], forcedStops: [], allGoneAt: null, exitedGracefully: null };
const saveTimeline = () => fs.writeFileSync(path.join(EV, 'snapshot-timeline.json'), JSON.stringify(timeline, null, 2) + '\n');

// ---------- QA child environment: built and checked by loader/qa-env.mjs ----------
const OS_HOME = os.userInfo().homedir;
// Local names that must never reach a fixture, passed as options; redaction is skipped when they are absent.
const LOCAL_PROJECT = argOf('--project-name');
const LOCAL_USER = argOf('--user-name');

// ---------- ports and HTTP ----------
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

async function pollUntil(label, fn, timeoutMs) {
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

// ---------- processes (identity by PID + creation time; tree from ps) ----------
function processTable() {
  return listProcesses().map((p) => ({
    ProcessId: p.pid,
    ParentProcessId: p.ppid,
    Name: path.basename(p.exePath),
    CreationDate: new Date(p.createdMs).toISOString(),
    ExecutablePath: p.exePath,
    CommandLine: p.commandLine,
  }));
}

function treeOf(rootPid, all) {
  const ids = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) {
      if (ids.has(p.ParentProcessId) && !ids.has(p.ProcessId)) {
        ids.add(p.ProcessId);
        grew = true;
      }
    }
  }
  return all.filter((p) => ids.has(p.ProcessId));
}

const procRecord = (p) => ({
  pid: p.ProcessId,
  ppid: p.ParentProcessId,
  name: p.Name,
  creation: p.CreationDate,
  exe: p.ExecutablePath,
  cmd: (p.CommandLine ?? '').slice(0, 140),
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function waitGone(pids, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!pids.some(isAlive)) return true;
    await sleep(1000);
  }
  return !pids.some(isAlive);
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
    let node = JSON.parse(json.toString('utf8'));
    for (const seg of inner.split('/')) node = node.files[seg];
    if (!node || node.size === undefined) throw new Error(`asar entry not found: ${inner}`);
    const buf = Buffer.alloc(node.size);
    fs.readSync(fd, buf, 0, node.size, 8 + headerPickle + Number(node.offset));
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- in-page code (self-contained; converted with toString) ----------
function pageCensus() {
  const isConv = (e) => e.hasAttribute('data-conversation-id') || /conversation|\/c\/|\/chat|thread/i.test(e.getAttribute('href') || '');
  const convs = Array.from(document.querySelectorAll('[data-conversation-id], a[href]')).filter(isConv);
  const shape = (s) => s.replace(/[0-9a-f]{8,}/gi, ':id').replace(/\d+/g, ':n');
  const EX = ['pre', 'code', '.ProseMirror', 'textarea', 'input', '[contenteditable]', '[role="log"]', '[role="tree"]', '[role="textbox"]', '[role="listbox"]', '[aria-live]', '[role="article"]', '[data-message-role]', 'button'];
  const count = (s) => {
    try {
      return document.querySelectorAll(s).length;
    } catch (e) {
      return -1;
    }
  };
  const cssPaths = new Set();
  for (const e of performance.getEntriesByType('resource')) if (/\.css(\?|$)/.test(e.name)) cssPaths.add(new URL(e.name).pathname);
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) if (l.href) cssPaths.add(new URL(l.href).pathname);
  return {
    pathname: location.pathname,
    convCount: convs.length,
    convHrefShapes: [...new Set(convs.map((e) => shape(e.getAttribute('href') || 'data-conversation-id')))].slice(0, 10),
    convTitles: convs.map((e) => (e.textContent || '').trim()),
    settingsNav: count('[data-settings-nav-path]'),
    exclusions: Object.fromEntries(EX.map((s) => [s, count(s)])),
    menus: { menubar: count('[role="menubar"]'), menu: count('[role="menu"]') },
    cssPaths: [...cssPaths],
  };
}

function pageSettle(args) {
  return new Promise((resolve) => {
    let target = null;
    if (args.kind === 'nav') {
      target = document.querySelector('[data-settings-nav-path="' + args.value + '"]');
    } else {
      const convs = Array.from(document.querySelectorAll('[data-conversation-id], a[href]')).filter(
        (e) => e.hasAttribute('data-conversation-id') || /conversation|\/c\/|\/chat|thread/i.test(e.getAttribute('href') || ''),
      );
      target = convs[args.index] || null;
    }
    if (!target) return resolve({ found: false });
    let last = Date.now();
    let mutated = false;
    const mo = new MutationObserver(() => {
      mutated = true;
      last = Date.now();
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const start = Date.now();
    target.click();
    const t = setInterval(() => {
      const settled = mutated && Date.now() - last > 500;
      if (settled || Date.now() - start > args.timeoutMs) {
        clearInterval(t);
        mo.disconnect();
        resolve({ found: true, mutated, pathname: location.pathname });
      }
    }, 100);
  });
}

// ---------- CDP helpers ----------
async function evalIn(cl, expr, { awaitPromise = false } = {}) {
  const r = await cl.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, { timeoutMs: 60000 });
  if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const callFn = (fn, args) => `(${fn.toString()})(${args === undefined ? '' : JSON.stringify(args)})`;

async function waitForPage(cl, expr, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await evalIn(cl, expr)) return true;
    await sleep(250);
  }
  return false;
}

const summarize = (c) => ({
  pathname: c.pathname,
  convCount: c.convCount,
  convHrefShapes: c.convHrefShapes,
  settingsNav: c.settingsNav,
  exclusions: c.exclusions,
  menus: c.menus,
  cssCount: c.cssPaths.length,
});

// The version this run expects: --expect-version when given, else the installed version. A mismatch is a STOP.
export function resolveExpectVersion(flagValue, installedVersion) {
  const expected = flagValue ?? installedVersion;
  if (installedVersion !== expected) throw new Error(`appVersion ${installedVersion} != ${expected}; STOP`);
  return expected;
}

// ---------- main ----------
async function main() {
  const port = await freePort();


  const pkg = JSON.parse(readAsarFile(path.join(RESOURCES, 'app.asar'), 'package.json').toString('utf8'));
  resolveExpectVersion(EXPECT_VERSION, pkg.version);
  const clientSha = shaFile(path.join(CLIENT, 'index.html'));
  const facts = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'app-facts.json'), 'utf8'));
  const navPaths = facts.settingsNav.paths;
  const fpDir = path.join(SNAP, clientSha);
  fs.mkdirSync(path.join(fpDir, 'css'), { recursive: true });
  fs.mkdirSync(EV, { recursive: true });

  const raw = [];
  const titles = new Set();
  const addTitles = (c) => {
    for (const t of c.convTitles) if (t.length >= 4) titles.add(t);
  };
  const procCaptures = [];
  const captureTree = (label) => {
    const tree = treeOf(rootPid, processTable());
    procCaptures.push({ at: new Date().toISOString(), label, processes: tree.map(procRecord) });
    fs.writeFileSync(path.join(EV, 'snapshot-process-tree.json'), JSON.stringify({ rootPid, captures: procCaptures }, null, 2) + '\n');
    return tree;
  };

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
  let browser = null;
  let cl = null;
  let rootPid = null;
  const result = { clientSha, appVersion: pkg.version, conversation: null, settings: [], homeCensus: null, viewExclusions: {} };
  await runWithLaunchedApp({
    launch: async () => child,
    body: async () => {
    timeline.envRecord = describeQaEnv(env);
    child.on('error', (e) => {
      timeline.spawnError = e.message;
    });
    child.unref();
    rootPid = child.pid;
    timeline.spawnAt = new Date().toISOString();
    timeline.pid = rootPid;
    saveTimeline();

    const version = await pollUntil('/json/version', () => getJson(port, '/json/version'), 90000);
    browser = await connect(version.webSocketDebuggerUrl);
    const isPage = (t) => t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.startsWith('data:');
    const targets = await pollUntil('page target', async () => {
      const l = await getJson(port, '/json/list');
      return l.some(isPage) ? l : null;
    }, 90000);
    const pages = targets.filter(isPage);
    const main = pages.find((t) => t.url.startsWith('omo://')) ?? pages[0];
    cl = await connect(main.webSocketDebuggerUrl);
    await cl.send('Page.enable');
    await cl.send('Runtime.enable');
    if (!(await waitForPage(cl, BOOT_DONE, 120000))) throw new Error('boot shell did not reach done');
    captureTree('after-boot');

    // home
    const home = await evalIn(cl, callFn(pageCensus));
    addTitles(home);
    result.homeCensus = summarize(home);
    raw.push({ name: 'home.html', page: 'home', path: '/', html: await evalIn(cl, 'document.documentElement.outerHTML'), census: home });

    // one existing conversation (click one sidebar item; read-only navigation)
    if (home.convCount > 0) {
      const settle = await evalIn(cl, callFn(pageSettle, { kind: 'conv', index: 0, timeoutMs: 15000 }), { awaitPromise: true });
      const c = await evalIn(cl, callFn(pageCensus));
      addTitles(c);
      result.conversation = { found: true, settle: { found: settle.found, mutated: settle.mutated }, census: summarize(c) };
      raw.push({ name: 'conversation.html', page: 'conversation', path: c.pathname, html: await evalIn(cl, 'document.documentElement.outerHTML'), census: c });
      result.viewExclusions.conversation = c.exclusions;
      result.viewExclusions.conversationMenus = c.menus;
      result.viewExclusions.conversationSettingsNav = c.settingsNav;
    } else {
      result.conversation = { found: false, note: 'no existing conversation in the sidebar; snapshotted the empty-state view' };
      result.viewExclusions.emptyState = home.exclusions;
      raw.push({ name: 'empty-state.html', page: 'empty-state', path: home.pathname, html: await evalIn(cl, 'document.documentElement.outerHTML'), census: home });
    }

    // settings pages (navigation clicks only; no field is typed into, no Save/Apply is clicked)
    const open = await evalIn(cl, "(() => { const t = document.querySelector('[data-settings-trigger]'); if (!t) throw new Error('no settings trigger'); t.click(); return true; })()");
    if (!open) throw new Error('settings did not open');
    if (!(await waitForPage(cl, "document.querySelectorAll('[data-settings-nav-path]').length >= 1", 30000))) throw new Error('settings nav did not appear');
    for (const p of navPaths) {
      const s = await evalIn(cl, callFn(pageSettle, { kind: 'nav', value: p, timeoutMs: 15000 }), { awaitPromise: true });
      const c = await evalIn(cl, callFn(pageCensus));
      addTitles(c);
      const slug = p.replace(/^\/settings\//, '').replace(/[^a-z0-9-]/gi, '-');
      result.settings.push({ path: p, found: s.found, mutated: s.mutated, census: summarize(c) });
      raw.push({ name: `settings-${slug}.html`, page: 'settings', path: p, html: await evalIn(cl, 'document.documentElement.outerHTML'), census: c });
    }
    captureTree('before-close');
    },
    stop: async () => {
    if (cl) cl.close();
    if (rootPid) await closeOwn(rootPid, browser);
    if (browser) browser.close();
    },
  });

  // redact, write, and manifest (titles are used only as redaction needles and never printed)
  const titleList = [...titles];
  const files = [];
  const totals = { path: 0, email: 0, token: 0, account: 0, avatarSrc: 0, title: 0 };
  const residual = { cUsersLiteral: 0, userInPath: 0, atEmail: 0, title: 0 };
  for (const item of raw) {
    let html = item.html;
    const counts = { path: 0, email: 0, token: 0, account: 0, avatarSrc: 0, title: 0 };
    const pass = (r) => {
      for (const k of Object.keys(counts)) counts[k] += r.counts[k];
      html = r.html;
    };
    pass(redactHtml(html, { title: '', projectName: LOCAL_PROJECT, userName: LOCAL_USER }));
    for (const t of titleList) pass(redactHtml(html, { title: t, projectName: LOCAL_PROJECT, userName: LOCAL_USER }));
    const res = residualScan(html, { title: '', projectName: LOCAL_PROJECT, userName: LOCAL_USER });
    for (const t of titleList) res.title += residualScan(html, { title: t, projectName: LOCAL_PROJECT, userName: LOCAL_USER }).title;
    for (const k of Object.keys(counts)) totals[k] += counts[k];
    for (const k of Object.keys(residual)) residual[k] += res[k];
    const outFile = path.join(fpDir, item.name);
    fs.writeFileSync(outFile, html);
    files.push({ file: item.name, page: item.page, path: item.path, bytes: fs.statSync(outFile).size, sha256: shaFile(outFile), redactions: counts, residual: res });
  }
  const cssFiles = [];
  const cssSet = new Set(raw.flatMap((r) => r.census.cssPaths));
  for (const p of cssSet) {
    const src = path.join(CLIENT, p.replace(/^\//, ''));
    if (!fs.existsSync(src)) {
      cssFiles.push({ path: p, missing: true });
      continue;
    }
    const dst = path.join(fpDir, 'css', path.basename(p));
    fs.copyFileSync(src, dst);
    cssFiles.push({ file: `css/${path.basename(p)}`, page: 'css', path: p, bytes: fs.statSync(dst).size, sha256: shaFile(dst) });
  }
  const manifest = {
    at: new Date().toISOString(),
    clientSha,
    appVersion: pkg.version,
    fixtureDir: path.relative(REPO, fpDir).replace(/\\/g, '/'),
    titlesRedacted: titleList.length,
    conversationFound: !!(result.conversation && result.conversation.found),
    files,
    css: cssFiles,
    totals: {
      htmlFiles: files.length,
      htmlBytes: files.reduce((a, f) => a + f.bytes, 0),
      cssFiles: cssFiles.filter((c) => !c.missing).length,
      cssBytes: cssFiles.reduce((a, f) => a + (f.bytes ?? 0), 0),
    },
    redactionTotals: totals,
    residualTotals: residual,
  };
  fs.writeFileSync(path.join(EV, 'snapshot-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(EV, 'snapshot-result.json'), JSON.stringify({ ...result, viewExclusions: result.viewExclusions }, null, 2) + '\n');
  console.log(
    JSON.stringify({
      htmlFiles: files.length,
      cssFiles: manifest.totals.cssFiles,
      conversationFound: manifest.conversationFound,
      titlesRedacted: titleList.length,
      redactionTotals: totals,
      residualTotals: residual,
    }),
  );
}

async function closeOwn(rootPid, browser) {
  const before = treeOf(rootPid, processTable());
  timeline.closeTree = before.map((p) => p.ProcessId);
  if (browser) {
    timeline.browserCloseAt = new Date().toISOString();
    try {
      await browser.send('Browser.close', {}, { timeoutMs: 10000 });
    } catch (e) {
      timeline.browserCloseError = e.message;
    }
  } else if (isAlive(rootPid)) {
    process.kill(rootPid, 'SIGTERM');
  }
  saveTimeline();
  const pids = before.map((p) => p.ProcessId);
  timeline.exitedGracefully = await waitGone(pids, 60000);
  if (timeline.exitedGracefully) timeline.allGoneAt = new Date().toISOString();
  if (!timeline.exitedGracefully) {
    // Only PIDs from the captured tree whose creation time still matches, and whose path is under APP_DIR.
    const now = processTable();
    for (const p of before) {
      if (!isAlive(p.ProcessId)) continue;
      const cur = now.find((x) => x.ProcessId === p.ProcessId && x.CreationDate === p.CreationDate);
      if (!cur || !(cur.ExecutablePath ?? '').startsWith(`${APP_DIR}/`)) continue;
      process.kill(p.ProcessId, 'SIGKILL');
      timeline.forcedStops.push({ at: new Date().toISOString(), ...procRecord(cur) });
    }
    timeline.exitedAfterForce = await waitGone(pids, 15000);
    if (timeline.exitedAfterForce) timeline.allGoneAt = new Date().toISOString();
  }
  saveTimeline();
}

if (IS_ENTRY) main()
  .then(() => {
    fs.writeFileSync(path.join(EV, 'snapshot-done.json'), JSON.stringify({ exitCode: 0, at: new Date().toISOString() }) + '\n');
    process.exitCode = 0;
  })
  .catch((e) => {
    fs.writeFileSync(path.join(EV, 'snapshot-done.json'), JSON.stringify({ exitCode: 1, error: e.message, at: new Date().toISOString() }) + '\n');
    process.exitCode = 1;
  });
