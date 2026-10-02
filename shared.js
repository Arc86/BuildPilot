// Safety rules and helpers shared by the content script, background worker, popup and Learnings page.
// Assigned rather than declared, so injecting this file twice into the same page is harmless.
globalThis.BuildPilotShared = (() => {
  // Button text that is never learned, imported or clicked. Matches word stems ("deleting", "removal").
  const UNSAFE_WORDS = /\b(reject|delet|remov|cancel|discard|revert|den(y|ie)|declin|stop|uninstall|drop|purg|wip(e|ing)|truncat|destroy|reset|overwrit|eras(e|ing)|clear)\w*/i;

  // Card text that pauses autopilot even on a trusted checkpoint: the step may delete data or change access.
  const RISKY_CONTENT =
    /\b(delet\w*|truncat\w*|purg\w*|wip(e|es|ed|ing)|destroy\w*|eras(e|es|ed|ing)|drop\s+(table|column|index)\w*|setWorkflow\s*\(\s*false|gs\.eval|sys_user_has_role|sys_user_role|sys_security_acl|security_admin|impersonat\w*)\b/i;

  const COMPONENT = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/; // custom element name, e.g. confirm-step
  const SELECTOR = /^[a-z][a-z0-9-]*(\.[A-Za-z_][\w-]*){0,4}$/; // tag plus up to 4 classes
  const BUTTON_LABEL = /^.+ \([a-z][a-z0-9]*(-[a-z0-9]+)+\)$/; // "<text> (<component>)"

  const MAX_APPROVALS = { min: 1, max: 500, fallback: 25 };
  function clampApprovals(value) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(MAX_APPROVALS.max, Math.max(MAX_APPROVALS.min, n)) : MAX_APPROVALS.fallback;
  }

  const ruleKey = (r) => `${r.host}|${r.selector}|${r.text}`;
  const ruleLabel = (r) => `${r.text} (${r.host})`;

  // Trust keys name the kind of checkpoint, so a tool card titled "Plan" can't borrow plan trust.
  const KINDS = { tool: 'Tool approval', plan: 'Plan', button: 'Learned button' };
  const trustKey = (kind, label) => `${kind}:${label}`;
  function parseTrustKey(key) {
    const i = typeof key === 'string' ? key.indexOf(':') : -1;
    const kind = i > 0 ? key.slice(0, i) : '';
    return kind in KINDS ? { kind, label: key.slice(i + 1) } : null;
  }

  // v0.4 and earlier stored bare labels: "Plan", "<text> (<component>)" for buttons, anything else a tool title.
  function migrateTrust(labels, rules = []) {
    const ruleLabels = new Set(rules.map(ruleLabel));
    return labels.map((l) => {
      if (parseTrustKey(l)) return l;
      if (l === 'Plan') return trustKey('plan', l);
      if (ruleLabels.has(l) || BUTTON_LABEL.test(l)) return trustKey('button', l);
      return trustKey('tool', l);
    });
  }

  // Returns an error message, or null when the rule is safe to store.
  function checkRule(r) {
    if (!r || typeof r !== 'object') return 'not a button rule';
    const { host, selector, text } = r;
    if (![host, selector, text].every((v) => typeof v === 'string')) return 'missing component, selector or text';
    if (!COMPONENT.test(host)) return `"${host}" is not a component name`;
    if (!SELECTOR.test(selector)) return `"${selector}" is not a simple button selector`;
    if (!text.trim() || text.length > 40) return 'button text is empty or longer than 40 characters';
    if (UNSAFE_WORDS.test(text)) return `"${text}" looks destructive`;
    return null;
  }

  return { UNSAFE_WORDS, RISKY_CONTENT, KINDS, clampApprovals, ruleKey, ruleLabel, trustKey, parseTrustKey, migrateTrust, checkRule };
})();
