const $ = (id) => document.getElementById(id);
const KEYS = { allowedTools: [], customRules: [], ignored: [] };
const MAX_FILE_BYTES = 200_000;

let incoming = null; // parsed file awaiting confirmation

const current = () => chrome.storage.local.get(KEYS);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Splits a learnings set into what the user thinks of as separate things.
function parts(set) {
  const ruleLabels = new Set(set.customRules.map((r) => r.label));
  return { trusted: set.allowedTools.filter((l) => !ruleLabels.has(l)), rules: set.customRules, ignored: set.ignored };
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

async function renderTotals() {
  const c = await current();
  const p = parts(c);
  $('count-trusted').textContent = p.trusted.length;
  $('count-rules').textContent = p.rules.length;
  $('count-ignored').textContent = p.ignored.length;
  $('export-btn').disabled = !c.allowedTools.length && !c.ignored.length;
}

async function exportLearnings() {
  const file = Learnings.toFile(await current(), chrome.runtime.getManifest().version);
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
  const shown = parts(mode === 'replace' ? incoming : Learnings.diff(await current(), incoming));
  const count = shown.trusted.length + shown.rules.length + shown.ignored.length;

  $('preview-title').textContent =
    mode === 'replace'
      ? `Your learnings will be replaced by this file: ${summary(shown)}.`
      : count
        ? `This file adds ${summary(shown)}.`
        : 'Nothing new: you already have everything in this file.';

  fillList('new-trusted', shown.trusted, (l) => el('li', '', l));
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
  $('apply-btn').disabled = mode === 'add' && count === 0;
}

async function readFile(file) {
  showError(null);
  $('done').hidden = true;
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) return showError('That file is too large to be a learnings file.');
  try {
    incoming = Learnings.parse(await file.text());
  } catch (err) {
    incoming = null;
    $('preview').hidden = true;
    return showError(err.message);
  }
  $('preview').hidden = false;
  await renderPreview();
}

async function applyImport() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const before = await current();
  const added = parts(Learnings.diff(before, incoming));
  await chrome.storage.local.set(Learnings.merge(before, incoming, mode));
  $('done').textContent = mode === 'replace' ? 'Imported. Your learnings now match the file.' : `Imported ${summary(added)}.`;
  $('done').hidden = false;
  resetImport();
}

function resetImport() {
  incoming = null;
  $('preview').hidden = true;
  $('file').value = '';
}

function init() {
  $('version').textContent = chrome.runtime.getManifest().version;
  $('export-btn').onclick = exportLearnings;
  $('file').onchange = () => readFile($('file').files[0]);
  $('apply-btn').onclick = applyImport;
  $('cancel-btn').onclick = resetImport;
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

  chrome.storage.onChanged.addListener(renderTotals);
  renderTotals();
}

init();
