// Process table for the QA scripts (macOS): one `ps` pass for the executable path, one for the command line.
// On macOS `comm` is the full executable path. Start times come from `lstart` (second precision, local time).
import { execFileSync } from 'node:child_process';

const ROW = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

// Pure: rows of `ps -o pid=,ppid=,lstart=,<field>=` as { pid, ppid, createdMs, rest }; unparsable lines are skipped.
export function parsePsRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = ROW.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), createdMs: Date.parse(m[3]), rest: m[4].trimEnd() });
  }
  return rows;
}

function ps(field) {
  return execFileSync('ps', ['-axww', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', `${field}=`], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    timeout: 15000,
  });
}

// Every process: { pid, ppid, exePath, commandLine, createdMs }.
export function listProcesses() {
  const commands = new Map(parsePsRows(ps('args')).map((r) => [r.pid, r.rest]));
  return parsePsRows(ps('comm')).map((r) => ({ pid: r.pid, ppid: r.ppid, exePath: r.rest, commandLine: commands.get(r.pid) ?? '', createdMs: r.createdMs }));
}
