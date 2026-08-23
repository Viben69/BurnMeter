# BurnMeter

A desktop money-meter for Claude Code. It reads the session transcripts Claude
Code already writes, prices every API response at public Anthropic API rates,
and tells you what you're getting out of a flat monthly subscription.

Two windows:

* **BurnMeter** — the full dashboard. Burn rate, money's-worth, subscription
  limits, charts, and a session-by-session, prompt-by-prompt account of exactly
  where the money went.
* **BurnMeter Gauge** — a small floating readout you can keep in a corner of the
  screen. Live burn rate, tokens per minute, today's spend, limit bars. Movable,
  resizable, minimisable, pinnable on top, and happy on a second monitor.

Zero dependencies. Node 18+. Nothing leaves your machine — no network calls, no
telemetry, and the server binds to `127.0.0.1` only.

---

## Install

**Windows, one line.** Paste into PowerShell — no admin rights needed:

```powershell
irm https://raw.githubusercontent.com/Viben69/BurnMeter/main/install.ps1 | iex
```

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/Viben69/BurnMeter/main/install.sh | sh
```

That checks for Node 18+, downloads the current release, installs it to
`~/.claude/burnmeter`, wires up the statusline, and — on Windows — puts two
shortcuts on your desktop and sets it to start at login.

**From a clone**, if you'd rather read it first:

```bash
git clone https://github.com/Viben69/BurnMeter.git
cd BurnMeter
node install.js
node install-desktop.js
```

<details>
<summary>Running a private fork</summary>

Everything below is only relevant if you fork this into a **private** repo.
The public install above needs no credentials at all.

A private repo needs a GitHub token that can read it. The updater looks in three
places, best first: `$BURNMETER_TOKEN`, a `.token` file next to the app, then
**git's own credential helper** — so if you use GitHub Desktop or the `gh` CLI,
there is usually nothing to set up and no plaintext credential on disk.

To install from a private fork:

```powershell
$env:BURNMETER_REPO='you/your-fork'; $env:BURNMETER_TOKEN='github_pat_...'
irm https://raw.githubusercontent.com/you/your-fork/main/install.ps1 | iex
```

Make the token at **Settings → Developer settings → Personal access tokens →
Fine-grained**, scoped to that one repo with **Contents: Read-only**. To set it
later: `node ~/.claude/burnmeter/update.js --set-token`.

</details>

`install.js` copies the app to `~/.claude/burnmeter/` and adds a `statusLine`
entry to `~/.claude/settings.json` (backing the file up first, and refusing to
overwrite a statusline you already have). Restart Claude Code once afterward.

`install-desktop.js` is Windows-only and makes it feel like an app:

| It creates | What it does |
|---|---|
| Desktop → **BurnMeter** | opens the dashboard in its own window |
| Desktop → **BurnMeter Gauge** | opens the floating gauge |
| Start Menu → BurnMeter | both of the above, plus **Stop BurnMeter** |
| Startup → BurnMeter | starts the server at login and pops the gauge |

Flags: `--no-startup` skips the login entry, `--uninstall` removes everything it
created. Want the server at login but no window? Point the Startup shortcut at
`desktop/server-only.vbs`.

Every shortcut runs a `.vbs` launcher through `wscript.exe`, so no console
window ever appears, and each launcher has your absolute `node.exe` path baked
in — it works even when Explorer hands shortcuts a thin `PATH`.

On macOS and Linux there's no desktop installer; run the server from launchd or
`systemd --user` and open `http://127.0.0.1:4317`.

---

## The windows

Both are ordinary OS windows served by Edge or Chrome in app mode, so they
already move, resize, minimise, snap and drag to another monitor the way
everything else does. The gauge adds what a browser can't do for itself, via a
small PowerShell helper (`desktop/window.ps1`) the page calls through the server:

| Control | What it does |
|---|---|
| 📌 | real always-on-top (`WS_EX_TOPMOST`) — stays above other apps |
| − / + | steps through five sizes, from 240×160 up to 580×330 |
| ⬒ | parks the window in a screen corner; click again to cycle the four |
| ◉ | picks the gauge face and the reading |
| ⤢ | opens the full dashboard |

Click the face itself to cycle the reading; `[` and `]` cycle the face. The
controls stay hidden until you hover. Double-click anywhere opens the dashboard.

### Faces

Eleven of them. Whatever you pick is remembered.

| Face | |
|---|---|
| **Dial** | clean modern arc and needle |
| **Gas pump** | 1950s forecourt enamel — DOLLARS and TOKENS windows, PRICE PER HOUR on the strip below |
| **Tachometer** | car rev counter with a redline; burn rate as engine speed |
| **Rings** | all three limits at once — weekly, 5-hour, context — as concentric arcs |
| **Split-flap** | airport departure board, one tile per character |
| **Nixie tubes** | glowing orange valve digits |
| **VU meter** | cream-faced analogue audio meter with a peak lamp |
| **Equalizer** | the last 40 minutes of burn as a spectrum analyser |
| **Thermometer** | mercury column, good for a limit you're watching |
| **Terminal** | green-on-black readout with everything on it at once |
| **Odometer** | mechanical drums counting lifetime API value |

### Readings

Ten, and every face that isn't tied to something specific will show any of them:
**burn rate · today · this session · this month · money's worth · all time ·
tokens per minute · 5-hour limit · weekly limit · context window**.

Rings always shows the three limits, Equalizer always shows recent history, and
Odometer always shows the lifetime total — that's the point of those three.

Each face is a single SVG on a fixed viewBox scaled to fit the window, so
dragging the window to any size or shape keeps it looking right; the buttons are
just shortcuts for sizes that suit the 2:1 artwork.

---

## What the numbers mean

**The dollar figures are not a bill.** On a subscription you pay the flat fee
and nothing else. Every dollar BurnMeter shows is *what this same usage would
have cost on the pay-as-you-go API* — the value you're extracting. That's the
only honest way to answer "am I getting my money's worth", because the plan
itself is a flat rate with no dollar meter attached.

| Reading | Where it comes from |
|---|---|
| Burn rate, token counts, all dollar figures | `~/.claude/projects/**/*.jsonl`, priced from `pricing.json` |
| 5-hour limit %, weekly limit %, reset times | the statusline hook — the only place Claude Code exposes these |
| Context window % | the statusline hook |

### The 5-hour and weekly meters

Those percentages are handed to the **statusline hook**, and that is the only
place Claude Code exposes them. The status line is part of the terminal UI — the
bar above the footer badges — so **in the desktop app the hook is never called**
and `limits.json` is never written. (`statusline-trace.log` in the app directory
records every invocation, so you can tell "never called" from "called and
failed".) It also only appears for Pro/Max subscribers, after the first API
response in a session.

BurnMeter handles the gap two ways:

1. **An estimate, automatically.** It compares your current 5-hour block against
   your own 90th-percentile 5-hour block, and this week against your own busiest
   week. That is *not* Anthropic's allowance and is always labelled as an
   estimate — but it answers the question you were probably asking anyway: am I
   going harder than usual right now?

2. **One calibration makes them real.** If you can see your true percentage
   anywhere, click **set real %** on either meter and type it in. At 26% with
   $54 of value in the window, your full window is worth about $208 — from then
   on BurnMeter reports real percentages and keeps doing so. Clear it by
   submitting a blank value.

A terminal session still trumps both: the moment `limits.json` appears, the real
numbers take over automatically.

**Pace** is the useful number on each limit meter. It compares how much of the
allowance you've spent against how far through the window you are. `1.15×
faster` means you'll hit the wall before the window resets. `62% of pace` means
you're leaving allowance unused — room to push harder.

**Active time**, not wall-clock. Sessions get resumed days later, so end-minus-
start is meaningless — one real session here spans 1,066 hours. Active time sums
the gaps between consecutive responses and caps any gap over five minutes, which
is what makes the `$/hr` column mean something. The table shows both.

---

## Sessions

The **Sessions** tab is the "where did it actually go" view. Every session, with
its real title (Claude Code's own `ai-title`/`custom-title` records), project,
active time, prompt count, cost per prompt, how much was delegated to subagents,
and total API value. Sort by cost, recency, `$/hour`, length, requests or
prompts; filter by time window; search titles, projects and models.

Click any row and you get the session drilled open:

* running total of cost across the life of the session
* per-model split
* **every prompt you sent, with what that one prompt cost** — including the
  subagents it spawned, how long it ran, how many responses it took, and which
  models answered

That last part is the thing worth looking at. It is very common to find one
throwaway-looking request that cost $80 because it fanned out into a dozen
subagents.

---

## How it stays accurate

**Subagents count.** Delegated work is written to a separate tree that's easy to
miss:

```
projects/<project>/<session>.jsonl                            main thread
projects/<project>/<session>/subagents/agent-*.jsonl          Task subagents
projects/<project>/<session>/subagents/workflows/wf_*/*.jsonl workflow agents
```

Reading only the top level undercounts by roughly a third. BurnMeter walks the
whole tree and classifies by path structure rather than a fixed depth. Subagent
responses carry the parent `sessionId` and `promptId`, so their cost rolls up
into the exact prompt that spawned them, and is also broken out separately.

**Responses are counted once.** Claude Code writes the same API response to the
transcript several times as it streams; BurnMeter dedupes on
`message.id` + `requestId`.

**Cache writes are split by TTL.** The 1-hour tier costs 2× base input, the
5-minute tier 1.25×. Lumping them together overstates cost by ~60% on
cache-heavy sessions.

**Fast mode is priced separately.** Responses reporting `speed: "fast"` are
billed at the premium rate from the `_fastMode` block in `pricing.json`.

**Files are tail-read** from a saved byte offset, so following a long-running
session costs almost nothing.

---

## Configuration

`config.json`, or the plan editor in the dashboard header:

```json
{
  "planName": "Max 20x",
  "monthlyUsd": 200,
  "port": 4317,
  "host": "127.0.0.1",
  "lookbackDays": 0,
  "needleWindowSec": 300,
  "pollMs": 1200
}
```

`lookbackDays: 0` reads everything ever recorded. Set a number to limit how far
back it looks — that trades history for a faster boot and less memory. (Note:
this defaulted to `45` in an earlier version, which silently hid older
transcripts. `install.js` migrates a `45` it finds to `0`.)

Anyone on any plan just puts their own monthly figure in — Pro at $20, Max 5x at
$100, a team seat, anything. The conversion is the same.

`pricing.json` holds the per-million-token rates per model. It's re-read
whenever the file changes, and a change re-prices your whole history — so if you
add a model that was showing as $0, past responses for it are corrected too, not
just new ones. Matching is
exact id first, then longest substring, then family — so an unreleased
`claude-opus-9` still prices as Opus. A model matching nothing is counted as $0
and named in a warning on the page; **check that warning**, because an unpriced
model silently reports as free.

CLI overrides: `node server.js --port=4318 --monthlyUsd=100`

Switches: `--open` opens the dashboard window on start, `--open-mini` the gauge.
If the port is already in use it just opens the window against the running
instance and exits.

---

## API

The server is a plain JSON API on `127.0.0.1:4317` if you want to build on it:

| Endpoint | Returns |
|---|---|
| `GET /api/state` | everything the dashboard renders |
| `GET /api/mini` | small payload for the gauge |
| `GET /api/stream` | server-sent events, add `?mini=1` for the small one |
| `GET /api/sessions` | session list; `span`, `sort`, `q`, `limit` |
| `GET /api/session?id=` | one session including every prompt |
| `GET /api/series?days=N` | daily series, hour histogram, model/project splits |
| `POST /api/config` | plan name, monthly price, gauge preferences |
| `POST /api/window` | `top`, `untop`, `size`, `corner`, `state` (Windows) |
| `POST /api/open` | spawn a dashboard or gauge window |

---

## Updates

BurnMeter checks the repo for a newer version 20 seconds after it starts and
every six hours after that. When there is one, a banner appears at the top of
the dashboard with the release notes and an **Update & restart** button.

It only ever *checks* on its own. Installing is always a click, or:

```bash
node ~/.claude/burnmeter/update.js             # check, then install if newer
node ~/.claude/burnmeter/update.js --check     # look, change nothing
node ~/.claude/burnmeter/update.js --rollback  # undo the last update
node ~/.claude/burnmeter/update.js --set-token # only if git isn't already signed in
```

The updater looks for credentials in three places, best first: `$BURNMETER_TOKEN`,
a `.token` file next to the app, then git's credential helper.

Being offline, or having no token, just means no news — it fails quietly and
carries on.

**What an update will not do.** It fetches only over HTTPS, only from the one
repo pinned in `package.json`, and only from GitHub hosts. Every file is checked
against a SHA-256 from `version.json` and every `.js` file has to parse before
anything is installed. It never touches `config.json`, `limits.json`, your
calibration, or your gauge preferences. Whatever it replaces is backed up first,
and the last three backups are kept.

### Shipping a new version

```bash
# edit things, then:
node make-manifest.js --bump patch --notes "what changed"
git add -A && git commit -m "release v1.0.1" && git push
```

`make-manifest.js` rewrites `version.json` with the new version number and a
fresh SHA-256 for every shipped file. Everyone's copy notices within six hours.

`.gitattributes` sets `* -text` so git never rewrites line endings. That matters:
if a Windows clone checked files out as CRLF, the hashes it generated would not
match the bytes GitHub serves, and every update would fail its integrity check.

---

## Uninstall

```bash
node ~/.claude/burnmeter/install-desktop.js --uninstall   # shortcuts + startup
node ~/.claude/burnmeter/install.js --uninstall           # statusline entry
rm -rf ~/.claude/burnmeter
```

Your `settings.json` backup is at `~/.claude/settings.json.burnmeter-backup`.
To stop a running server without removing anything, use the **Stop BurnMeter**
Start Menu shortcut, or `powershell -File ~/.claude/burnmeter/desktop/stop.ps1`.
