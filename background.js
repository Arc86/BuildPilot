// Build Agent Autopilot — service worker.
// Starts the content script, reconnects it after page reloads, persists per-tab status
// and history, and shows notifications and the toolbar badge.
// Holds no state in memory: Chrome may stop this worker at any time.

const HISTORY_MAX = 200;
const DEFAULTS = { instances: [], allowedTools: [], maxApprovals: 25 };
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

// Used by the popup's Start/Resume and by reconnects after a reload.
// `carry` keeps the approval counters so a reload can't reset the approval limit.
async function startTab(tabId, carry) {
  const tab = await chrome.tabs.get(tabId);
  const { instances, allowedTools, maxApprovals } = await chrome.storage.local.get(DEFAULTS);
  let host = '';
  try { host = new URL(tab.url).host; } catch {}
  if (!instances.includes(host)) throw new Error(`${host || 'This page'} is not an enabled instance`);
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await chrome.tabs.sendMessage(tabId, { cmd: 'start', cfg: { allowedTools, maxApprovals }, carry });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.cmd === 'startTab') {
    startTab(msg.tabId).then(() => reply({}), (err) => reply({ error: err.message }));
    return true;
  }
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  if (msg.type === 'status') serial(() => setStatus(tabId, msg.status));
  else if (msg.type === 'log') appendHistory(msg.entry);
  else if (msg.type === 'notify') notify(tabId, msg.title, msg.message);
});

chrome.storage.onChanged.addListener((changes) => {
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
