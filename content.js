// Build Agent Autopilot — content script.
// Injected into the top frame by the background worker. Build Agent's chat lives in
// same-origin nested iframes behind open shadow roots, so we walk both from here.
(() => {
  // After an extension reload the copy already in the page is orphaned: it can no longer
  // talk to the extension. Replace it rather than deferring to it.
  const prev = window.__buildPilot;
  if (prev?.isAlive()) return;
  prev?.dispose();

  const POLL_MS = 1500;
  const CLICK_TIMEOUT_MS = 60_000;
  const TEACH_MS = 60_000;

  // Approval buttons observed on a real instance, keyed by the shadow host that renders them.
  // `label` names the checkpoint for the trust list; plans get a fixed label since their text varies.
  const CHECKPOINTS = [
    { host: 'tool-use', selector: 'button.approve-btn', text: 'Approve' },
    { host: 'planning-display', selector: 'button.plan-btn.approve', text: 'Approve plan', label: 'Plan' },
  ];
  // Any other chat button starting with one of these words is surfaced as a possible checkpoint.
  const APPROVAL_WORDS = /^(approve|accept|confirm|proceed|continue|allow)\b/i;
  // Buttons with these words are never learned or clicked.
  const UNSAFE_WORDS = /\b(reject|delete|remove|cancel|discard|revert|deny|decline|stop|uninstall|drop)\b/i;

  let state = 'stopped'; // watching | paused | stopped
  // rules: buttons learned by the user ({ host, selector, text, label }); ignored: candidate labels to skip
  let cfg = { allowedTools: [], rules: [], ignored: [], maxApprovals: 25, idleMinutes: 5 };
  let timer = null;
  let total = 0; // approvals since Start
  let budget = 0; // approvals since Start/Resume, capped by cfg.maxApprovals
  let inFlight = null; // { button, text, label, since } — waiting for the page to react
  let pending = null; // unrecognised checkpoint awaiting the user's decision
  let reason = '';
  let message = '';
  const clicked = new WeakSet();
  const seenFailures = new WeakSet();
  let lastSig = '';
  let lastChange = 0;
  let idleNotified = false;
  let orphaned = false;
  let teachTimer = null;
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

  // Yields every document and open shadow root, flagging those inside the Build Agent chat.
  function* roots(root, inChat = false) {
    yield { root, inChat };
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) yield* roots(el.shadowRoot, inChat || el.localName === 'chat-view' || !!el.closest('chat-view'));
      if (el.localName === 'iframe') {
        let doc = null;
        try { doc = el.contentDocument; } catch {}
        if (doc) yield* roots(doc);
      }
    }
  }

  const buttonText = (b) => b.textContent.trim().replace(/\s+/g, ' ');
  const ruleKey = (r) => `${r.host}|${r.selector}|${r.text}`;
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
    for (const { root: r, inChat } of roots(document)) {
      const host = r.host?.localName;
      if (!host) continue;
      textLen += r.textContent.length;
      if (host === 'chat-message') messages++;
      if (host === 'sub-agent-display') {
        const h = r.querySelector('.sub-agent-header');
        if (h && /\bFailed\b/.test(h.textContent)) failures.push(h);
      }

      // Built-in checkpoints, then the user's learned buttons (chat only).
      const known = new Set();
      for (const spec of [...CHECKPOINTS, ...cfg.rules]) {
        if (spec.host !== host || (!inChat && !CHECKPOINTS.includes(spec))) continue;
        let found = [];
        try { found = r.querySelectorAll(spec.selector); } catch { continue; }
        for (const b of found) {
          if (buttonText(b) !== spec.text || UNSAFE_WORDS.test(spec.text)) continue;
          known.add(b);
          if (isLive(b, spec.text)) approvals.push({ button: b, root: r, spec });
        }
      }

      // Anything else in the chat that reads like an approval becomes a candidate.
      if (!inChat) continue;
      for (const b of r.querySelectorAll('button, [role="button"]')) {
        if (known.has(b)) continue;
        const text = buttonText(b);
        if (text.length > 40 || !APPROVAL_WORDS.test(text) || UNSAFE_WORDS.test(text) || !isLive(b, text)) continue;
        const label = `${text} (${host})`;
        if (cfg.ignored.includes(label)) continue;
        approvals.push({ button: b, root: r, spec: { host, selector: selectorFor(b), text, label, candidate: true } });
      }
    }
    return { approvals, failures, sig: `${messages}:${textLen}` };
  }

  // Unless the checkpoint has a fixed label, the first visible line of its card is the label.
  function describe(root, spec) {
    const lines = [];
    for (const el of root.children) {
      if (el.localName === 'style' || el.localName === 'script') continue;
      for (const raw of (el.innerText || '').split('\n')) {
        const t = raw.trim();
        if (t && t !== spec.text && !/^(approve|reject|approve plan)$/i.test(t)) lines.push(t);
      }
    }
    if (spec.label) return { label: spec.label, detail: lines.join(' · ').slice(0, 300) };
    return {
      label: (lines[0] || 'Unnamed tool').slice(0, 80),
      detail: lines.slice(1).join(' · ').slice(0, 300),
    };
  }

  function report() {
    const teaching = teachTimer !== null;
    send({ type: 'status', status: { state, reason, message, total, budget, pending, teaching, host: location.host, at: Date.now() } });
  }

  function log(action, label, detail = '') {
    send({ type: 'log', entry: { at: Date.now(), host: location.host, action, label, detail } });
  }

  function notify(title, body) {
    send({ type: 'notify', title, message: body });
  }

  function pause(why, text, checkpoint = null) {
    state = 'paused';
    reason = why;
    message = text;
    pending = checkpoint;
    log('paused', text, checkpoint?.detail);
    if (why !== 'user') notify('Autopilot paused', text);
    report();
  }

  function tick() {
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
      const { label, detail } = describe(next.root, spec);
      if (!cfg.allowedTools.includes(label)) {
        const rule = spec.candidate ? { host: spec.host, selector: spec.selector, text: spec.text, label } : null;
        return pause('unknown', `New checkpoint: ${label}`, { label, detail, rule });
      }
      if (budget >= cfg.maxApprovals) return pause('limit', `Reached ${cfg.maxApprovals} approvals — check progress`);
      clicked.add(next.button);
      next.button.click();
      total++;
      budget++;
      inFlight = { button: next.button, text: spec.text, label, since: Date.now() };
      message = `Approved ${label}`;
      log('approved', label, detail);
      report();
      return;
    }

    if (!s.approvals.length && !idleNotified && Date.now() - lastChange > cfg.idleMinutes * 60_000) {
      idleNotified = true;
      message = `Quiet for ${cfg.idleMinutes} min — finished or waiting for you`;
      notify('Build Agent is quiet', message);
      report();
    }
  }

  // Teach mode: the next button the user clicks inside the chat becomes a learned rule.
  // The user's own click approves it this time; autopilot approves it from then on.
  function teach() {
    for (const { root } of roots(document)) {
      if (root.nodeType === Node.DOCUMENT_NODE && !teachDocs.has(root)) {
        root.addEventListener('click', onTeachClick, true);
        teachDocs.add(root);
      }
    }
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
    clearTimeout(teachTimer);
    teachTimer = null;
  }

  function refuseTeach(text, why) {
    log('teach-refused', text || '(no label)', why);
    notify('Button not learned', why);
    report();
  }

  function onTeachClick(e) {
    const path = e.composedPath();
    const el = path.find((n) => n.nodeType === 1 && (n.localName === 'button' || n.getAttribute('role') === 'button'));
    if (!el) return; // not a button; keep listening
    endTeach();
    const text = buttonText(el);
    const host = el.getRootNode().host?.localName;
    if (!host || !path.some((n) => n.localName === 'chat-view')) return refuseTeach(text, 'Only buttons inside the Build Agent chat can be learned');
    if (!text || text.length > 40) return refuseTeach(text, 'That button has no short label to recognise it by');
    if (UNSAFE_WORDS.test(text)) return refuseTeach(text, `"${text}" looks destructive, so autopilot won't click it`);
    if (CHECKPOINTS.some((c) => c.host === host && el.matches(c.selector) && c.text === text)) {
      return refuseTeach(text, 'Autopilot already knows this button — trust it when autopilot pauses on it');
    }

    const rule = { host, selector: selectorFor(el), text, label: `${text} (${host})` };
    clicked.add(el); // the user just approved this one
    cfg.rules = [...cfg.rules.filter((r) => ruleKey(r) !== ruleKey(rule)), rule];
    cfg.allowedTools = [...new Set([...cfg.allowedTools, rule.label])];
    log('learned', rule.label, rule.selector);
    notify('Button learned', `Autopilot will approve "${text}" from now on`);
    send({ type: 'learned', rule });
    // If autopilot was paused on exactly this button, the user has now answered it.
    if (state === 'paused' && pending?.rule && ruleKey(pending.rule) === ruleKey(rule)) start({});
    else report();
  }

  // `carry` restores the counters when the background reconnects after a page reload.
  function start(c, carry) {
    cfg = { ...cfg, ...c };
    if (state === 'stopped') {
      total = carry?.total ?? 0;
      for (const f of scan().failures) seenFailures.add(f); // only react to failures after Start
    }
    budget = carry?.budget ?? 0;
    state = 'watching';
    reason = '';
    message = 'Watching for approvals';
    pending = null;
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
    inFlight = null;
    report();
  }

  function onMessage(msg, _sender, reply) {
    if (msg.cmd === 'start') start(msg.cfg, msg.carry);
    else if (msg.cmd === 'pause' && state === 'watching') pause('user', 'Paused by you');
    else if (msg.cmd === 'stop') stop();
    else if (msg.cmd === 'config') cfg = { ...cfg, ...msg.cfg };
    else if (msg.cmd === 'teach') {
      cfg = { ...cfg, ...msg.cfg };
      teach();
    }
    reply({ state });
  }

  chrome.runtime.onMessage.addListener(onMessage);
})();
