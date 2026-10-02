// Runs background.js in a Node VM against an in-memory fake of the Chrome APIs it uses.
// Run from the repo root: node test/background.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HOST = 'demo.service-now.com';
const ORIGIN = `https://${HOST}/*`;
const EXT = 'chrome-extension://ext/';
const POPUP = { id: 'ext', url: `${EXT}popup.html` };
const PAGE = (tabId) => ({ id: 'ext', url: `https://${HOST}/now/build`, tab: { id: tabId } });
const tick = () => new Promise((r) => setTimeout(r, 15));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

function event() {
  const fns = [];
  return { addListener: (fn) => fns.push(fn), fire: (...a) => fns.map((fn) => fn(...a)) };
}

function area(name, onChanged) {
  const data = {};
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    data,
    async get(keys) {
      if (keys == null) return clone(data);
      if (typeof keys === 'string') return keys in data ? { [keys]: clone(data[keys]) } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, clone(data[k])]));
      return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? clone(data[k]) : d]));
    },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) { changes[k] = { oldValue: data[k], newValue: clone(v) }; data[k] = clone(v); }
      onChanged.fire(changes, name);
    },
    async remove(key) { delete data[key]; },
  };
}

function makeChrome() {
  const onChanged = event();
  const sent = [];
  const injected = [];
  const notes = [];
  const granted = new Set();
  const removed = [];
  const tabs = new Map();
  let tabReply = () => ({ state: 'watching', ok: true });
  const chrome = {
    _: { sent, injected, notes, granted, removed, tabs, setTabReply: (fn) => (tabReply = fn) },
    runtime: { id: 'ext', getURL: (p) => EXT + p, onMessage: event() },
    storage: { onChanged, local: area('local', onChanged), session: area('session', onChanged) },
    tabs: {
      get: async (id) => { if (!tabs.has(id)) throw new Error('No tab'); return tabs.get(id); },
      sendMessage: async (tabId, msg) => { sent.push({ tabId, msg }); return tabReply(tabId, msg); },
      update: async (id) => tabs.get(id),
      onUpdated: event(),
      onRemoved: event(),
    },
    scripting: { executeScript: async (o) => { injected.push(o); } },
    permissions: {
      contains: async ({ origins }) => origins.every((o) => granted.has(o)),
      remove: async ({ origins }) => { origins.forEach((o) => { granted.delete(o); removed.push(o); }); return true; },
      onAdded: event(),
      onRemoved: event(),
    },
    notifications: { create: (id, o) => notes.push(o), clear() {}, onClicked: event() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    windows: { update: async () => {} },
  };
  return chrome;
}

async function load(preset = {}) {
  const chrome = makeChrome();
  Object.assign(chrome.storage.local.data, structuredClone(preset));
  const ctx = vm.createContext({ chrome, console, structuredClone, setTimeout, URL });
  ctx.globalThis = ctx;
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }));
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  await settle();
  const send = (msg, sender) =>
    new Promise((resolve) => {
      const results = chrome.runtime.onMessage.fire(msg, sender, (r) => resolve(r));
      if (!results.some((r) => r === true)) setTimeout(() => resolve('no-reply'), 30);
    });
  return { chrome, send, local: chrome.storage.local.data, session: chrome.storage.session.data };
}

const checks = [];
const check = (name, ok, got) => checks.push({ name, ok: !!ok, got });

// Migration of v0.4 labels
{
  const { local } = await load({ allowedTools: ['Plan', 'Run Script', 'Ship it (ship-card)'], customRules: [] });
  check('migrates stored v0.4 labels to trust keys', JSON.stringify(local.allowedTools) === JSON.stringify(['plan:Plan', 'tool:Run Script', 'button:Ship it (ship-card)']), local.allowedTools);
}

// Early v0.5 kept one acknowledgement for all instances: carry it over to the enabled ones
{
  const { local } = await load({ instances: [HOST], riskAccepted: true });
  check('carries a global acknowledgement over to enabled instances', JSON.stringify(local.riskAcceptedHosts) === JSON.stringify([HOST]) && !('riskAccepted' in local), local);
}

// Commands only from extension pages
{
  const { chrome, send, local } = await load({ instances: [HOST], allowedTools: [] });
  chrome._.tabs.set(1, { id: 1, url: `https://${HOST}/now/build`, windowId: 1 });
  chrome._.granted.add(ORIGIN);
  const fromPage = await send({ cmd: 'trust', tabId: 1, key: 'tool:Run Script' }, PAGE(1));
  await settle();
  check('ignores commands from content scripts', fromPage === 'no-reply' && local.allowedTools.length === 0, { fromPage, allowed: local.allowedTools });
  const fromOther = await send({ cmd: 'trust', tabId: 1, key: 'tool:Run Script' }, { id: 'other', url: 'chrome-extension://other/x.html' });
  check('ignores other extensions', fromOther === 'no-reply' && local.allowedTools.length === 0, fromOther);
  const fromPopup = await send({ cmd: 'trust', tabId: 1, key: 'tool:Run Script' }, POPUP);
  await settle();
  check('accepts commands from the popup', !fromPopup?.error && local.allowedTools.includes('tool:Run Script'), { fromPopup, allowed: local.allowedTools });
  check('injects shared.js before content.js', JSON.stringify(chrome._.injected.at(-1)?.files) === JSON.stringify(['shared.js', 'content.js']), chrome._.injected);
  check('starts the tab with the current settings', chrome._.sent.some((s) => s.msg.cmd === 'start' && s.msg.cfg.allowedTools.includes('tool:Run Script')), chrome._.sent);
  const badKey = await send({ cmd: 'trust', tabId: 1, key: 'evil:x' }, POPUP);
  check('refuses unknown trust kinds', /Unknown checkpoint/.test(badKey?.error), badKey);
}

// Permissions
{
  const { chrome, send } = await load({ instances: [HOST] });
  chrome._.tabs.set(1, { id: 1, url: `https://${HOST}/now/build` });
  const res = await send({ cmd: 'startTab', tabId: 1 }, POPUP);
  check('refuses to start without access to the instance', /no longer has access/.test(res?.error) && chrome._.injected.length === 0, res);
  chrome._.tabs.set(2, { id: 2, url: 'https://other.service-now.com/x' });
  chrome._.granted.add('https://other.service-now.com/*');
  const res2 = await send({ cmd: 'startTab', tabId: 2 }, POPUP);
  check('refuses instances that are not enabled', /not an enabled instance/.test(res2?.error), res2);
}

// Enable flow survives the popup closing during the permission prompt
{
  const { chrome, send, local } = await load({ instances: [] });
  await send({ cmd: 'prepareEnable', host: HOST }, POPUP);
  chrome._.granted.add(ORIGIN);
  chrome.permissions.onAdded.fire({ origins: [ORIGIN] });
  await settle();
  check('enables the instance when access is granted', local.instances.includes(HOST) && local.riskAcceptedHosts.includes(HOST) && local.pendingEnable === null, local);
  await send({ cmd: 'disable', host: HOST }, POPUP);
  check('remembers the risk acknowledgement after disabling', !local.instances.includes(HOST) && local.riskAcceptedHosts.includes(HOST), local);
  check('acknowledgement is per instance', !local.riskAcceptedHosts.includes('other.service-now.com'), local.riskAcceptedHosts);
  const res = await send({ cmd: 'enable', host: 'nope.service-now.com' }, POPUP);
  check('refuses to enable without access', /not granted/.test(res?.error), res);
}

// Learned rules from the content script are validated
{
  const { send, local } = await load({ instances: [HOST] });
  await send({ type: 'learned', rule: { host: 'ship-card', selector: '*', text: 'Ship it' } }, PAGE(1));
  await send({ type: 'learned', rule: { host: 'ship-card', selector: 'button.x', text: 'Purge all' } }, PAGE(1));
  await send({ type: 'learned', rule: { host: 'ship-card', selector: 'button.ship', text: 'Ship it', label: 'forged' } }, PAGE(1));
  await settle();
  check('drops learned rules that fail validation', local.customRules.length === 1 && local.customRules[0].selector === 'button.ship', local.customRules);
  check('rebuilds the learned label and trusts it as a button', local.customRules[0].label === 'Ship it (ship-card)' && local.allowedTools.includes('button:Ship it (ship-card)'), local.allowedTools);
}

// Status is session-only, and stop wins over a reconnect
{
  const { chrome, send, local, session } = await load({ instances: [HOST] });
  chrome._.tabs.set(5, { id: 5, url: `https://${HOST}/now/build` });
  chrome._.granted.add(ORIGIN);
  await send({ type: 'status', status: { state: 'watching', total: 3, budget: 3, host: HOST } }, PAGE(5));
  await settle();
  check('keeps run status in session storage only', session['status:5']?.state === 'watching' && !('status:5' in local), { session, local: Object.keys(local) });

  chrome.tabs.onUpdated.fire(5, { status: 'loading' });
  await settle();
  check('marks a watching tab as reconnecting on reload', session['status:5']?.state === 'reconnecting', session['status:5']);
  chrome._.setTabReply(() => { throw new Error('Receiving end does not exist'); });
  await send({ cmd: 'stopTab', tabId: 5 }, POPUP);
  chrome._.setTabReply(() => ({ ok: true }));
  chrome.tabs.onUpdated.fire(5, { status: 'complete' });
  await settle();
  check('stop during a reconnect is not overridden', session['status:5']?.state === 'stopped' && chrome._.injected.length === 0, { status: session['status:5'], injected: chrome._.injected.length });

  await send({ type: 'status', status: { state: 'watching', total: 4, budget: 4, host: HOST } }, PAGE(5));
  chrome.tabs.onUpdated.fire(5, { status: 'loading' });
  chrome.tabs.onUpdated.fire(5, { status: 'complete' });
  await settle();
  const start = chrome._.sent.filter((s) => s.msg.cmd === 'start').at(-1);
  check('reconnects after a reload and carries the counters', start?.msg.carry?.total === 4 && start.msg.carry.budget === 4, start);
}

// Imports are re-parsed in the background
{
  const { send, local } = await load({ allowedTools: ['tool:Write file'] });
  const text = JSON.stringify({ format: 'buildpilot-learnings', version: 2, allowedTools: ['plan:Plan'], customRules: [{ host: 'x-card', selector: 'button.x', text: 'Delete it' }, { host: 'ship-card', selector: 'button.ship', text: 'Ship it' }], ignored: [] });
  const res = await send({ cmd: 'importLearnings', text, mode: 'add' }, POPUP);
  check('imports through the background with validation', !res?.error && local.allowedTools.includes('plan:Plan') && local.customRules.length === 1 && local.allowedTools.includes('tool:Write file'), { res, local });
  const bad = await send({ cmd: 'importLearnings', text: '{nope', mode: 'add' }, POPUP);
  check('reports unreadable imports', /valid JSON/.test(bad?.error), bad);
}

// Disable, limits, history
{
  const { chrome, send, local, session } = await load({ instances: [HOST, 'other.service-now.com'] });
  chrome._.granted.add(ORIGIN);
  session['status:7'] = { state: 'watching', host: HOST };
  await send({ cmd: 'disable', host: HOST }, POPUP);
  check('disable stops runs, removes the instance and its access', !local.instances.includes(HOST) && local.instances.length === 1 && chrome._.removed.includes(ORIGIN) && chrome._.sent.some((s) => s.tabId === 7 && s.msg.cmd === 'stop'), { local, removed: chrome._.removed, sent: chrome._.sent });
  chrome.permissions.onRemoved.fire({ origins: ['https://other.service-now.com/*'] });
  await settle();
  check('access removed in Chrome also disables the instance', local.instances.length === 0, local.instances);

  await send({ cmd: 'setMax', value: 99999 }, POPUP);
  check('clamps the approval limit', local.maxApprovals === 500, local.maxApprovals);

  local.history = [{ at: Date.now() - 31 * 864e5, action: 'approved', label: 'old' }, { at: Date.now() - 864e5, action: 'approved', label: 'recent' }];
  await send({ type: 'log', entry: { at: Date.now(), action: 'approved', label: 'new' } }, PAGE(7));
  await settle();
  check('drops log entries older than 30 days', local.history.map((e) => e.label).join() === 'recent,new', local.history);
  await send({ cmd: 'clearLog' }, POPUP);
  check('clears the log', local.history.length === 0, local.history);

  await send({ type: 'notify', title: 't', message: 'm' }, PAGE(7));
  check('shows notifications from the content script', chrome._.notes.length === 1, chrome._.notes);
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ' -> ' + JSON.stringify(c.got)}`);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
process.exitCode = failed.length ? 1 : 0;
