const $ = (id) => document.getElementById(id);
const DEFAULTS = { instances: [], allowedTools: [], customRules: [], ignored: [], maxApprovals: 25, history: [] };
const REPO = 'https://github.com/Arc86/BuildPilot';

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

// Runs a background command for this tab and shows its error, if any.
async function command(cmd, extra = {}) {
  showError(null);
  const res = await chrome.runtime.sendMessage({ cmd, tabId: tab.id, ...extra });
  if (res?.error) showError(res.error);
}

function statusText({ state, message, teaching }) {
  if (teaching) return 'Teaching — click the button in Build Agent';
  if (state === 'paused') return `Paused — ${message}`;
  if (state === 'watching') return message && !message.startsWith('Watching') ? `Watching · ${message}` : 'Watching for approval';
  return message && message !== 'Stopped' ? message : 'Not running';
}

// Opens a pre-filled GitHub issue with only the button rule — never plan text or instance names.
function reportUrl(rule) {
  const url = new URL(`${REPO}/issues/new`);
  url.search = new URLSearchParams({
    template: 'new-checkpoint.yml',
    title: `New checkpoint: ${rule.text}`,
    component: rule.host,
    selector: rule.selector,
    button_text: rule.text,
    version: chrome.runtime.getManifest().version,
  });
  return url.href;
}

function listItem(text, actions) {
  const li = document.createElement('li');
  const span = document.createElement('span');
  span.textContent = text;
  li.append(span);
  for (const { label, title, onclick } of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.onclick = onclick;
    li.append(b);
  }
  return li;
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

  const p = status.pending;
  $('pending').hidden = !p;
  if (p) {
    $('pending-label').textContent = `New checkpoint: ${p.label}`;
    $('pending-detail').textContent = p.detail || '';
    $('ignore-btn').hidden = !p.rule; // only detected-by-wording buttons can be ignored
  }

  $('start-btn').textContent = status.state === 'paused' ? 'Resume' : 'Start autopilot';
  $('start-btn').disabled = status.state === 'watching' || status.state === 'reconnecting';
  $('pause-btn').disabled = status.state !== 'watching';
  $('stop-btn').disabled = status.state === 'stopped';
  $('teach-btn').disabled = !!status.teaching;

  $('tools').replaceChildren(
    ...data.allowedTools.map((label) => {
      const rule = data.customRules.find((r) => r.label === label);
      const actions = [];
      if (rule) actions.push({ label: 'Report', title: 'Suggest this button for the built-in list on GitHub', onclick: () => chrome.tabs.create({ url: reportUrl(rule) }) });
      actions.push({ label: '×', title: 'Stop auto-approving this checkpoint', onclick: () => untrust(label) });
      return listItem(label, actions);
    }),
  );
  $('tools-empty').hidden = data.allowedTools.length > 0;

  $('ignored-section').hidden = data.ignored.length === 0;
  $('ignored').replaceChildren(
    ...data.ignored.map((label) =>
      listItem(label, [{ label: '×', title: 'Stop ignoring this button', onclick: () => unignore(label) }]),
    ),
  );

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

async function untrust(label) {
  const { allowedTools, customRules } = await settings();
  const next = { allowedTools: allowedTools.filter((t) => t !== label), customRules: customRules.filter((r) => r.label !== label) };
  await chrome.storage.local.set(next);
  await sendToTab({ cmd: 'config', cfg: { allowedTools: next.allowedTools, rules: next.customRules } });
}

async function unignore(label) {
  const { ignored } = await settings();
  const next = ignored.filter((t) => t !== label);
  await chrome.storage.local.set({ ignored: next });
  await sendToTab({ cmd: 'config', cfg: { ignored: next } });
}

async function stop() {
  if (await sendToTab({ cmd: 'stop' })) return;
  // No content script (e.g. mid-reconnect): mark stopped so the background won't re-inject.
  const status = (await chrome.storage.local.get(statusKey()))[statusKey()] || {};
  await chrome.storage.local.set({ [statusKey()]: { ...status, state: 'stopped', reason: '', pending: null, message: 'Stopped' } });
}

async function pendingCheckpoint() {
  return (await chrome.storage.local.get(statusKey()))[statusKey()]?.pending;
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { host = new URL(tab.url).host; } catch {}

  $('enable-btn').onclick = async () => {
    const { instances } = await settings();
    await chrome.storage.local.set({ instances: [...new Set([...instances, host])] });
  };
  $('start-btn').onclick = () => command('startTab');
  $('pause-btn').onclick = () => sendToTab({ cmd: 'pause' });
  $('stop-btn').onclick = stop;
  $('teach-btn').onclick = () => command('teachTab');
  $('trust-btn').onclick = async () => {
    const p = await pendingCheckpoint();
    if (p) await command('trust', { label: p.label, rule: p.rule });
  };
  $('ignore-btn').onclick = async () => {
    const p = await pendingCheckpoint();
    if (p) await command('ignore', { label: p.label });
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
