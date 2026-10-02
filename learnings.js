// Export/import of what autopilot has learned: trusted checkpoints, learned button rules
// and ignored buttons. Instance names and the activity log are never exported.
// Imported trust makes autopilot click buttons, so parse() is strict and skips anything doubtful.
// Needs shared.js.
const Learnings = (() => {
  const S = globalThis.BuildPilotShared;
  const FORMAT = 'buildpilot-learnings';
  const VERSION = 2; // 2: trust entries are "<kind>:<label>" keys. 1 (v0.4): bare labels, migrated on import.
  const MAX_ITEMS = 500;

  const unique = (list) => [...new Set(list)];
  const uniqueRules = (rules) => [...new Map(rules.map((r) => [S.ruleKey(r), r])).values()];

  function toFile({ allowedTools, customRules, ignored }, extensionVersion) {
    return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), extensionVersion, allowedTools, customRules, ignored };
  }

  function checkLabel(v) {
    if (typeof v !== 'string' || !v.trim()) return 'not a text label';
    if (v.length > 120) return 'label longer than 120 characters';
    return null;
  }

  // Returns { allowedTools, customRules, ignored, skipped: [{ item, reason }] }.
  // Throws an Error with a user-facing message when the file as a whole is unusable.
  function parse(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("This file isn't valid JSON.");
    }
    if (data?.format !== FORMAT) throw new Error("This isn't a Build Agent Autopilot learnings file.");
    if (data.version !== 1 && data.version !== VERSION) {
      throw new Error(`This file uses format version ${data.version}, which this extension can't read. Update the extension and try again.`);
    }

    const out = { allowedTools: [], customRules: [], ignored: [], skipped: [] };
    const list = (v) => (Array.isArray(v) ? v.slice(0, MAX_ITEMS) : []);
    const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)).slice(0, 80);
    const skip = (item, reason) => out.skipped.push({ item: show(item), reason });

    for (const r of list(data.customRules)) {
      const error = S.checkRule(r);
      if (error) skip(r?.text ?? r, error);
      else out.customRules.push({ host: r.host, selector: r.selector, text: r.text.trim(), label: S.ruleLabel({ host: r.host, text: r.text.trim() }) });
    }
    out.customRules = uniqueRules(out.customRules);

    let keys = list(data.allowedTools).filter((l) => {
      const error = checkLabel(l);
      if (error) skip(l, error);
      return !error;
    });
    if (data.version === 1) keys = S.migrateTrust(keys, out.customRules);
    for (const key of keys) {
      const parsed = S.parseTrustKey(key.trim());
      if (!parsed || !parsed.label) skip(key, 'not a recognised checkpoint');
      else out.allowedTools.push(key.trim());
    }

    for (const label of list(data.ignored)) {
      const error = checkLabel(label);
      if (error) skip(label, error);
      else out.ignored.push(label.trim());
    }

    // A learned button only gets clicked when it is trusted, so the two travel together.
    out.allowedTools = unique([...out.allowedTools, ...out.customRules.map((r) => S.trustKey('button', r.label))]);
    out.ignored = unique(out.ignored);
    return out;
  }

  // Items in `incoming` that `current` doesn't have yet.
  function diff(current, incoming) {
    const rules = new Set(current.customRules.map(S.ruleKey));
    return {
      allowedTools: incoming.allowedTools.filter((k) => !current.allowedTools.includes(k)),
      customRules: incoming.customRules.filter((r) => !rules.has(S.ruleKey(r))),
      ignored: incoming.ignored.filter((l) => !current.ignored.includes(l)),
    };
  }

  // mode: 'add' keeps everything you have; 'replace' makes the file the whole list.
  function merge(current, incoming, mode) {
    if (mode === 'replace') {
      return { allowedTools: incoming.allowedTools, customRules: incoming.customRules, ignored: incoming.ignored };
    }
    return {
      allowedTools: unique([...current.allowedTools, ...incoming.allowedTools]),
      customRules: uniqueRules([...current.customRules, ...incoming.customRules]),
      ignored: unique([...current.ignored, ...incoming.ignored]),
    };
  }

  // Trust that approves broad, open-ended work: every plan, or every script/command run.
  const isHighImpact = (key) => {
    const p = S.parseTrustKey(key);
    return p?.kind === 'plan' || (p?.kind === 'tool' && /script|exec|command|shell|query|run/i.test(p.label));
  };

  return { toFile, parse, diff, merge, isHighImpact };
})();
