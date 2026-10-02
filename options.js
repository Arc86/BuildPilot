const $ = (id) => document.getElementById(id);
const S = globalThis.BuildPilotShared;
const KEYS = { allowedTools: [], customRules: [], ignored: [], instances: [] };
const MAX_FILE_BYTES = 200_000;

let incoming = null; // parsed file awaiting confirmation
let incomingText = ''; // the raw file, re-parsed by the background on import

const current = () => chrome.storage.local.get(KEYS);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Splits a learnings set into what the user thinks of as separate things.
// Trust for learned buttons is shown with the button, not as a separate checkpoint.
function parts(set) {
  return {
    trusted: set.allowedTools.filter((k) => S.parseTrustKey(k)?.kind !== 'button'),
    rules: set.customRules,
    ignored: set.ignored,
  };
}

function summary({ trusted, rules, ignored }) {
  const items = [
    trusted.length && plural(trusted.length, 'trusted checkpoint'),
    rules.length && plural(rules.length, 'learned button'),
    ignored.length && plural(ignored.length, 'ignored button'),
  ].filter(Boolean);
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] || 'nothing';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}

async function command(cmd, extra = {}) {
  const res = await chrome.runtime.sendMessage({ cmd, ...extra });
  if (res?.error) throw new Error(res.error);
}

async function render() {
  const c = await current();
  const p = parts(c);
  $('count-trusted').textContent = p.trusted.length;
  $('count-rules').textContent = p.rules.length;
  $('count-ignored').textContent = p.ignored.length;
  $('export-btn').disabled = !c.allowedTools.length && !c.ignored.length;

  $('instances').replaceChildren(
    ...c.instances.map((host) => {
      const li = el('li');
      const off = el('button', 'btn', 'Disable');
      off.onclick = async () => {
        if (confirm(`Disable autopilot on ${host}? It stops any run and removes access to this instance.`)) await command('disable', { host });
      };
      li.append(el('span', 'host', host), off);
      return li;
    }),
  );
  $('instances-empty').hidden = c.instances.length > 0;
}

async function exportLearnings() {
  const { allowedTools, customRules, ignored } = await current();
  const file = Learnings.toFile({ allowedTools, customRules, ignored }, chrome.runtime.getManifest().version);
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  const a = el('a');
  a.href = url;
  a.download = `buildpilot-learnings-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fillList(id, items, render) {
  $(id).replaceChildren(...items.map(render));
  $(`${id}-group`).hidden = items.length === 0;
}

async function renderPreview() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const set = mode === 'replace' ? incoming : Learnings.diff(await current(), incoming);
  const shown = parts(set);
  const count = shown.trusted.length + shown.rules.length + shown.ignored.length;
  const highImpact = set.allowedTools.filter(Learnings.isHighImpact);

  $('preview-title').textContent =
    mode === 'replace'
      ? `Your learnings will be replaced by this file: ${summary(shown)}.`
      : count
        ? `This file adds ${summary(shown)}.`
        : 'Nothing new: you already have everything in this file.';

  fillList('new-trusted', shown.trusted, (key) => {
    const { kind, label } = S.parseTrustKey(key);
    const li = el('li', '', kind === 'plan' ? 'Every plan' : label);
    li.title = S.KINDS[kind];
    if (Learnings.isHighImpact(key)) {
      li.classList.add('high');
      li.append(el('span', 'impact-tag', kind === 'plan' ? 'approves all plans' : 'approves every run'));
    }
    return li;
  });
  fillList('new-rules', shown.rules, (r) => {
    const li = el('li', '', r.text);
    li.append(el('div', 'meta', `${r.host} · ${r.selector}`));
    return li;
  });
  fillList('new-ignored', shown.ignored, (l) => el('li', '', l));
  fillList('skipped', incoming.skipped, (s) => {
    const li = el('li', '', s.item);
    li.append(el('div', 'meta', s.reason));
    return li;
  });

  $('impact-confirm').hidden = highImpact.length === 0;
  $('apply-btn').disabled = (mode === 'add' && count === 0) || (highImpact.length > 0 && !$('impact-check').checked);
}

async function readFile(file) {
  showError(null);
  $('done').hidden = true;
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) return showError('That file is too large to be a learnings file.');
  try {
    incomingText = await file.text();
    incoming = Learnings.parse(incomingText);
  } catch (err) {
    resetImport();
    return showError(err.message);
  }
  $('impact-check').checked = false;
  $('preview').hidden = false;
  await renderPreview();
}

async function applyImport() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const added = parts(Learnings.diff(await current(), incoming));
  try {
    await command('importLearnings', { text: incomingText, mode });
  } catch (err) {
    return showError(err.message);
  }
  $('done').textContent = mode === 'replace' ? 'Imported. Your learnings now match the file.' : `Imported ${summary(added)}.`;
  $('done').hidden = false;
  resetImport();
}

function resetImport() {
  incoming = null;
  incomingText = '';
  $('preview').hidden = true;
  $('file').value = '';
}

function init() {
  $('version').textContent = chrome.runtime.getManifest().version;
  $('export-btn').onclick = exportLearnings;
  $('file').onchange = () => readFile($('file').files[0]);
  $('apply-btn').onclick = applyImport;
  $('cancel-btn').onclick = resetImport;
  $('impact-check').onchange = renderPreview;
  for (const radio of document.querySelectorAll('input[name="mode"]')) radio.onchange = renderPreview;

  const drop = $('drop');
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add('over');
  };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    readFile(e.dataTransfer.files[0]);
  };

  chrome.storage.onChanged.addListener(render);
  render();
}

init();
