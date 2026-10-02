// Build Agent Autopilot — service worker.
// Starts the content script, reconnects it after page reloads, persists per-tab status
// and history, and shows notifications and the toolbar badge.
// Holds no state in memory: Chrome may stop this worker at any time.

const HISTORY_MAX = 200;
const DEFAULTS = { instances: [], allowedTools: [], customRules: [], ignored: [], maxApprovals: 25 };
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

const statusKey = (tabId) => `status:${tabId}`;
const ruleKey = (r) => `${r.host}|${r.selector}|${r.text}`;
const getStatus = async (tabId) => (await chrome.storage.local.get(statusKey(tabId)))[statusKey(tabId)];
const setStatus = (tabId, status) => chrome.storage.local.set({ [statusKey(tabId)]: status });

function appendHistory(entry) {
  return serial(async () => {
    const { history = [] } = await chrome.storage.local.get('history');
    history.push(entry);
    await chrome.storage.local.set({ history: history.slice(-HISTORY_MAX) });
  });
}

function notify(tabId, title, message) {
  chrome.notifications.create(`bp-${tabId}-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 2,
  });
}

// Adds a checkpoint label to the trust list, plus the learned button rule if there is one.
function trust(label, rule) {
  return serial(async () => {
    const { allowedTools, customRules } = await chrome.storage.local.get(DEFAULTS);
    await chrome.storage.local.set({
      allowedTools: [...new Set([...allowedTools, label])],
      customRules: rule ? [...customRules.filter((r) => ruleKey(r) !== ruleKey(rule)), rule] : customRules,
    });
  });
}

function ignore(label) {
  return serial(async () => {
    const { ignored } = await chrome.storage.local.get(DEFAULTS);
    await chrome.storage.local.set({ ignored: [...new Set([...ignored, label])] });
  });
}

// Injects the content script on an enabled instance and returns its config.
async function inject(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const { instances, allowedTools, customRules, ignored, maxApprovals } = await chrome.storage.local.get(DEFAULTS);
  let host = '';
  try { host = new URL(tab.url).host; } catch {}
  if (!instances.includes(host)) throw new Error(`${host || 'This page'} is not an enabled instance`);
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  return { allowedTools, rules: customRules, ignored, maxApprovals };
}

// Used by the popup's Start/Resume and by reconnects after a reload.
// `carry` keeps the approval counters so a reload can't reset the approval limit.
async function startTab(tabId, carry) {
  const cfg = await inject(tabId);
  await chrome.tabs.sendMessage(tabId, { cmd: 'start', cfg, carry });
}

async function teachTab(tabId) {
  const cfg = await inject(tabId);
  await chrome.tabs.sendMessage(tabId, { cmd: 'teach', cfg });
}

// Popup commands. trust/ignore answer a paused checkpoint, so they resume the run.
const COMMANDS = {
  startTab: (m) => startTab(m.tabId),
  teachTab: (m) => teachTab(m.tabId),
  trust: async (m) => { await trust(m.label, m.rule); await startTab(m.tabId); },
  ignore: async (m) => { await ignore(m.label); await startTab(m.tabId); },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (COMMANDS[msg.cmd]) {
    COMMANDS[msg.cmd](msg).then(() => reply({}), (err) => reply({ error: err.message }));
    return true;
  }
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  if (msg.type === 'status') serial(() => setStatus(tabId, msg.status));
  else if (msg.type === 'log') appendHistory(msg.entry);
  else if (msg.type === 'notify') notify(tabId, msg.title, msg.message);
  else if (msg.type === 'learned') trust(msg.rule.label, msg.rule);
});

// Running tabs keep their own copy of the settings; push changes from the popup or an import.
const CONFIG_KEYS = ['allowedTools', 'customRules', 'ignored', 'maxApprovals'];

async function pushConfig() {
  const all = await chrome.storage.local.get(null);
  const { allowedTools, customRules, ignored, maxApprovals } = { ...DEFAULTS, ...all };
  const cfg = { allowedTools, rules: customRules, ignored, maxApprovals };
  for (const [key, status] of Object.entries(all)) {
    if (!key.startsWith('status:') || !status || status.state === 'stopped') continue;
    chrome.tabs.sendMessage(Number(key.slice('status:'.length)), { cmd: 'config', cfg }).catch(() => {});
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (CONFIG_KEYS.some((k) => k in changes)) pushConfig();
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (!key.startsWith('status:') || !newValue) continue;
    const tabId = Number(key.slice('status:'.length));
    const badge = newValue.state === 'paused' && newValue.reason !== 'user' ? ALERT : BADGE[newValue.state] || BADGE.stopped;
    chrome.action.setBadgeText({ tabId, text: badge.text }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color }).catch(() => {});
  }
});

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
    notify(tabId, 'Autopilot stopped', `Could not reconnect after reload: ${err.message}`);
  }
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') serial(() => onLoading(tabId));
  else if (change.status === 'complete') serial(() => onComplete(tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.local.remove(statusKey(tabId)));

chrome.notifications.onClicked.addListener(async (id) => {
  const tabId = Number(id.split('-')[1]);
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {}
  chrome.notifications.clear(id);
});
