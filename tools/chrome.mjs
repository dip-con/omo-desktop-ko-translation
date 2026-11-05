// Shared local-test helpers: one headless Chrome with a temp profile and a loopback DevTools port, and its shutdown.
// The port comes from the loader's pickLoopbackPort, which skips the ports Node's WebSocket and fetch refuse.
// Needs Chrome at the path below (or OMO_CHROME); never touches the app.
import fs from 'node:fs';
import { importLoader } from './loader-import.mjs';
import { spawn } from 'node:child_process';
const pickLoopbackPort = async (...args) => (await importLoader('launch.mjs')).pickLoopbackPort(...args);

export const CHROME = process.env.OMO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const CHROME_WAIT_MS = 20000;

export function chromeArgs(profile, port) {
  return [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio', '--window-size=1200,800', 'about:blank',
  ];
}

// Starts Chrome with a temp profile on a picked loopback port; resolves the browser websocket URL once Chrome publishes its endpoint.
export async function launchChrome(profile, { pick = pickLoopbackPort, spawnChrome = spawn } = {}) {
  const port = await pick();
  const proc = spawnChrome(CHROME, chromeArgs(profile, port), { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome did not publish a DevTools endpoint')), CHROME_WAIT_MS);
    let buf = '';
    proc.stderr.on('data', (chunk) => {
      buf += chunk.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.once('exit', () => reject(new Error('Chrome exited before publishing an endpoint')));
  });
  return { proc, wsUrl };
}

// Removes a test's temp dir. Chrome can still hold the profile for a moment after the kill, so a failed removal is ignored.
export function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // left behind: the profile is only a temp copy and must not fail the test
  }
}

// Kills only the Chrome this helper started (by its child process handle).
export function killChrome(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, CHROME_WAIT_MS);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill();
  });
}
