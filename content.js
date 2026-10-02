// Build Agent Autopilot — content script. Needs shared.js (injected first).
// Injected into the top frame by the background worker. Build Agent's chat lives in
// same-origin nested iframes behind open shadow roots, so we walk both from here.
(() => {
  // After an extension reload the copy already in the page is orphaned: it can no longer
  // talk to the extension. Replace it rather than deferring to it.
  const prev = window.__buildPilot;
  if (prev?.isAlive()) return;
  prev?.dispose();

  const S = globalThis.BuildPilotShared;
  const POLL_MS = 1500;
  const CLICK_TIMEOUT_MS = 60_000;
  const TEACH_MS = 60_000;
  const BURST = { count: 5, windowMs: 60_000 }; // same checkpoint this often → probably a loop

  // Approval buttons observed on a real instance, keyed by the shadow host that renders them.
  // `kind` scopes trust; `label` is fixed for plans since their text varies.
  const CHECKPOINTS = [
    { kind: 'tool', host: 'tool-use', selector: 'button.approve-btn', text: 'Approve' },
    { kind: 'plan', host: 'planning-display', selector: 'button.plan-btn.approve', text: 'Approve plan', label: 'Plan' },
  ];
  // Any other chat button starting with one of these words is surfaced as a possible checkpoint.
  const APPROVAL_WORDS = /^(approve|accept|confirm|proceed|continue|allow)\b/i;

  // Notifications stay generic: card text can contain customer data. Details are in the popup.
  const NOTICE = {
    unknown: 'A new checkpoint needs your decision.',
    risky: 'A step may delete data or change access. Check it before approving.',
    error: 'A sub-agent failed.',
    stuck: "An approval didn't go through.",
    limit: 'Reached your approval limit.',
    burst: 'The same checkpoint keeps coming back. Check the build isn’t looping.',
  };

  let state = 'stopped'; // watching | paused | stopped
  // allowedTools: trust keys ("tool:Run Script"); rules: learned buttons; ignored: candidate labels to skip
  let cfg = { allowedTools: [], rules: [], ignored: [], maxApprovals: 25, idleMinutes: 5 };
  let timer = null;
  let total = 0; // approvals since Start
  let budget = 0; // approvals since Start/Resume, capped by cfg.maxApprovals
  let inFlight = null; // { button, text, label, since } — waiting for the page to react
  let pending = null; // checkpoint awaiting the user's decision
  let pendingButton = null;
  let reason = '';
  let message = '';
  const clicked = new WeakSet();
  const approvedOnce = new WeakSet(); // buttons the user approved from the popup
  const seenFailures = new WeakSet();
  const recentByKey = new Map(); // trust key → recent approval times
  let chatHost = null;
  let lastSig = '';
  let lastChange = 0;
  let idleNotified = false;
  let orphaned = false;
  let teachTimer = null;
  let teachScan = null;
  const teachDocs = new Set();

  function isAlive() {
    try {
      return !orphaned && chrome.runtime?.id !== undefined;
    } catch {
      return false;
    }
  }

  // Shuts this copy down silently: it must not call send(), which is what fails when orphaned.
  function dispose() {
    orphaned = true;
    clearInterval(timer);
    timer = null;
    state = 'stopped';
    endTeach();
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
  }

  window.__buildPilot = { isAlive, dispose };

  function send(msg) {
    if (orphaned) return;
    try {
      chrome.runtime.sendMessage(msg)?.catch?.(() => {});
    } catch {
      dispose();
    }
  }

  // Yields `root` and every open shadow root and same-origin iframe document below it.
  function* roots(root) {
    yield root;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) yield* roots(el.shadowRoot);
      if (el.localName === 'iframe') {
        let doc = null;
        try { doc = el.contentDocument; } catch {}
        if (doc) yield* roots(doc);
      }
    }
  }

  // The chat is the only place autopilot acts. Finding it walks the whole page, so cache it.
  function findChat() {
    if (chatHost?.isConnected && chatHost.shadowRoot) return chatHost;
    chatHost = null;
    for (const r of roots(document)) {
      const host = r.querySelector('chat-view');
      if (host?.shadowRoot) return (chatHost = host);
    }
    return null;
  }

  const buttonText = (b) => b.textContent.trim().replace(/\s+/g, ' ');
  const firstLine = (s) => (s || '').trim().split('\n')[0].trim();

  const isLive = (b, text) =>
    b.isConnected &&
    !b.disabled &&
    b.getAttribute('aria-disabled') !== 'true' &&
    b.getClientRects().length > 0 &&
    buttonText(b) === text;

  // Tag plus up to four stable-looking classes, e.g. "button.btn.primary".
  function selectorFor(el) {
    const classes = [...el.classList]
      .filter((c) => /^[a-z][\w-]*$/i.test(c) && !/hover|focus|active|disabled|loading|selected/i.test(c))
      .slice(0, 4);
    return [el.localName, ...classes].join('.');
  }

  function scan() {
    const approvals = [];
    const failures = [];
    let messages = 0;
    let textLen = 0;
    const chat = findChat();
    if (!chat) return { approvals, failures, sig: '' };

    const rules = cfg.rules.map((r) => ({ ...r, kind: 'button' }));
    for (const r of roots(chat.shadowRoot)) {
      const host = r.host?.localName;
      if (!host) continue;
      textLen += r.textContent.length;
      if (host === 'chat-message') messages++;
      if (host === 'sub-agent-display') {
        const h = r.querySelector('.sub-agent-header');
        if (h && /\bFailed\b/.test(h.textContent)) failures.push(h);
      }

      // Built-in checkpoints, then the user's learned buttons.
      const known = new Set();
      for (const spec of [...CHECKPOINTS, ...rules]) {
        if (spec.host !== host || S.UNSAFE_WORDS.test(spec.text)) continue;
        let found = [];
        try { found = r.querySelectorAll(spec.selector); } catch { continue; }
        for (const b of found) {
          if (buttonText(b) !== spec.text) continue;
          known.add(b);
          if (isLive(b, spec.text)) approvals.push({ button: b, root: r, spec });
        }
      }

      // Anything else that reads like an approval is a candidate. Candidates always ask.
      for (const b of r.querySelectorAll('button, [role="button"]')) {
        if (known.has(b)) continue;
        const text = buttonText(b);
        if (text.length > 40 || !APPROVAL_WORDS.test(text) || S.UNSAFE_WORDS.test(text) || !isLive(b, text)) continue;
        const label = S.ruleLabel({ text, host });
        if (cfg.ignored.includes(label)) continue;
        approvals.push({ button: b, root: r, spec: { kind: 'button', host, selector: selectorFor(b), text, label, candidate: true } });
      }
    }
    return { approvals, failures, sig: `${messages}:${textLen}` };
  }

  // Unless the checkpoint has a fixed label, the first visible line of its card is the label.
  // `text` is the whole card, used for the risky-content check.
  function describe(root, spec) {
    const lines = [];
    for (const el of root.children) {
      if (el.localName === 'style' || el.localName === 'script') continue;
      for (const raw of (el.innerText || '').split('\n')) {
        const t = raw.trim();
        if (t && t !== spec.text && !/^(approve|reject|approve plan)$/i.test(t)) lines.push(t);
      }
    }
    const text = lines.join('\n');
    if (spec.label) return { label: spec.label, detail: lines.join(' · ').slice(0, 200), text };
    return { label: (lines[0] || 'Unnamed tool').slice(0, 80), detail: lines.slice(1).join(' · ').slice(0, 200), text };
  }

  function report() {
    const teaching = teachTimer !== null;
    send({ type: 'status', status: { state, reason, message, total, budget, pending, teaching, host: location.host, at: Date.now() } });
  }

  function log(action, label, detail = '') {
    send({ type: 'log', entry: { at: Date.now(), host: location.host, action, label, detail: String(detail || '').slice(0, 120) } });
  }

  function notify(title, body) {
    send({ type: 'notify', title, message: body });
  }

  function pause(why, text, checkpoint = null, button = null) {
    state = 'paused';
    reason = why;
    message = text;
    pending = checkpoint;
    pendingButton = button;
    log('paused', text, checkpoint?.detail);
    if (why !== 'user') notify('Autopilot paused', NOTICE[why] || text);
    report();
  }

  // True when this key was approved BURST.count times within BURST.windowMs.
  function isBurst(key) {
    const now = Date.now();
    const times = (recentByKey.get(key) || []).filter((t) => now - t < BURST.windowMs);
    recentByKey.set(key, times);
    return times.length >= BURST.count;
  }

  function approve(item, label, detail, key) {
    clicked.add(item.button);
    item.button.click();
    total++;
    budget++;
    recentByKey.set(key, [...(recentByKey.get(key) || []), Date.now()]);
    inFlight = { button: item.button, text: item.spec.text, label, since: Date.now() };
    message = `Approved ${label}`;
    log('approved', label, detail);
    report();
  }

  function tick() {
    if (!isAlive()) return dispose(); // never click with a stale config after an extension reload
    if (state !== 'watching') return;
    const s = scan();

    if (s.sig !== lastSig) {
      lastSig = s.sig;
      lastChange = Date.now();
      idleNotified = false;
    }

    const fresh = s.failures.filter((f) => !seenFailures.has(f));
    fresh.forEach((f) => seenFailures.add(f));
    if (fresh.length) return pause('error', `Sub-agent failed: ${firstLine(fresh[0].textContent)}`);

    if (inFlight) {
      if (!isLive(inFlight.button, inFlight.text)) {
        log('confirmed', inFlight.label);
        inFlight = null;
      } else if (Date.now() - inFlight.since > CLICK_TIMEOUT_MS) {
        const label = inFlight.label;
        inFlight = null;
        return pause('stuck', `Clicked "${label}" but the page did not react within 60s`);
      } else {
        return;
      }
    }

    const next = s.approvals.find((a) => !clicked.has(a.button));
    if (next) {
      const { spec } = next;
      const { label, detail, text } = describe(next.root, spec);
      const key = S.trustKey(spec.kind, label);
      const risky = S.RISKY_CONTENT.exec(text)?.[0] || null;

      if (approvedOnce.has(next.button)) return approve(next, label, detail, key);
      if (budget >= cfg.maxApprovals) return pause('limit', `Reached ${cfg.maxApprovals} approvals — check progress`);

      const rule = spec.candidate ? { host: spec.host, selector: spec.selector, text: spec.text, label } : null;
      const checkpoint = { key, label, detail, rule, risky, kind: spec.kind };
      if (spec.candidate || !cfg.allowedTools.includes(key)) return pause('unknown', `New checkpoint: ${label}`, checkpoint, next.button);
      if (risky) return pause('risky', `"${label}" mentions "${risky}"`, checkpoint, next.button);
      if (isBurst(key)) return pause('burst', `Approved "${label}" ${BURST.count} times in a minute`, checkpoint, next.button);
      return approve(next, label, detail, key);
    }

    if (!s.approvals.length && !idleNotified && Date.now() - lastChange > cfg.idleMinutes * 60_000) {
      idleNotified = true;
      message = `Quiet for ${cfg.idleMinutes} min — finished or waiting for you`;
      notify('Build Agent is quiet', 'It may be finished, or waiting for your answer.');
      report();
    }
  }

  // Teach mode: the next real click on a chat button becomes a learned rule.
  // The user's own click approves it this time; autopilot approves it from then on.
  function attachTeachListeners() {
    for (const r of roots(document)) {
      if (r.nodeType === Node.DOCUMENT_NODE && !teachDocs.has(r)) {
        r.addEventListener('click', onTeachClick, true);
        teachDocs.add(r);
      }
    }
  }

  function teach() {
    attachTeachListeners();
    clearInterval(teachScan);
    teachScan = setInterval(attachTeachListeners, 1000); // frames that load while teaching
    clearTimeout(teachTimer);
    teachTimer = setTimeout(() => {
      endTeach();
      log('teach-timeout', 'No button clicked within 60s');
      report();
    }, TEACH_MS);
    report();
  }

  function endTeach() {
    for (const doc of teachDocs) doc.removeEventListener('click', onTeachClick, true);
    teachDocs.clear();
    clearInterval(teachScan);
    clearTimeout(teachTimer);
    teachScan = null;
    teachTimer = null;
  }

  function refuseTeach(text, why) {
    log('teach-refused', text || '(no label)', why);
    notify('Button not learned', "That button can't be learned. The popup shows why.");
    report();
  }

  function onTeachClick(e) {
    if (!e.isTrusted) return; // only the user's own clicks, never page scripts
    const path = e.composedPath();
    const el = path.find((n) => n.nodeType === 1 && (n.localName === 'button' || n.getAttribute('role') === 'button'));
    if (!el) return; // not a button; keep listening
    endTeach();
    const text = buttonText(el);
    const host = el.getRootNode().host?.localName;
    if (!host || !path.some((n) => n.localName === 'chat-view')) return refuseTeach(text, 'Only buttons inside the Build Agent chat can be learned');
    if (CHECKPOINTS.some((c) => c.host === host && el.matches(c.selector) && c.text === text)) {
      return refuseTeach(text, 'Autopilot already knows this button — trust it when autopilot pauses on it');
    }
    const rule = { host, selector: selectorFor(el), text, label: S.ruleLabel({ text, host }) };
    const error = S.checkRule(rule);
    if (error) return refuseTeach(text, error);

    clicked.add(el); // the user just approved this one
    const key = S.trustKey('button', rule.label);
    cfg.rules = [...cfg.rules.filter((r) => S.ruleKey(r) !== S.ruleKey(rule)), rule];
    cfg.allowedTools = [...new Set([...cfg.allowedTools, key])];
    log('learned', rule.label, rule.selector);
    notify('Button learned', 'Autopilot will approve it from now on. Remove it in the popup if that was a mistake.');
    send({ type: 'learned', rule });
    // If autopilot was paused on exactly this button, the user has now answered it.
    if (state === 'paused' && pending?.rule && S.ruleKey(pending.rule) === S.ruleKey(rule)) start({}, { total, budget });
    else report();
  }

  // `carry` keeps the counters: after a page reload, or when resuming from a teach click.
  function start(c, carry) {
    cfg = { ...cfg, ...c, maxApprovals: S.clampApprovals(c?.maxApprovals ?? cfg.maxApprovals) };
    if (state === 'stopped') {
      total = carry?.total ?? 0;
      for (const f of scan().failures) seenFailures.add(f); // only react to failures after Start
    }
    budget = carry?.budget ?? 0;
    if (state === 'paused') recentByKey.clear(); // the user has looked; restart the loop guard
    state = 'watching';
    reason = '';
    message = 'Watching for approvals';
    pending = null;
    pendingButton = null;
    inFlight = null;
    lastChange = Date.now();
    idleNotified = false;
    clearInterval(timer);
    timer = setInterval(tick, POLL_MS);
    report();
    tick();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    state = 'stopped';
    reason = '';
    message = 'Stopped';
    pending = null;
    pendingButton = null;
    inFlight = null;
    report();
  }

  // The user approved the paused checkpoint once from the popup: click it, then carry on.
  function approveOnce() {
    if (state !== 'paused' || !pendingButton?.isConnected) return false;
    approvedOnce.add(pendingButton);
    recentByKey.delete(pending?.key); // the user has looked at it
    start({}, { total, budget });
    return true;
  }

  function onMessage(msg, _sender, reply) {
    let ok = true;
    if (msg.cmd === 'start') start(msg.cfg, msg.carry);
    else if (msg.cmd === 'pause' && state === 'watching') pause('user', 'Paused by you');
    else if (msg.cmd === 'stop') stop();
    else if (msg.cmd === 'approveOnce') ok = approveOnce();
    else if (msg.cmd === 'config') cfg = { ...cfg, ...msg.cfg, maxApprovals: S.clampApprovals(msg.cfg?.maxApprovals ?? cfg.maxApprovals) };
    else if (msg.cmd === 'teach') {
      cfg = { ...cfg, ...msg.cfg };
      teach();
    }
    reply({ state, ok });
  }

  chrome.runtime.onMessage.addListener(onMessage);
})();
