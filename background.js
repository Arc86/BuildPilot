// Build Agent Autopilot — service worker.
// Starts the content script, reconnects it after page reloads, owns every settings write,
// and shows notifications and the toolbar badge.
// Holds no state in memory: Chrome may stop this worker at any time.
importScripts('shared.js', 'learnings.js');

const S = globalThis.BuildPilotShared;
const HISTORY = { max: 200, maxAgeMs: 30 * 24 * 60 * 60 * 1000 };
const DEFAULTS = { instances: [], allowedTools: [], customRules: [], ignored: [], maxApprovals: 25, history: [], riskAcceptedHosts: [], pendingEnable: null };
const BADGE = {
  watching: { text: 'ON', color: '#1f8a4c' },
  reconnecting: { text: '…', color: '#1f6feb' },
  paused: { text: '||', color: '#c27c0e' },
  stopped: { text: '', color: '#000000' },
};
const ALERT = { text: '!', color: '#c0392b' };

// Serialise storage read-modify-writes. Never await serial() from inside a serial task.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.catch(() => {}).then(fn));
const settings = () => chrome.storage.local.get(DEFAULTS);
const unique = (list) => [...new Set(list)];
const originOf = (host) => `https://${host}/*`;

// Run status lives in session storage: it is cleared when the browser restarts, so a reused
// tab ID can never inherit an old "watching" state and start approving on its own.
const statusKey = (tabId) => `status:${tabId}`;
const getStatus = async (tabId) => (await chrome.storage.session.get(statusKey(tabId)))[statusKey(tabId)];
const setStatus = (tabId, status) => chrome.storage.session.set({ [statusKey(tabId)]: status });

function appendHistory(entry) {
  return serial(async () => {
    const { history } = await settings();
    const cutoff = Date.now() - HISTORY.maxAgeMs;
    await chrome.storage.local.set({ history: [...history.filter((e) => e.at > cutoff), entry].slice(-HISTORY.max) });
  });
}

function notify(tabId, title, message) {
  chrome.notifications.create(`bp-${tabId}-${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 2 });
}

// v0.4 stored bare labels; v0.5 stores "<kind>:<label>" trust keys.
// Early v0.5 builds kept one risk acknowledgement for all instances; it now applies per instance,
// so carry it over to the instances that were enabled at the time.
serial(async () => {
  const { allowedTools, customRules, instances, riskAcceptedHosts } = await settings();
  const migrated = S.migrateTrust(allowedTools, customRules);
  if (migrated.some((k, i) => k !== allowedTools[i])) await chrome.storage.local.set({ allowedTools: migrated });
  const { riskAccepted } = await chrome.storage.local.get('riskAccepted');
  if (riskAccepted !== undefined) {
    await chrome.storage.local.set({ riskAcceptedHosts: unique([...riskAcceptedHosts, ...(riskAccepted ? instances : [])]) });
    await chrome.storage.local.remove('riskAccepted');
  }
});

// --- Content script ----------------------------------------------------------

// Injects the content script on an enabled instance that still grants access, and returns its config.
async function inject(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const { instances, allowedTools, customRules, ignored, maxApprovals } = await settings();
  let host = '';
  try { host = new URL(tab.url).host; } catch {}
  if (!instances.includes(host)) throw new Error(`${host || 'This page'} is not an enabled instance`);
  if (!(await chrome.permissions.contains({ origins: [originOf(host)] }))) {
    throw new Error(`Autopilot no longer has access to ${host}. Enable it again from the popup.`);
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['shared.js', 'content.js'] });
  return { allowedTools, rules: customRules, ignored, maxApprovals };
}

// Used by Start/Resume and by reconnects after a reload.
// `carry` keeps the approval counters so a reload can't reset the approval limit.
async function startTab(tabId, carry) {
  const cfg = await inject(tabId);
  await chrome.tabs.sendMessage(tabId, { cmd: 'start', cfg, carry });
}

async function teachTab(tabId) {
  const cfg = await inject(tabId);
  await chrome.tabs.sendMessage(tabId, { cmd: 'teach', cfg });
}

// Runs in the serial queue so a reconnect in progress can't override it.
function stopTab(tabId) {
  return serial(async () => {
    try {
      await chrome.tabs.sendMessage(tabId, { cmd: 'stop' });
    } catch {
      const status = await getStatus(tabId);
      await setStatus(tabId, { ...status, state: 'stopped', reason: '', pending: null, message: 'Stopped' });
    }
  });
}

// --- Settings writes (all serialised) ------------------------------------------

function update(fn) {
  return serial(async () => chrome.storage.local.set(await fn(await settings())));
}

const trust = (key, rule) =>
  update(({ allowedTools, customRules }) => ({
    allowedTools: unique([...allowedTools, key]),
    customRules: rule ? [...customRules.filter((r) => S.ruleKey(r) !== S.ruleKey(rule)), rule] : customRules,
  }));

// Enabling records that the risks were acknowledged for this instance; disabling keeps that record,
// so re-enabling the same instance doesn't ask again.
const addInstance = (host) =>
  update(({ instances, riskAcceptedHosts }) => ({ instances: unique([...instances, host]), riskAcceptedHosts: unique([...riskAcceptedHosts, host]), pendingEnable: null }));

async function disableInstance(host) {
  const statuses = await chrome.storage.session.get(null);
  for (const [key, status] of Object.entries(statuses)) {
    if (key.startsWith('status:') && status?.host === host && status.state !== 'stopped') await stopTab(Number(key.slice(7)));
  }
  await update(({ instances }) => ({ instances: instances.filter((h) => h !== host) }));
  await chrome.permissions.remove({ origins: [originOf(host)] }).catch(() => {});
}

// Commands from the popup and Learnings page. trust/ignore/approveOnce answer a paused checkpoint.
const COMMANDS = {
  startTab: (m) => startTab(m.tabId),
  teachTab: (m) => teachTab(m.tabId),
  stopTab: (m) => stopTab(m.tabId),
  approveOnce: async (m) => {
    const res = await chrome.tabs.sendMessage(m.tabId, { cmd: 'approveOnce' });
    if (!res?.ok) throw new Error('That checkpoint is no longer on the page.');
  },
  trust: async (m) => {
    const rule = m.rule && !S.checkRule(m.rule) ? { ...m.rule, label: S.ruleLabel(m.rule) } : null;
    const key = rule ? S.trustKey('button', rule.label) : m.key;
    if (!S.parseTrustKey(key)) throw new Error('Unknown checkpoint.');
    await trust(key, rule);
    await startTab(m.tabId);
  },
  ignore: async (m) => {
    await update(({ ignored }) => ({ ignored: unique([...ignored, String(m.label)]) }));
    await startTab(m.tabId);
  },
  untrust: (m) =>
    update(({ allowedTools, customRules }) => {
      const label = S.parseTrustKey(m.key)?.label;
      return { allowedTools: allowedTools.filter((k) => k !== m.key), customRules: customRules.filter((r) => r.label !== label || !m.key.startsWith('button:')) };
    }),
  unignore: (m) => update(({ ignored }) => ({ ignored: ignored.filter((l) => l !== m.label) })),
  setMax: (m) => update(() => ({ maxApprovals: S.clampApprovals(m.value) })),
  clearLog: () => update(() => ({ history: [] })),
  // Enabling needs a permission prompt, which can close the popup before it hears back.
  // prepareEnable records the intent; enable (or permissions.onAdded) completes it.
  prepareEnable: (m) => update(() => ({ pendingEnable: m.host })),
  enable: async (m) => {
    if (!(await chrome.permissions.contains({ origins: [originOf(m.host)] }))) throw new Error('Access to this instance was not granted.');
    await addInstance(m.host);
  },
  disable: (m) => disableInstance(m.host),
  importLearnings: (m) =>
    // Re-parsed here: the page's preview is not trusted as the source of truth.
    update((current) => Learnings.merge(current, Learnings.parse(m.text), m.mode === 'replace' ? 'replace' : 'add')),
};

const isExtensionPage = (sender) => sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg.cmd) {
    if (!isExtensionPage(sender) || !COMMANDS[msg.cmd]) return; // content scripts can't issue commands
    COMMANDS[msg.cmd](msg).then(() => reply({}), (err) => reply({ error: err.message }));
    return true;
  }
  const tabId = sender.tab?.id;
  if (tabId == null || isExtensionPage(sender)) return;
  if (msg.type === 'status') serial(() => setStatus(tabId, msg.status));
  else if (msg.type === 'log') appendHistory(msg.entry);
  else if (msg.type === 'notify') notify(tabId, msg.title, msg.message);
  else if (msg.type === 'learned' && !S.checkRule(msg.rule)) {
    const rule = { host: msg.rule.host, selector: msg.rule.selector, text: msg.rule.text, label: S.ruleLabel(msg.rule) };
    trust(S.trustKey('button', rule.label), rule);
  }
});

// --- Permissions ---------------------------------------------------------------

chrome.permissions.onAdded.addListener(({ origins = [] }) =>
  serial(async () => {
    const { pendingEnable, instances, riskAcceptedHosts } = await settings();
    if (pendingEnable && origins.includes(originOf(pendingEnable))) {
      await chrome.storage.local.set({ instances: unique([...instances, pendingEnable]), riskAcceptedHosts: unique([...riskAcceptedHosts, pendingEnable]), pendingEnable: null });
    }
  }),
);

// Access removed in chrome://extensions also disables the instance.
chrome.permissions.onRemoved.addListener(({ origins = [] }) =>
  update(({ instances }) => ({ instances: instances.filter((h) => !origins.includes(originOf(h))) })),
);

// --- Config push and badge ---------------------------------------------------------

// Running tabs keep their own copy of the settings; push changes from the popup or an import.
const CONFIG_KEYS = ['allowedTools', 'customRules', 'ignored', 'maxApprovals'];

async function pushConfig() {
  const { allowedTools, customRules, ignored, maxApprovals } = await settings();
  const cfg = { allowedTools, rules: customRules, ignored, maxApprovals };
  for (const [key, status] of Object.entries(await chrome.storage.session.get(null))) {
    if (!key.startsWith('status:') || !status || status.state === 'stopped') continue;
    chrome.tabs.sendMessage(Number(key.slice(7)), { cmd: 'config', cfg }).catch(() => {});
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && CONFIG_KEYS.some((k) => k in changes)) pushConfig();
  if (area !== 'session') return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (!key.startsWith('status:') || !newValue) continue;
    const tabId = Number(key.slice(7));
    const badge = newValue.state === 'paused' && newValue.reason !== 'user' ? ALERT : BADGE[newValue.state] || BADGE.stopped;
    chrome.action.setBadgeText({ tabId, text: badge.text }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color }).catch(() => {});
  }
});

// --- Reloads -------------------------------------------------------------------

// A reload kills the content script. If autopilot was watching, re-inject it once the
// page has loaded. A pause (yours or autopilot's) is respected: the run stops instead.
async function onLoading(tabId) {
  const status = await getStatus(tabId);
  if (status?.state === 'watching') {
    await setStatus(tabId, { ...status, state: 'reconnecting', message: 'Page reloaded — reconnecting' });
  } else if (status?.state === 'paused') {
    await setStatus(tabId, { ...status, state: 'stopped', reason: '', pending: null, message: 'Page reloaded while paused — start again' });
  }
}

async function onComplete(tabId) {
  const status = await getStatus(tabId);
  if (status?.state !== 'reconnecting') return;
  try {
    await startTab(tabId, { total: status.total, budget: status.budget });
    appendHistory({ at: Date.now(), host: status.host, action: 'reconnected', label: 'after page reload' });
  } catch (err) {
    await setStatus(tabId, { ...status, state: 'stopped', message: `Could not reconnect: ${err.message}` });
    notify(tabId, 'Autopilot stopped', "Couldn't reconnect after the page reloaded. Open the popup for details.");
  }
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') serial(() => onLoading(tabId));
  else if (change.status === 'complete') serial(() => onComplete(tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(statusKey(tabId)));

chrome.notifications.onClicked.addListener(async (id) => {
  const tabId = Number(id.split('-')[1]);
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {}
  chrome.notifications.clear(id);
});
