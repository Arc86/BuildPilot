// End-to-end test: loads the real extension in Chromium and checks reconnect-after-reload.
// Run from the repo root: NODE_PATH="$(npm root -g)" node test/e2e.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HOST = 'buildagent.test';

// Serve the repo so test pages load from a real origin.
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// Copy the extension and grant it the test host instead of service-now.com.
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'buildpilot-'));
for (const f of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.css', 'popup.js']) fs.copyFileSync(path.join(ROOT, f), path.join(ext, f));
fs.cpSync(path.join(ROOT, 'icons'), path.join(ext, 'icons'), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json')));
manifest.host_permissions = [`http://${HOST}/*`];
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest));

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${port}`],
});
const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));

const checks = [];
const check = (name, ok, got) => checks.push({ name, ok: !!ok, got });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(250);
  }
  return null;
}

try {
  await sw.evaluate((host) => chrome.storage.local.set({ instances: [host], allowedTools: ['Write file', 'Run command'], maxApprovals: 25 }), HOST);
  const page = await context.newPage();
  await page.goto(`http://${HOST}/test/e2e.html`);
  const tabId = await sw.evaluate(async (host) => (await chrome.tabs.query({ url: `http://${host}/*` }))[0].id, HOST);
  const status = () => sw.evaluate(async (id) => (await chrome.storage.local.get(`status:${id}`))[`status:${id}`], tabId);
  const clicks = () => page.evaluate(() => window.__clicks);

  // 1. Start from the background, as the popup does.
  const res = await sw.evaluate((id) => startTab(id).then(() => 'ok', (e) => e.message), tabId);
  check('starts on enabled instance', res === 'ok', res);
  check('approves both checkpoints', await waitFor(async () => (await clicks()).length === 2), await clicks());

  // 2. Reload while watching: should reconnect and keep counting.
  await page.reload();
  const s = await waitFor(async () => { const st = await status(); return st?.state === 'watching' && st.total === 4 && st; });
  check('reconnects after reload and keeps total', s, await status());
  check('approves checkpoints on the reloaded page', (await clicks()).length === 2, await clicks());
  const { history } = await sw.evaluate(() => chrome.storage.local.get('history'));
  check('logs the reconnect', history.some((e) => e.action === 'reconnected'), history.map((e) => e.action));

  // 3. Reload while paused by the user: should stop, not resume.
  await waitFor(async () => (await clicks()).length === 2);
  await sw.evaluate((id) => chrome.tabs.sendMessage(id, { cmd: 'pause' }), tabId);
  await page.reload();
  await sleep(3000);
  check('stays stopped after reload while paused', (await status()).state === 'stopped', await status());
  check('no approvals after paused reload', (await clicks()).length === 0, await clicks());

  // 4. Navigating to a host that isn't enabled stops the run.
  await sw.evaluate((id) => startTab(id), tabId);
  await waitFor(async () => (await clicks()).length === 2);
  await page.goto(`http://127.0.0.1:${port}/test/e2e.html`);
  const left = await waitFor(async () => { const st = await status(); return st?.state === 'stopped' && st; });
  check('stops when leaving the enabled instance', left && /not an enabled instance/.test(left.message), await status());
} finally {
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ' -> ' + JSON.stringify(c.got)}`);
  await context.close();
  server.close();
  fs.rmSync(ext, { recursive: true, force: true });
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
}
