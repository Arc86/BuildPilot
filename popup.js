const $ = (id) => document.getElementById(id);
const S = globalThis.BuildPilotShared;
const DEFAULTS = { instances: [], allowedTools: [], customRules: [], ignored: [], maxApprovals: 25, history: [], riskAcceptedHosts: [] };
const REPO = 'https://github.com/Arc86/BuildPilot';
const STATE_LABEL = { watching: 'Watching', paused: 'Paused', reconnecting: 'Reconnecting', stopped: 'Not running', teaching: 'Teaching' };

let tab;
let host = '';

const statusKey = () => `status:${tab.id}`;
const origin = () => `https://${host}/*`;
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const settings = () => chrome.storage.local.get(DEFAULTS);
const getStatus = async () => (await chrome.storage.session.get(statusKey()))[statusKey()];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function showError(err) {
  $('error').textContent = err ? String(err.message || err) : '';
  $('error').hidden = !err;
}

// Every settings change goes through the background, which serialises writes.
async function command(cmd, extra = {}) {
  showError(null);
  const res = await chrome.runtime.sendMessage({ cmd, tabId: tab.id, ...extra });
  if (res?.error) showError(res.error);
  return res;
}

function statusDetail({ state, message, teaching, pending }) {
  if (teaching) return 'Click the button in Build Agent you want autopilot to learn.';
  if (pending) return 'Waiting for your decision below.';
  if (state === 'watching') return message && !message.startsWith('Watching') ? message : 'Approving trusted checkpoints as they appear.';
  if (state === 'stopped') return message && message !== 'Stopped' ? message : 'Click Start once your build is running.';
  return message;
}

// Opens a pre-filled GitHub issue with only the button rule — never card text or instance names.
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

// actions: { text, title, className, onclick }
function chip(text, title, actions) {
  const li = el('li');
  const label = el('span', 'item-label', text);
  label.title = title;
  li.append(label);
  for (const a of actions) {
    const b = el('button', a.className, a.text);
    b.title = a.title;
    b.setAttribute('aria-label', a.title);
    b.onclick = a.onclick;
    li.append(b);
  }
  return li;
}

async function render() {
  const data = await settings();
  const status = (await getStatus()) || { state: 'stopped', total: 0 };
  const supported = host.endsWith('.service-now.com');
  const permitted = supported && (await chrome.permissions.contains({ origins: [origin()] }));
  const enabled = permitted && data.instances.includes(host);

  $('unsupported').hidden = supported;
  $('enable').hidden = !supported || enabled;
  $('main').hidden = !enabled;
  $('setting').hidden = !enabled;
  $('disable-btn').hidden = !enabled;
  document.querySelectorAll('.instance').forEach((n) => (n.textContent = host.split('.')[0]));

  if (supported && !enabled) {
    // The full warning is shown once per instance; re-enabling an acknowledged instance skips it.
    const accepted = data.riskAcceptedHosts.includes(host);
    $('risk').hidden = accepted;
    $('enable-plain').hidden = !accepted;
    $('enable-btn').disabled = !accepted && !$('risk-check').checked;
  }
  if (!enabled) return;

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
    $('pending-risk').hidden = !p.risky;
    $('pending-risk').textContent = p.risky ? `Mentions "${p.risky}": this step may delete data or change access.` : '';
    $('trust-btn').hidden = status.reason !== 'unknown'; // already trusted when paused for risk or a loop
    $('once-btn').classList.toggle('primary', $('trust-btn').hidden);
    $('ignore-btn').hidden = !p.rule; // only buttons detected by their wording can be ignored
  }

  // Show only the controls that apply right now.
  $('start-btn').textContent = status.state === 'paused' ? 'Resume' : 'Start autopilot';
  $('start-btn').hidden = status.state === 'watching' || status.state === 'reconnecting';
  $('pause-btn').hidden = status.state !== 'watching';
  $('stop-btn').hidden = status.state === 'stopped';
  $('teach-btn').disabled = !!status.teaching;
  $('teach-btn').textContent = status.teaching ? 'Waiting for your click…' : 'Teach a button';

  $('tools').replaceChildren(
    ...data.allowedTools.map((key) => {
      const parsed = S.parseTrustKey(key) || { kind: 'tool', label: key };
      const rule = parsed.kind === 'button' && data.customRules.find((r) => r.label === parsed.label);
      const actions = [];
      if (rule) actions.push({ text: 'Report', title: 'Suggest this button for the built-in list on GitHub', className: 'link', onclick: () => chrome.tabs.create({ url: reportUrl(rule) }) });
      actions.push({ text: '×', title: `Stop auto-approving ${parsed.label}`, className: 'icon-btn', onclick: () => command('untrust', { key }) });
      return chip(parsed.label, S.KINDS[parsed.kind], actions);
    }),
  );
  $('tools-empty').hidden = data.allowedTools.length > 0;
  $('tools-count').textContent = data.allowedTools.length || '';

  $('ignored-section').hidden = data.ignored.length === 0;
  $('ignored').replaceChildren(
    ...data.ignored.map((label) =>
      chip(label, 'Ignored button', [{ text: '×', title: `Stop ignoring ${label}`, className: 'icon-btn', onclick: () => command('unignore', { label }) }]),
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
  $('clear-btn').hidden = data.history.length === 0;
}

async function enable() {
  await command('prepareEnable', { host });
  // The permission prompt can close the popup; the background finishes enabling if it does.
  const granted = await chrome.permissions.request({ origins: [origin()] }).catch((err) => showError(err));
  if (granted) await command('enable', { host });
  else if (granted === false) showError('Autopilot needs access to this instance to run.');
  render();
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { host = new URL(tab.url).host; } catch {}
  $('version').textContent = chrome.runtime.getManifest().version;

  $('risk-check').onchange = render;
  $('enable-btn').onclick = enable;
  $('disable-btn').onclick = async () => {
    if (confirm(`Disable autopilot on ${host.split('.')[0]}? It stops any run and removes access to this instance.`)) await command('disable', { host });
  };
  $('start-btn').onclick = () => command('startTab');
  $('pause-btn').onclick = () => chrome.tabs.sendMessage(tab.id, { cmd: 'pause' }).catch(() => {});
  $('stop-btn').onclick = () => command('stopTab');
  $('teach-btn').onclick = () => command('teachTab');
  $('manage-btn').onclick = () => chrome.runtime.openOptionsPage();
  $('trust-btn').onclick = async () => {
    const p = (await getStatus())?.pending;
    if (p) await command('trust', { key: p.key, rule: p.rule });
  };
  $('once-btn').onclick = () => command('approveOnce');
  $('ignore-btn').onclick = async () => {
    const p = (await getStatus())?.pending;
    if (p) await command('ignore', { label: p.label });
  };
  $('max').onchange = () => command('setMax', { value: $('max').value });
  $('copy-btn').onclick = async () => {
    const { history } = await settings();
    const safe = history.slice(-50).map(({ at, action, label }) => ({ at: new Date(at).toISOString(), action, label }));
    await navigator.clipboard.writeText(JSON.stringify(safe, null, 2));
    $('copy-btn').textContent = 'Copied';
  };
  $('clear-btn').onclick = () => command('clearLog');

  chrome.storage.onChanged.addListener(render);
  render();
}

init();
