const $ = (id) => document.getElementById(id);
const DEFAULTS = { instances: [], allowedTools: [], maxApprovals: 25, history: [] };

let tab;
let host = '';

const statusKey = () => `status:${tab.id}`;
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function settings() {
  return chrome.storage.local.get(DEFAULTS);
}

function showError(err) {
  $('error').textContent = err ? String(err.message || err) : '';
  $('error').hidden = !err;
}

async function sendToTab(msg) {
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return null; // content script not injected on this page
  }
}

function statusText({ state, message }) {
  if (state === 'paused') return `Paused — ${message}`;
  if (state === 'watching') return message && !message.startsWith('Watching') ? `Watching · ${message}` : 'Watching for approval';
  return message && message !== 'Stopped' ? message : 'Not running';
}

async function render() {
  const data = await chrome.storage.local.get({ ...DEFAULTS, [statusKey()]: null });
  const status = data[statusKey()] || { state: 'stopped', total: 0 };
  const supported = host.endsWith('.service-now.com');
  const enabled = data.instances.includes(host);

  $('unsupported').hidden = supported;
  $('enable').hidden = !supported || enabled;
  $('main').hidden = !supported || !enabled;
  document.querySelectorAll('.instance').forEach((el) => (el.textContent = host.split('.')[0]));
  if (!supported || !enabled) return;

  $('status').textContent = statusText(status);
  $('total').textContent = status.total ?? 0;

  $('pending').hidden = !status.pending;
  if (status.pending) {
    $('pending-label').textContent = `New checkpoint: ${status.pending.label}`;
    $('pending-detail').textContent = status.pending.detail || '';
  }

  $('start-btn').textContent = status.state === 'paused' ? 'Resume' : 'Start autopilot';
  $('start-btn').disabled = status.state === 'watching' || status.state === 'reconnecting';
  $('pause-btn').disabled = status.state !== 'watching';
  $('stop-btn').disabled = status.state === 'stopped';

  $('tools').replaceChildren(
    ...data.allowedTools.map((label) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = label;
      const rm = document.createElement('button');
      rm.textContent = '×';
      rm.title = 'Stop auto-approving this checkpoint';
      rm.onclick = () => setAllowed(data.allowedTools.filter((t) => t !== label));
      li.append(span, rm);
      return li;
    }),
  );
  $('tools-empty').hidden = data.allowedTools.length > 0;

  if (document.activeElement !== $('max')) $('max').value = data.maxApprovals;

  $('history').replaceChildren(
    ...data.history
      .filter((e) => e.host === host)
      .slice(-5)
      .reverse()
      .map((e) => {
        const li = document.createElement('li');
        li.textContent = `${time(e.at)} ${e.action}: ${e.label}`;
        return li;
      }),
  );
}

async function setAllowed(allowedTools) {
  await chrome.storage.local.set({ allowedTools });
  await sendToTab({ cmd: 'config', cfg: { allowedTools } });
}

async function start() {
  showError(null);
  const res = await chrome.runtime.sendMessage({ cmd: 'startTab', tabId: tab.id });
  if (res?.error) showError(res.error);
}

async function stop() {
  if (await sendToTab({ cmd: 'stop' })) return;
  // No content script (e.g. mid-reconnect): mark stopped so the background won't re-inject.
  const status = (await chrome.storage.local.get(statusKey()))[statusKey()] || {};
  await chrome.storage.local.set({ [statusKey()]: { ...status, state: 'stopped', reason: '', pending: null, message: 'Stopped' } });
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { host = new URL(tab.url).host; } catch {}

  $('enable-btn').onclick = async () => {
    const { instances } = await settings();
    await chrome.storage.local.set({ instances: [...new Set([...instances, host])] });
  };
  $('start-btn').onclick = start;
  $('pause-btn').onclick = () => sendToTab({ cmd: 'pause' });
  $('stop-btn').onclick = stop;
  $('trust-btn').onclick = async () => {
    const data = await chrome.storage.local.get({ ...DEFAULTS, [statusKey()]: null });
    const label = data[statusKey()]?.pending?.label;
    if (!label) return;
    await chrome.storage.local.set({ allowedTools: [...new Set([...data.allowedTools, label])] });
    await start();
  };
  $('max').onchange = async () => {
    const maxApprovals = Math.max(1, Number($('max').value) || DEFAULTS.maxApprovals);
    await chrome.storage.local.set({ maxApprovals });
    await sendToTab({ cmd: 'config', cfg: { maxApprovals } });
  };
  $('copy-btn').onclick = async () => {
    const { history } = await settings();
    await navigator.clipboard.writeText(JSON.stringify(history.slice(-50), null, 2));
    $('copy-btn').textContent = 'Copied';
  };

  chrome.storage.onChanged.addListener(render);
  render();
}

init();
