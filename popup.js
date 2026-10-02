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

const STATE_LABEL = { watching: 'Watching', paused: 'Paused', reconnecting: 'Reconnecting', stopped: 'Not running', teaching: 'Teaching' };

function statusDetail({ state, message, teaching, pending }) {
  if (teaching) return 'Click the button in Build Agent you want autopilot to learn.';
  if (pending) return 'Waiting for your decision below.';
  if (state === 'watching') return message && !message.startsWith('Watching') ? message : 'Approving trusted checkpoints as they appear.';
  if (state === 'stopped') return message && message !== 'Stopped' ? message : 'Click Start once your build is running.';
  return message;
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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// actions: { text, title, className, onclick }
function listItem(text, actions) {
  const li = el('li');
  li.append(el('span', 'item-label', text));
  for (const { text: label, title, className, onclick } of actions) {
    const b = el('button', className, label);
    b.title = title;
    b.setAttribute('aria-label', title);
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
  $('setting').hidden = $('main').hidden;
  document.querySelectorAll('.instance').forEach((el) => (el.textContent = host.split('.')[0]));
  if (!supported || !enabled) return;

  document.body.dataset.state = status.teaching ? 'teaching' : status.state;
  document.body.dataset.reason = status.state === 'paused' ? status.reason || '' : '';
  $('state-label').textContent = STATE_LABEL[document.body.dataset.state] || 'Not running';
  $('status-detail').textContent = statusDetail(status);
  $('total').textContent = status.total ?? 0;

  const p = status.pending;
  $('pending').hidden = !p;
  if (p) {
    $('pending-label').textContent = p.label;
    $('pending-detail').textContent = p.detail || '';
    $('ignore-btn').hidden = !p.rule; // only detected-by-wording buttons can be ignored
  }

  // Show only the controls that apply right now.
  $('start-btn').textContent = status.state === 'paused' ? 'Resume' : 'Start autopilot';
  $('start-btn').hidden = status.state === 'watching' || status.state === 'reconnecting';
  $('pause-btn').hidden = status.state !== 'watching';
  $('stop-btn').hidden = status.state === 'stopped';
  $('teach-btn').disabled = !!status.teaching;
  $('teach-btn').textContent = status.teaching ? 'Waiting for your click…' : 'Teach a button';

  $('tools').replaceChildren(
    ...data.allowedTools.map((label) => {
      const rule = data.customRules.find((r) => r.label === label);
      const actions = [];
      if (rule) actions.push({ text: 'Report', title: 'Suggest this button for the built-in list on GitHub', className: 'link', onclick: () => chrome.tabs.create({ url: reportUrl(rule) }) });
      actions.push({ text: '×', title: `Stop auto-approving ${label}`, className: 'icon-btn', onclick: () => untrust(label) });
      return listItem(label, actions);
    }),
  );
  $('tools-empty').hidden = data.allowedTools.length > 0;
  $('tools-count').textContent = data.allowedTools.length || '';

  $('ignored-section').hidden = data.ignored.length === 0;
  $('ignored').replaceChildren(
    ...data.ignored.map((label) =>
      listItem(label, [{ text: '×', title: `Stop ignoring ${label}`, className: 'icon-btn', onclick: () => unignore(label) }]),
    ),
  );

  if (document.activeElement !== $('max')) $('max').value = data.maxApprovals;

  // Last 3 entries, with consecutive repeats (e.g. several reconnects) folded into one row.
  const recent = [];
  for (const e of data.history.filter((h) => h.host === host).reverse()) {
    const prev = recent.at(-1);
    if (prev && prev.action === e.action && prev.label === e.label) prev.count++;
    else if (recent.length < 3) recent.push({ ...e, count: 1 });
    else break;
  }
  $('history').replaceChildren(
    ...recent.map((e) => {
      const li = el('li');
      const tag = el('span', 'tag', e.action.replace('-', ' '));
      tag.dataset.action = e.action;
      const label = el('span', 'h-label', e.label);
      label.title = e.label;
      if (e.count > 1) label.append(el('span', 'repeat', ` ×${e.count}`));
      li.append(tag, label, el('time', '', time(e.at)));
      return li;
    }),
  );
  $('history-empty').hidden = recent.length > 0;
}

// The background pushes changed settings to running tabs, so these only update storage.
async function untrust(label) {
  const { allowedTools, customRules } = await settings();
  await chrome.storage.local.set({ allowedTools: allowedTools.filter((t) => t !== label), customRules: customRules.filter((r) => r.label !== label) });
}

async function unignore(label) {
  const { ignored } = await settings();
  await chrome.storage.local.set({ ignored: ignored.filter((t) => t !== label) });
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
  $('version').textContent = chrome.runtime.getManifest().version;

  $('enable-btn').onclick = async () => {
    const { instances } = await settings();
    await chrome.storage.local.set({ instances: [...new Set([...instances, host])] });
  };
  $('start-btn').onclick = () => command('startTab');
  $('pause-btn').onclick = () => sendToTab({ cmd: 'pause' });
  $('stop-btn').onclick = stop;
  $('teach-btn').onclick = () => command('teachTab');
  $('manage-btn').onclick = () => chrome.runtime.openOptionsPage();
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
