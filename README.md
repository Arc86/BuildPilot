# Build Agent Autopilot

Chrome extension (Manifest V3) that approves recognised ServiceNow Build Agent checkpoints so a POC build keeps running without you watching it.

## Install

1. Open `chrome://extensions`, switch on **Developer mode**.
2. **Load unpacked** → select this folder.
3. Pin the extension.

## Use

1. Open Build Agent on your instance and start a build.
2. Click the extension → **Enable on this instance** (once per instance).
3. Click **Start autopilot**.
4. The first time each kind of checkpoint appears, autopilot pauses and notifies you. Click **Always approve this checkpoint** to trust it and resume.

Autopilot pauses and notifies when it sees:

- a checkpoint you haven't trusted yet
- a sub-agent that fails after you clicked Start
- an Approve click the page doesn't react to within 60s
- the approval limit (default 25 per Start/Resume)

It also notifies, without pausing, after 5 minutes with no activity (finished, or waiting for your answer). If the page reloads while autopilot is watching (for example when a build finishes), it reconnects automatically and keeps its approval count. If it was paused, a reload stops it.

## How it finds checkpoints

The background worker injects the content script into the top frame on Start, and again after each reload while the run is active. It only injects on instances you enabled, but needs host permission for `https://*.service-now.com/*` to re-inject without a click. It walks the same-origin iframes and open shadow roots every 1.5s and looks for:

```
document > iframe > iframe > chat-view#shadow > chat-message#shadow > tool-use#shadow > button.approve-btn
document > iframe > iframe > chat-view#shadow > chat-message#shadow > planning-display#shadow > button.plan-btn.approve
```

Plans are always labelled `Plan`, so trusting one trusts all plans. Tool approvals are labelled with the first visible line of the `tool-use` card. Reject/Revise buttons are never touched. New checkpoint types go in `CHECKPOINTS` in `content.js`.

## Test

```sh
python3 -m http.server 8765 &
playwright-cli open && playwright-cli goto http://localhost:8765/test/fixture.html
playwright-cli eval "async () => { while (!window.__done) await new Promise(r => setTimeout(r, 500)); return window.__done }"
```

`test/fixture.html` rebuilds the observed DOM shape and runs `content.js` against it with a stubbed `chrome` API.
