// Rebuilds the Build Agent DOM shape observed on a real instance:
//   document > iframe > iframe > chat-view#shadow > chat-message#shadow > tool-use#shadow > button.approve-btn
//                                                                      > planning-display#shadow > button.plan-btn.approve
// Exposes addTool / addPlan / addFailure and records clicks in window.__clicks.
(() => {
    const outer = document.createElement('iframe');
    document.body.append(outer);
    const inner = outer.contentDocument.createElement('iframe');
    outer.contentDocument.body.append(inner);
    const doc = inner.contentDocument;
    const view = doc.createElement('chat-view');
    doc.body.append(view);
    const viewRoot = view.attachShadow({ mode: 'open' });

    function message() {
      const m = doc.createElement('chat-message');
      viewRoot.append(m);
      return m.attachShadow({ mode: 'open' });
    }

    window.addTool = (name, detail, { disabled = false } = {}) => {
      const t = doc.createElement('tool-use');
      message().append(t);
      const r = t.attachShadow({ mode: 'open' });
      r.innerHTML = `<style>.x{}</style><div class="hdr">${name}</div><div>${detail}</div>
        <div class="actions"><button class="approval-button">Reject</button>
        <button class="approval-button approve-btn" ${disabled ? 'disabled' : ''}>Approve</button></div>`;
      const approve = r.querySelector('.approve-btn');
      approve.addEventListener('click', () => {
        window.__clicks.push(name);
        setTimeout(() => r.querySelector('.actions').remove(), 300);
        if (name === 'Write file') setTimeout(() => window.addTool('Run command', 'npm run build'), 600);
      });
    };

    window.addPlan = (title) => {
      const p = doc.createElement('planning-display');
      message().append(p);
      const r = p.attachShadow({ mode: 'open' });
      r.innerHTML = `<h3>${title}</h3><ol><li>Create table</li></ol>
        <div class="actions"><button class="plan-btn">Revise</button><button class="plan-btn approve">Approve plan</button></div>`;
      r.querySelector('.approve').addEventListener('click', () => {
        window.__clicks.push(`plan:${title}`);
        setTimeout(() => r.querySelector('.actions').remove(), 300);
      });
    };

    window.addFailure = (name) => {
      const s = doc.createElement('sub-agent-display');
      message().append(s);
      s.attachShadow({ mode: 'open' }).innerHTML = `<div class="sub-agent-header">${name}\nFailed · 3 tools · 1m 2s</div>`;
    };

  window.__clicks = [];
})();
