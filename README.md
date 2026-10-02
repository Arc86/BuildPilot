<p align="center">
  <img src="docs/banner.jpg" width="100%" alt="Build Agent Autopilot: approve less, build more">
</p>

<h1 align="center">Build Agent Autopilot</h1>

<p align="center">Chrome extension (Manifest V3) that approves recognised ServiceNow Build Agent checkpoints so a POC build keeps running without you watching it.</p>

> [!WARNING]
> **For personal dev and demo instances only.** Autopilot approves Build Agent's plans, scripts and changes without showing them to you first. Read [Risks](#risks) before you enable it.

## Install

1. Open `chrome://extensions`, switch on **Developer mode**.
2. **Load unpacked** → select this folder.
3. Pin the extension.

Requires Chrome 116 or later.

## Use

1. Open Build Agent on your instance and start a build.
2. Click the extension → **Enable on this instance**. The first time on each instance, you confirm that you understand the risks; Chrome then asks to give autopilot access to that one instance. Re-enabling an instance you already confirmed skips the warning.
3. Click **Start autopilot**.
4. The first time each kind of checkpoint appears, autopilot pauses and notifies you. Click **Always approve** to trust it, or **Approve once** to approve just this one.

Autopilot pauses and notifies when it sees:

- a checkpoint you haven't trusted yet, including unfamiliar approval-like buttons
- a step that mentions deleting data or changing access, even if you trust that checkpoint (see [Risks](#risks))
- the same checkpoint approved 5 times within a minute, which usually means a loop
- a sub-agent that fails after you clicked Start
- an approval click the page doesn't react to within 60 seconds
- the approval limit (default 25 per Start/Resume, 500 at most)

It also notifies, without pausing, after 5 minutes with no activity (finished, or waiting for your answer). If the page reloads while autopilot is watching (for example when a build finishes), it reconnects automatically and keeps its approval count. If it was paused, a reload stops it. Closing Chrome ends every run.

To stop using autopilot on an instance, click **Disable** next to its name in the popup, or on the Learnings page. That also removes the extension's access to it.

### When autopilot misses an approval

- **It paused on a button it wasn't sure about.** Any chat button starting with Approve, Accept, Confirm, Proceed, Continue or Allow is treated as a possible checkpoint. Click **Always approve** to learn it, or **Not a checkpoint** to ignore it from now on.
- **It didn't notice the button at all.** Click **Teach a button**, then click that button in Build Agent yourself. Your click approves it this time; autopilot approves it from then on. Teach mode lasts 60 seconds, only accepts your own clicks and only buttons inside the chat. Remove a mistaken one with × under **Trusted**.

Buttons containing words like Reject, Delete, Remove, Cancel, Discard, Reset, Purge, Wipe or Stop (in any form, such as "Deleting") are never learned or clicked.

### Sharing learnings

Click **Import / export** in the popup (next to **Trusted**) to open the Learnings page.

- **Export** saves your trusted checkpoints, learned buttons and ignored buttons as a JSON file. Instance names and the activity log are not included.
- **Import** shows what a file adds before anything changes, then adds it to your learnings or replaces them. Anything doubtful is skipped with a reason: destructive button text, selectors that aren't a plain `tag.class` and malformed entries. Trust that approves every plan or every script run is highlighted and needs an extra confirmation.

Only import files from people you trust: autopilot approves what they contain without asking.

## Risks

Autopilot exists to approve things without you looking. That is also the risk.

- **Trusting a checkpoint trusts everything it will ever do.** Trusting "Run Script" approves every future script, whatever it contains. Trusting plans approves every plan.
- **The agent can be wrong or misled.** Content in the instance (requirements, records, attachments) can steer the agent into proposing changes you wouldn't approve.
- **The risky-step check is a safety net, not a guarantee.** Autopilot pauses when a card's visible text mentions deleting, truncating, purging or wiping data, or changing roles and ACLs. It can only see what the card shows on screen, and can't catch every phrasing.

So:

- Use it only on **personal developer or demo instances** with no customer, personal or otherwise sensitive data, that you could rebuild if something goes wrong.
- Never enable it on customer, production or shared instances.
- Keep the approval limit low and check the **Recent** list when you come back.

You are responsible for where and how you use this extension. It is provided as is, without warranty (see [License](#license)).

### Privacy

- The activity log stays in your browser, keeps at most 200 entries and drops anything older than 30 days. **Clear** in the popup empties it.
- **Copy log** copies only times, actions and checkpoint names: no instance names or card text.
- Notifications never show card text.
- **Report** opens a GitHub issue with only the button rule (component, selector, text), which you review before submitting.

## How it finds checkpoints

The background worker injects the content script into the top frame on Start, and again after each reload while the run is active. It only has access to the instances you enabled (Chrome asks per instance) and only acts inside Build Agent's chat. Every 1.5s it walks the chat's open shadow roots and looks for:

```text
document > iframe > iframe > chat-view#shadow > chat-message#shadow > tool-use#shadow > button.approve-btn
document > iframe > iframe > chat-view#shadow > chat-message#shadow > planning-display#shadow > button.plan-btn.approve
```

Trust is stored per kind of checkpoint (`tool:<title>`, `plan:Plan`, `button:<text> (<component>)`), so a tool card titled "Plan" can't borrow the trust you gave plans. Tool approvals are labelled with the first visible line of the `tool-use` card. Reject/Revise buttons are never touched.

Buttons you learn are stored as rules (`component`, `selector`, `text`). Buttons detected only by their wording always ask; only an exact learned rule is clicked automatically.

## Contributing checkpoints

Learned a button that others will hit too? Click **Report** next to it in the popup. That opens a pre-filled [New checkpoint](../../issues/new?template=new-checkpoint.yml) issue with only the rule: no plan text, requirements or instance names. You review it before submitting.

Rules reported by several people are added to `CHECKPOINTS` in `content.js` in the next release.

## Test

```sh
# Background worker, in Node against a fake Chrome API
node test/background.test.mjs

# Content script and import/export, in a browser
python3 -m http.server 8765 &
playwright-cli open
playwright-cli goto http://localhost:8765/test/fixture.html
playwright-cli run-code --filename test/run-fixture.js   # performs the real clicks teach mode needs
playwright-cli goto http://localhost:8765/test/learnings.html
playwright-cli eval "() => window.__done"
```

`test/fixture.html` rebuilds the observed DOM shape (`test/build-agent-dom.js`) and runs `content.js` against it with a stubbed `chrome` API.

## License

MIT
