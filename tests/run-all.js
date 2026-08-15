#!/usr/bin/env node
/* =====================================================================
   npm test — runs every check end to end.
   =====================================================================
   Each check gets a freshly seeded throwaway database and its own server
   process. That isolation matters here: the XSS check deliberately plants
   malicious rows in the menu, and the dashboard check works orders through
   to "collected". Sharing one database between them would mean a passing
   run depended on the order they happened to execute in.

   Nothing here touches data/arquero.db.
   ===================================================================== */

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP_DB = path.join(ROOT, 'data', 'test-run.db');
const PORT = process.env.TEST_PORT || 3199;
const BASE_URL = `http://localhost:${PORT}`;
const ADMIN_PASSWORD = 'test-secret-123';

const ENV = {
  ...process.env,
  PORT: String(PORT),
  DB_PATH: TMP_DB,
  ADMIN_PASSWORD,
  SESSION_SECRET: 'test-session-secret-not-for-production',
  BASE_URL,
};

const CHECKS = [
  { name: 'API attacks',        cmd: 'bash', args: ['tests/api-attacks.sh'],
    describe: 'auth, injection, tampering, validation' },
  { name: 'Stored XSS + flows', cmd: 'node', args: ['tests/xss-and-flows.js'],
    describe: 'malicious menu content, apostrophes in names, full order and booking' },
  { name: 'Timezone',           cmd: 'node', args: ['tests/timezone.js'],
    describe: 'a booking made at midnight in Manila saves the right date' },
  { name: 'Accessibility',      cmd: 'node', args: ['tests/a11y-check.js'],
    describe: 'WCAG 2.1 AA across every customer screen and dialog' },
  { name: 'Keyboard',           cmd: 'node', args: ['tests/kb-check.js'],
    describe: 'the whole customer app driven with no mouse' },
  { name: 'Focus handling',     cmd: 'node', args: ['tests/focus.js'],
    describe: 'focus goes somewhere sensible when every sheet closes' },
  { name: 'Staff board',        cmd: 'node', args: ['tests/admin-check.js'],
    describe: 'login, a full shift of status changes, accessibility' },
  { name: 'Cart & ticket',      cmd: 'node', args: ['tests/cart-and-ticket.js'],
    describe: 'the cart survives a refresh, gallery photos, printable tickets' },
  { name: 'Menu management',    cmd: 'node', args: ['tests/menu-admin.js'],
    describe: 'running the menu from the board, and what it refuses to accept' },
];

/* ---------------- helpers ---------------- */

const c = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
};

function removeDatabase() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (e) { /* not there, fine */ }
  }
}

function seed() {
  const result = spawnSync('node', ['server/seed.js'], { cwd: ROOT, env: ENV, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('Could not seed the test database:\n' + (result.stderr || result.stdout));
  }
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE_URL + '/api/health');
      if (res.ok) return true;
    } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

function startServer() {
  return spawn('node', ['server/index.js'], { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}

function stopServer(proc) {
  return new Promise(resolve => {
    if (!proc || proc.exitCode !== null) return resolve();
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} resolve(); }, 6000);
  });
}

function run(check) {
  return new Promise(resolve => {
    const proc = spawn(check.cmd, check.args, { cwd: ROOT, env: ENV, encoding: 'utf8' });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    proc.on('close', code => resolve({ code, out }));
  });
}

/**
 * Most checks assert for themselves and exit non-zero when something is
 * wrong. A few of the older browser scripts still report findings in their
 * output instead, so these patterns catch those too. Anything matching here
 * means the run is not clean, whatever the exit code said.
 */
const FAILURE_MARKERS = [
  /TOTAL violation types across all states:\s*[1-9]/,
  /TOTAL axe violations:\s*[1-9]/,
  /JS errors:\s*(?!none)\S/,
  /ALERT FIRED/,
  /DID NOT SCROLL/,
  /BODY \(bad\)/,
  /under 44px/,
  /pinch-zoom blocked:\s*true/,
  /rows for that slot:\s*(?!1\b)/,
];

function findProblems(out) {
  return FAILURE_MARKERS
    .filter(re => re.test(out))
    .map(re => (out.match(re) || [''])[0].trim());
}

/* ---------------- the run ---------------- */

(async () => {
  const startedAt = Date.now();
  console.log(c.bold("\nArquero's Mountain Resort — full check\n"));
  console.log(c.dim(`  server ${BASE_URL} · throwaway database at data/test-run.db\n`));

  const results = [];

  for (const check of CHECKS) {
    process.stdout.write(`  ${check.name.padEnd(20)} ${c.dim(check.describe)}\n`);

    removeDatabase();
    seed();
    const server = startServer();

    let serverLog = '';
    server.stdout.on('data', d => { serverLog += d; });
    server.stderr.on('data', d => { serverLog += d; });

    if (!(await waitForServer())) {
      await stopServer(server);
      results.push({ check, ok: false, detail: 'the server never became healthy', out: serverLog });
      console.log(`  ${' '.repeat(20)} ${c.red('server would not start')}\n`);
      continue;
    }

    const { code, out } = await run(check);
    await stopServer(server);

    const problems = findProblems(out);
    const ok = code === 0 && problems.length === 0;
    results.push({ check, ok, detail: problems.join(' · ') || (code !== 0 ? `exit code ${code}` : ''), out });

    console.log(`  ${' '.repeat(20)} ${ok ? c.green('passed') : c.red('FAILED')}` +
      (ok ? '' : c.red('  ' + (problems.join(' · ') || `exit ${code}`))) + '\n');
  }

  removeDatabase();

  const failed = results.filter(r => !r.ok);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);

  console.log(c.bold('  ────────────────────────────────────────────'));
  if (failed.length === 0) {
    console.log(`  ${c.green(`All ${results.length} checks passed`)} ${c.dim(`in ${seconds}s`)}\n`);
    process.exit(0);
  }

  console.log(`  ${c.red(`${failed.length} of ${results.length} checks failed`)} ${c.dim(`in ${seconds}s`)}\n`);
  for (const f of failed) {
    console.log(c.yellow(`\n── ${f.check.name} ──`));
    console.log(f.out.trim().split('\n').slice(-40).join('\n'));
  }
  process.exit(1);
})().catch(err => {
  console.error('\nThe test runner itself failed:', err);
  process.exit(1);
});
