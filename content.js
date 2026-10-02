// Build Agent Autopilot — content script.
// Injected into the top frame when the user clicks Start. Build Agent's chat lives in
// same-origin nested iframes behind open shadow roots, so we walk both from here.
(() => {
  // After an extension reload the copy already in the page is orphaned: it can no longer
  // talk to the extension. Replace it rather than deferring to it.
  const prev = window.__buildPilot;
  if (prev?.isAlive()) return;
  prev?.dispose();

  const POLL_MS = 1500;
  const CLICK_TIMEOUT_MS = 60_000;

  let state = 'stopped'; // watching | paused | stopped
  let cfg = { allowedTools: [], maxApprovals: 25, idleMinutes: 5 };
  let timer = null;
  let total = 0; // approvals since Start
  let budget = 0; // approvals since Start/Resume, capped by cfg.maxApprovals
  let inFlight = null; // { button, label, since } — waiting for the page to react
  let pending = null; // unrecognised checkpoint awaiting the user's decision
  let reason = '';
  let message = '';
  const clicked = new WeakSet();
  const seenFailures = new WeakSet();
  let lastSig = '';
  let lastChange = 0;
  let idleNotified = false;
  let orphaned = false;

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

  // Approval buttons observed on a real instance, keyed by the shadow host that renders them.
  // `label` names the checkpoint for the trust list; plans get a fixed label since their text varies.
  const CHECKPOINTS = [
    { host: 'tool-use', selector: 'button.approve-btn', text: 'Approve' },
    { host: 'planning-display', selector: 'button.plan-btn.approve', text: 'Approve plan', label: 'Plan' },
  ];

  const isLive = (b, text) =>
    b.isConnected &&
    !b.disabled &&
    b.getAttribute('aria-disabled') !== 'true' &&
    b.getClientRects().length > 0 &&
    b.textContent.trim() === text;

  const firstLine = (s) => (s || '').trim().split('\n')[0].trim();

  function scan() {
    const approvals = [];
    const failures = [];
    let messages = 0;
    let textLen = 0;
    for (const r of roots(document)) {
      const host = r.host?.localName;
      if (!host) continue;
      textLen += r.textContent.length;
      if (host === 'chat-message') messages++;
      for (const spec of CHECKPOINTS) {
        if (host !== spec.host) continue;
        for (const b of r.querySelectorAll(spec.selector)) if (isLive(b, spec.text)) approvals.push({ button: b, root: r, spec });
      }
      if (host === 'sub-agent-display') {
        const h = r.querySelector('.sub-agent-header');
        if (h && /\bFailed\b/.test(h.textContent)) failures.push(h);
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
        if (t && !/^(approve|reject|approve plan)$/i.test(t)) lines.push(t);
      }
    }
    if (spec.label) return { label: spec.label, detail: lines.join(' · ').slice(0, 300) };
    return {
      label: (lines[0] || 'Unnamed tool').slice(0, 80),
      detail: lines.slice(1).join(' · ').slice(0, 300),
    };
  }

  function report() {
    send({ type: 'status', status: { state, reason, message, total, budget, pending, host: location.host, at: Date.now() } });
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
      const { label, detail } = describe(next.root, next.spec);
      if (!cfg.allowedTools.includes(label)) return pause('unknown', `New checkpoint: ${label}`, { label, detail });
      if (budget >= cfg.maxApprovals) return pause('limit', `Reached ${cfg.maxApprovals} approvals — check progress`);
      clicked.add(next.button);
      next.button.click();
      total++;
      budget++;
      inFlight = { button: next.button, text: next.spec.text, label, since: Date.now() };
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
    reply({ state });
  }

  chrome.runtime.onMessage.addListener(onMessage);
})();
