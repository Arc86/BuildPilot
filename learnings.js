// Export/import of what autopilot has learned: trusted checkpoint labels, learned button rules
// and ignored buttons. Instance names and the activity log are never exported.
// Imported rules make autopilot click buttons, so parse() is strict and skips anything doubtful.
const Learnings = (() => {
  const FORMAT = 'buildpilot-learnings';
  const VERSION = 1;
  const MAX_ITEMS = 500;
  // Keep in sync with UNSAFE_WORDS in content.js.
  const UNSAFE_WORDS = /\b(reject|delete|remove|cancel|discard|revert|deny|decline|stop|uninstall|drop)\b/i;
  const COMPONENT = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/; // custom element name, e.g. confirm-step
  const SELECTOR = /^[a-z][a-z0-9-]*(\.[A-Za-z_][\w-]*){0,4}$/; // tag plus up to 4 classes, as content.js writes them

  const ruleKey = (r) => `${r.host}|${r.selector}|${r.text}`;
  const unique = (list) => [...new Set(list)];
  const uniqueRules = (rules) => [...new Map(rules.map((r) => [ruleKey(r), r])).values()];

  function toFile({ allowedTools, customRules, ignored }, extensionVersion) {
    return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), extensionVersion, allowedTools, customRules, ignored };
  }

  function checkLabel(v) {
    if (typeof v !== 'string' || !v.trim()) return 'not a text label';
    if (v.length > 120) return 'label longer than 120 characters';
    return null;
  }

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
    if (data.version !== VERSION) throw new Error(`This file uses format version ${data.version}, which this extension can't read. Update the extension and try again.`);

    const out = { allowedTools: [], customRules: [], ignored: [], skipped: [] };
    const list = (v) => (Array.isArray(v) ? v.slice(0, MAX_ITEMS) : []);
    const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)).slice(0, 80);

    for (const label of list(data.allowedTools)) {
      const error = checkLabel(label);
      if (error) out.skipped.push({ item: show(label), reason: error });
      else out.allowedTools.push(label.trim());
    }
    for (const r of list(data.customRules)) {
      const error = checkRule(r);
      if (error) out.skipped.push({ item: show(r?.text ?? r), reason: error });
      else out.customRules.push({ host: r.host, selector: r.selector, text: r.text.trim(), label: `${r.text.trim()} (${r.host})` });
    }
    for (const label of list(data.ignored)) {
      const error = checkLabel(label);
      if (error) out.skipped.push({ item: show(label), reason: error });
      else out.ignored.push(label.trim());
    }

    // A learned button only gets clicked when its label is trusted, so the two travel together.
    out.customRules = uniqueRules(out.customRules);
    out.allowedTools = unique([...out.allowedTools, ...out.customRules.map((r) => r.label)]);
    out.ignored = unique(out.ignored);
    return out;
  }

  // Items in `incoming` that `current` doesn't have yet.
  function diff(current, incoming) {
    const rules = new Set(current.customRules.map(ruleKey));
    return {
      allowedTools: incoming.allowedTools.filter((l) => !current.allowedTools.includes(l)),
      customRules: incoming.customRules.filter((r) => !rules.has(ruleKey(r))),
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

  return { toFile, parse, diff, merge };
})();
