#!/usr/bin/env node
/*
 * BurnMeter — a live money-speedometer for Claude Code.
 *
 * Reads Claude Code's own session transcripts, prices every API response at
 * public Anthropic API rates, and serves a live dashboard showing what your
 * usage would have cost, versus what your flat subscription actually costs.
 *
 * Transcripts live at:
 *   ~/.claude/projects/<project>/<session>.jsonl              main thread
 *   ~/.claude/projects/<project>/<session>/subagents/*.jsonl  subagent work
 *
 * Both are read. Subagent responses carry the parent sessionId and promptId,
 * so their cost rolls up into the exact prompt that spawned them.
 *
 * Zero dependencies. Node 18+.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');
const { execFile, spawn } = require('child_process');
const updater = require('./update.js');

// ---------------------------------------------------------------- paths ----

const HOME       = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const PROJECTS   = path.join(CLAUDE_DIR, 'projects');
const APP_DIR    = __dirname;
const CONFIG_F   = path.join(APP_DIR, 'config.json');
const PRICING_F  = path.join(APP_DIR, 'pricing.json');
const PUBLIC_D   = path.join(APP_DIR, 'public');
const DESKTOP_D  = path.join(APP_DIR, 'desktop');
// Drop any image or GIF in here and the party uses it instead of the drawn
// figure. Yours, not shipped, and never committed - see .gitignore.
const PARTY_D    = path.join(APP_DIR, 'party-media');
// statusline.js drops the real subscription rate-limit numbers here.
const LIMITS_F   = path.join(APP_DIR, 'limits.json');

/** Stamped on every frame so open pages notice a restart and reload. */
const BOOT_AT = Date.now();

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

// --------------------------------------------------------------- config ----

const DEFAULT_CONFIG = {
  planName:    'Max 20x',
  monthlyUsd:  200,
  port:        4317,
  host:        '127.0.0.1',
  // How far back to read on startup. 0 = everything ever recorded.
  lookbackDays: 0,
  // Seconds of history the speedometer needle averages over.
  needleWindowSec: 300,
  // Poll interval for detecting new transcript writes.
  pollMs: 1200,
  // Mini-gauge preferences, persisted so the overlay reopens how you left it.
  miniScale: 1,
  miniMetric: 'rate',
  miniSkin: 'dial',
  // A gauge you have to go looking for is not a gauge. It floats above other
  // windows by default; the pin button turns that off.
  miniOnTop: true,
  // Cleared until the flip below has happened once. It must default to false:
  // a default of true would pre-satisfy its own check, via the spread in
  // loadConfig, and the migration would never run.
  miniOnTopDefaulted: false,
  // Where the gauge was last seen: {x, y, w, h} of the OS window, reported by
  // the page. Restored on the next open, so it reappears where you left it
  // instead of wherever the browser feels like putting it.
  miniRect: null,
  // Shout when a usage limit lifts. The whole point of tracking lockouts is
  // to not be sitting on your hands ten minutes after capacity came back.
  alertOnReset: true,
  alertSound: true,
  // Confetti, a fanfare and a dancing figure when a limit lifts. Purely for
  // the pleasure of it - and it is genuinely hard to miss, which is the point.
  partyOnReset: true,
  partySeconds: 15,
  // 'single' shows one reading and cycles; 'cluster' shows several at once,
  // like an instrument cluster. miniCluster is the ordered list of readings.
  miniLayout: 'single',
  miniCluster: ['rate', 'today', 'fivehour', 'week'],
  // Which lens every dollar figure is shown through:
  //   retail - what this usage would cost on pay-as-you-go API rates
  //   actual - your real share of the flat fee, allocated by usage
  //   deal   - both side by side, with the discount between them
  pricingMode: 'retail',
  // Nudge when nothing is running and the week still has room. Off by default:
  // this one is a nag, and a nag should be asked for.
  idleAlert: false,
  idleAfterMin: 20,
  idleRepeatMin: 60,
  quietFromHour: 23,
  quietToHour: 8,
  // Token-max targets. 0 on either goal means "measure me against my own
  // record instead of a number I made up".
  weekTokenGoal: 0,
  blockCoverageGoal: 0,
  // How much earlier than the promised time counts as an early reset.
  earlyResetToleranceSec: 60,
  // How long after the promised time you can still return and have it count
  // as an on-time reset. Come back later than this and an early reset is
  // indistinguishable from a normal one, so it is scored unknown instead.
  resetGraceMinutes: 30,
  // Day of the month the subscription renews on (1-28). Turns "this month"
  // into "this billing period", which is the thing the fee actually buys.
  renewalDay: 1,
  // Set by POST /api/calibrate. { fiveHourAllowance, weekAllowance, ...At }
  calibration: null
};

const NUMERIC_KEYS = new Set(['monthlyUsd', 'port', 'lookbackDays', 'needleWindowSec', 'pollMs',
                              'miniScale', 'renewalDay', 'partySeconds',
                              'weekTokenGoal', 'blockCoverageGoal', 'earlyResetToleranceSec',
                              'resetGraceMinutes', 'idleAfterMin', 'idleRepeatMin',
                              'quietFromHour', 'quietToHour']);

function loadConfig() {
  let c = { ...DEFAULT_CONFIG };
  try { Object.assign(c, JSON.parse(fs.readFileSync(CONFIG_F, 'utf8'))); }
  catch { saveConfig(c); }
  // One-time migration for configs written while the gauge opened behind other
  // windows. Done here rather than in the installer because the one-line
  // install ships no config.json, so the installer's migration never sees one.
  if (!c.miniOnTopDefaulted) {
    c.miniOnTopDefaulted = true;
    if (c.miniOnTop === false) c.miniOnTop = true;
    saveConfig(c);
  }
  for (const a of process.argv.slice(2)) {
    const m = /^--([a-zA-Z]+)=(.*)$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k in c) c[k] = NUMERIC_KEYS.has(k) && v !== '' && !isNaN(Number(v)) ? Number(v) : v;
  }
  return c;
}

function saveConfig(c) {
  const out = {};
  for (const k of Object.keys(DEFAULT_CONFIG)) out[k] = c[k];
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_F, JSON.stringify(out, null, 2));
  } catch (e) { console.error('[burnmeter] could not save config:', e.message); }
}

let CONFIG = loadConfig();

// -------------------------------------------------------------- pricing ----

let PRICING = { models: {}, families: {}, _fastMode: {} };
let pricingMtime = 0;

const BUILTIN_PRICING = {
  models: {},
  families: {
    fable:  { in: 10, out: 50, w5m: 12.5, w1h: 20, read: 1 },
    opus:   { in: 5,  out: 25, w5m: 6.25, w1h: 10, read: 0.5 },
    sonnet: { in: 3,  out: 15, w5m: 3.75, w1h: 6,  read: 0.3 },
    haiku:  { in: 1,  out: 5,  w5m: 1.25, w1h: 2,  read: 0.1 }
  },
  _fastMode: {}
};

/** Returns true when rates changed after the initial load, meaning history
 *  needs re-pricing. A corrected rate should fix the past, not just the future. */
function loadPricing() {
  try {
    const st = fs.statSync(PRICING_F);
    if (st.mtimeMs === pricingMtime) return false;
    const next = JSON.parse(fs.readFileSync(PRICING_F, 'utf8'));
    PRICING = { models: next.models || {}, families: next.families || {}, _fastMode: next._fastMode || {} };
    const wasLoaded = pricingMtime !== 0;
    pricingMtime = st.mtimeMs;
    priceCache.clear();
    UNKNOWN_MODELS.clear();
    return wasLoaded;
  } catch (e) {
    if (!pricingMtime) {
      console.error('[burnmeter] pricing.json unreadable, using built-in fallback:', e.message);
      PRICING = BUILTIN_PRICING;
    }
    return false;
  }
}

const priceCache = new Map();
const UNKNOWN_MODELS = new Set();

function priceFor(modelId, fast) {
  if (!modelId) return null;
  const ck = (fast ? 'fast:' : '') + modelId;
  if (priceCache.has(ck)) return priceCache.get(ck);

  const id = String(modelId).toLowerCase().replace(/[._]/g, '-');
  let hit = null;

  // Fast mode is premium-priced on the models that offer it.
  if (fast) {
    if (PRICING._fastMode[id]) hit = PRICING._fastMode[id];
    if (!hit) {
      let best = '';
      for (const key of Object.keys(PRICING._fastMode)) {
        if (key[0] === '_') continue;
        if (id.includes(key) && key.length > best.length) { best = key; hit = PRICING._fastMode[key]; }
      }
    }
  }

  // Exact, then longest matching key (so claude-sonnet-4-5 beats claude-sonnet).
  if (!hit && PRICING.models[id]) hit = PRICING.models[id];
  if (!hit) {
    let best = '';
    for (const key of Object.keys(PRICING.models)) {
      if (id.includes(key) && key.length > best.length) { best = key; hit = PRICING.models[key]; }
    }
  }
  // Family fallback: any future claude-opus-N still prices as opus.
  if (!hit) {
    for (const fam of Object.keys(PRICING.families)) {
      if (id.includes(fam)) { hit = PRICING.families[fam]; break; }
    }
  }
  if (!hit && !UNKNOWN_MODELS.has(id) && id !== '<synthetic>') {
    UNKNOWN_MODELS.add(id);
    console.error(`[burnmeter] no price for model "${id}" — add it to pricing.json. Counting as $0.`);
  }
  priceCache.set(ck, hit);
  return hit;
}

/** Price one usage block. Returns { cost, tokens... }. */
function priceUsage(modelId, u) {
  const fast = u.speed === 'fast';
  const p = priceFor(modelId, fast);
  const inTok   = u.input_tokens              || 0;
  const outTok  = u.output_tokens             || 0;
  const readTok = u.cache_read_input_tokens   || 0;
  const cc      = u.cache_creation || {};
  let w5m = cc.ephemeral_5m_input_tokens || 0;
  let w1h = cc.ephemeral_1h_input_tokens || 0;
  const ccTotal = u.cache_creation_input_tokens || 0;
  // Older transcripts only have the flat total — assume the 5m tier.
  if (!w5m && !w1h && ccTotal) w5m = ccTotal;

  const M = 1e6;
  const cost = p
    ? (inTok * p.in + outTok * p.out + readTok * p.read + w5m * p.w5m + w1h * p.w1h) / M
    : 0;

  return {
    cost,
    in: inTok, out: outTok, read: readTok, w5m, w1h, fast,
    think: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
    billable: inTok + outTok + w5m + w1h,   // cache reads are near-free; excluded from "weight"
    total: inTok + outTok + readTok + w5m + w1h,
    priced: !!p
  };
}

// ---------------------------------------------------------------- state ----

/** Every priced API response we've seen, oldest first. */
const events = [];
/** Dedupe: transcripts repeat the same response across streaming chunks. */
const seen = new Set();
/** Per-file read cursors: byte offset + the prompt the tail was mid-way through. */
const cursors = new Map();
/** sessionId -> rich session record. */
const sessions = new Map();
/** Every time Claude Code refused because a usage limit was hit. */
const limitHits = [];
const limitSeen = new Set();

let scanning = true;
let lastScanMs = 0;
let filesTracked = 0;
let bootMs = 0;

// ------------------------------------------------------------- sessions ----

function blankTokens() { return { in: 0, out: 0, read: 0, write: 0, think: 0 }; }

function getSession(id, meta) {
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      aiTitle: null, customTitle: null, firstPrompt: null,
      project: null, cwd: null, branch: null, entrypoint: null, version: null,
      start: 0, end: 0,
      cost: 0, requests: 0,
      subCost: 0, subRequests: 0,
      tok: blankTokens(),
      models: Object.create(null),
      prompts: new Map(),
      promptOrder: []
    };
    sessions.set(id, s);
  }
  if (meta) {
    if (meta.cwd && !s.cwd) s.cwd = meta.cwd;
    if (meta.project && !s.project) s.project = meta.project;
    if (meta.branch && !s.branch) s.branch = meta.branch;
    if (meta.entrypoint && !s.entrypoint) s.entrypoint = meta.entrypoint;
    if (meta.version) s.version = meta.version;
  }
  return s;
}

function getPrompt(s, pid, t) {
  if (!pid) pid = '_untracked';
  let p = s.prompts.get(pid);
  if (!p) {
    p = {
      id: pid, text: null, t: t || 0, endT: t || 0,
      cost: 0, requests: 0, subCost: 0, subRequests: 0,
      tok: blankTokens(), models: Object.create(null)
    };
    s.prompts.set(pid, p);
    s.promptOrder.push(pid);
  }
  return p;
}

/** Human-readable label for a session, best source first. */
function sessionTitle(s) {
  return s.customTitle || s.aiTitle || truncate(s.firstPrompt, 90) || 'Untitled session';
}

function truncate(str, n) {
  if (!str) return null;
  const one = String(str).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

/** Pull plain text out of a message content field (string or block array). */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const bits = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'tool_result') return null;      // not a human turn
    if (b.type === 'text' && b.text) bits.push(b.text);
  }
  return bits.length ? bits.join(' ') : null;
}

// ---------------------------------------------------------------- limits ----

/*
 * When you hit a usage limit, Claude Code writes the refusal into the
 * transcript as an assistant record with isApiErrorMessage and a synthetic
 * model, so it costs nothing and is skipped by the pricing path. The text is
 * the only place the limit is described - and for session limits it names the
 * reset time, which is the single most useful fact in this whole app:
 *
 *   "You've hit your session limit · resets 11:20am (America/Chicago)"
 *   "You've reached your Fable 5 limit. Run /usage-credits to continue..."
 */
function classifyLimit(text) {
  const s = String(text || '');
  if (/hit your (session|usage) limit/i.test(s)) {
    const m = /resets\s+(\d{1,2}:\d{2}\s*[ap]m)/i.exec(s);
    return { kind: 'session', model: null, resetText: m ? m[1] : null };
  }
  if (/reached your weekly limit|weekly limit/i.test(s)) {
    const m = /resets\s+(\d{1,2}:\d{2}\s*[ap]m)/i.exec(s);
    return { kind: 'weekly', model: null, resetText: m ? m[1] : null };
  }
  const mm = /reached your (.+?) limit/i.exec(s);
  if (mm) return { kind: 'model', model: mm[1].trim().slice(0, 40), resetText: null };
  return null;
}

/** "11:20am", seen at `atMs`, as an absolute time. Rolls to tomorrow if past. */
function parseResetAt(atMs, hhmm) {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})\s*([ap])m$/i.exec(String(hhmm).trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'p') h += 12;
  const d = new Date(atMs);
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, Number(m[2]), 0, 0);
  if (r.getTime() <= atMs) r.setDate(r.getDate() + 1);
  return r.getTime();
}

/*
 * Individual refusals arrive in bursts - one per retry - so collapse anything
 * of the same kind within GROUP_MS into a single lockout. Recovery is the
 * first billable response afterwards: the moment work actually resumed.
 */
const LOCKOUT_GROUP_MS = 10 * 60e3;

function lockouts() {
  const out = [];
  for (const h of limitHits) {
    const p = out[out.length - 1];
    if (p && p.kind === h.kind && p.model === h.model && h.t - p.lastAt < LOCKOUT_GROUP_MS) {
      p.lastAt = h.t; p.hits++;
      if (!p.resetAt && h.resetAt) { p.resetAt = h.resetAt; p.resetText = h.resetText; }
    } else {
      out.push({ t: h.t, lastAt: h.t, hits: 1, kind: h.kind, model: h.model,
                 resetText: h.resetText, resetAt: h.resetAt, sessionId: h.sessionId });
    }
  }
  // First billable response after each lockout ended.
  for (const l of out) {
    let lo = 0, hi = events.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1;
      if (events[mid].t > l.lastAt) { idx = mid; hi = mid - 1; } else lo = mid + 1; }
    l.recoveredAt = idx >= 0 ? events[idx].t : null;
    l.waitedMs = l.recoveredAt ? l.recoveredAt - l.lastAt : null;
    /*
      * Capacity came back sooner than the message promised: an early reset.
      * This can only ever be proven when you happened to be at the keyboard
      * before the promised time. Come back an hour late and an early reset is
      * indistinguishable from an on-time one, so say "unknown" rather than
      * quietly scoring it as normal and reporting a zero that means nothing.
      */
    const tol = Math.max(0, Number(CONFIG.earlyResetToleranceSec) || 60) * 1000;
    l.early = !!(l.resetAt && l.recoveredAt && l.recoveredAt < l.resetAt - tol);
    l.earlyByMs = l.early ? l.resetAt - l.recoveredAt : null;
    const grace = Math.max(0, Number(CONFIG.resetGraceMinutes) || 30) * 60e3;
    l.verdict = !l.resetAt || !l.recoveredAt ? 'unknown'
              : l.early ? 'early'
              : l.recoveredAt <= l.resetAt + grace ? 'ontime'
              : 'unknown';                      // back too late to tell either way
    l.lateByMs = l.resetAt && l.recoveredAt ? Math.max(0, l.recoveredAt - l.resetAt) : null;
  }
  return out;
}

/** Are we locked out right now, and until when? */
function blockState() {
  const all = lockouts();
  const last = all[all.length - 1];
  const now = Date.now();
  if (!last) return { blocked: false, lockouts: 0 };
  const blocked = !last.recoveredAt && (now - last.lastAt) < 12 * 3600e3;
  return {
    blocked,
    kind: blocked ? last.kind : null,
    model: blocked ? last.model : null,
    since: blocked ? last.t : null,
    resetAt: blocked ? last.resetAt : null,
    resetText: blocked ? last.resetText : null,
    resetsInMs: blocked && last.resetAt ? last.resetAt - now : null,
    lockouts: all.length,
    last
  };
}

// --------------------------------------------------------------- ingest ----

function projectNameFromPath(dir) {
  // ".../projects/C--Users-mike-code-myapp"  ->  "myapp"
  const parts = String(dir).split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dir;
}

function projectLabel(cwd, fallbackDir) {
  if (cwd) {
    const base = path.basename(cwd.replace(/[\\/]+$/, ''));
    if (base && base !== '.') return base;
    return cwd;                                       // e.g. "C:\"
  }
  return projectNameFromPath(fallbackDir);
}

/**
 * Ingest one transcript line.
 * `ctx` carries per-file state that must survive across incremental scans:
 * the project directory name, whether the file is a subagent log, and the
 * promptId the file was last inside (assistant lines don't carry one).
 */
function ingestLine(line, ctx) {
  if (!line || line[0] !== '{') return;
  let o;
  try { o = JSON.parse(line); } catch { return; }

  const sid = o.sessionId || ctx.sessionId;

  // ---- session metadata records (cheap, no usage) ----
  if (o.type === 'ai-title')     { if (sid) getSession(sid).aiTitle    = truncate(o.aiTitle, 120);    return; }
  if (o.type === 'custom-title') { if (sid) getSession(sid).customTitle = truncate(o.customTitle, 120); return; }
  if (o.type === 'last-prompt')  { return; }

  if (o.type === 'user') {
    if (!sid) return;
    if (o.isSidechain) { if (o.promptId) ctx.promptId = o.promptId; return; }
    const s = getSession(sid, {
      cwd: o.cwd, branch: o.gitBranch, entrypoint: o.entrypoint,
      version: o.version, project: projectLabel(o.cwd, ctx.dir)
    });
    if (o.promptId) ctx.promptId = o.promptId;
    const isHuman = o.origin ? o.origin.kind === 'human' : true;
    const txt = textOf(o.message && o.message.content);
    if (isHuman && txt) {
      const ts = Date.parse(o.timestamp || '') || Date.now();
      const p = getPrompt(s, o.promptId, ts);
      if (!p.text) { p.text = truncate(txt, 400); p.t = ts; }
      if (!s.firstPrompt) s.firstPrompt = txt;
      if (!s.start || ts < s.start) s.start = ts;
    }
    return;
  }

  if (o.type !== 'assistant') return;

  // A refusal, not a response: no tokens, but it is how we learn about limits.
  if (o.isApiErrorMessage) {
    if (o.uuid && limitSeen.has(o.uuid)) return;
    const info = classifyLimit(textOf(o.message && o.message.content));
    if (!info) return;
    if (o.uuid) limitSeen.add(o.uuid);
    const at = Date.parse(o.timestamp || '') || Date.now();
    limitHits.push({
      t: at, kind: info.kind, model: info.model,
      resetText: info.resetText, resetAt: parseResetAt(at, info.resetText),
      sessionId: sid || null
    });
    limitHits.sort((a, b) => a.t - b.t);
    return;
  }

  const m = o.message;
  if (!m || !m.usage) return;
  const model = m.model;
  if (!model || model === '<synthetic>') return;

  // A single API response is written to the transcript multiple times as it
  // streams. message.id + requestId identifies the response uniquely.
  const key = `${m.id || ''}:${o.requestId || ''}`;
  if (key !== ':') {
    if (seen.has(key)) return;
    seen.add(key);
  } else if (o.uuid) {
    if (seen.has(o.uuid)) return;
    seen.add(o.uuid);
  }

  const ts = Date.parse(o.timestamp || '') || Date.now();
  const u  = priceUsage(model, m.usage);
  if (!u.total) return;

  const sub  = !!(o.isSidechain || ctx.sub);
  const pid  = o.promptId || ctx.promptId || null;
  const proj = projectLabel(o.cwd, ctx.dir);

  events.push({
    t: ts, c: u.cost, m: model, p: proj, s: sid || '', pid, sub: sub ? 1 : 0,
    g: ctx.kind || (sub ? 'subagent' : 'main'),
    i: u.in, o: u.out, r: u.read, w: u.w5m + u.w1h, k: u.think, b: u.billable,
    e: o.effort || null
  });

  if (!sid) return;
  const s = getSession(sid, {
    cwd: o.cwd, branch: o.gitBranch, entrypoint: o.entrypoint,
    version: o.version, project: proj
  });
  if (!s.start || ts < s.start) s.start = ts;
  if (ts > s.end) s.end = ts;
  s.cost += u.cost; s.requests++;
  if (sub) { s.subCost += u.cost; s.subRequests++; }
  s.tok.in += u.in; s.tok.out += u.out; s.tok.read += u.read;
  s.tok.write += u.w5m + u.w1h; s.tok.think += u.think;
  const sm = s.models[model] || (s.models[model] = { cost: 0, requests: 0, tokens: 0 });
  sm.cost += u.cost; sm.requests++; sm.tokens += u.total;

  const p = getPrompt(s, pid, ts);
  if (!p.t || ts < p.t) p.t = ts;
  if (ts > p.endT) p.endT = ts;
  p.cost += u.cost; p.requests++;
  if (sub) { p.subCost += u.cost; p.subRequests++; }
  p.tok.in += u.in; p.tok.out += u.out; p.tok.read += u.read;
  p.tok.write += u.w5m + u.w1h; p.tok.think += u.think;
  const pm = p.models[model] || (p.models[model] = { cost: 0, requests: 0 });
  pm.cost += u.cost; pm.requests++;
}

// ---------------------------------------------------------------- scan ----

/**
 * Every .jsonl under ~/.claude/projects. The tree is deeper than it looks:
 *
 *   <project>/<session>.jsonl                                 main thread
 *   <project>/<session>/subagents/agent-N.jsonl               Task subagents
 *   <project>/<session>/subagents/workflows/wf_N/agent-N.jsonl  workflow agents
 *
 * Missing the nested ones undercounts total spend by a third. Rather than
 * trusting a fixed depth, classify by path structure: the first segment under
 * the project directory names the session, and any "subagents" segment marks
 * the file as delegated work.
 */
function listTranscripts() {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;                       // pure runaway guard
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.name.endsWith('.jsonl')) continue;

      const rel = path.relative(PROJECTS, full).split(/[\\/]/);
      if (rel.length < 2) continue;
      const projDir = rel[0];
      const sub  = rel.includes('subagents');
      // <project>/<session>.jsonl  |  <project>/<session>/.../agent.jsonl
      const sessionId = rel.length === 2 ? path.basename(rel[1], '.jsonl') : rel[1];
      const wfIdx = rel.indexOf('workflows');
      out.push({
        file: full,
        dir: projDir,
        sub,
        kind: wfIdx >= 0 ? 'workflow' : sub ? 'subagent' : 'main',
        workflow: wfIdx >= 0 && rel[wfIdx + 1] ? rel[wfIdx + 1] : null,
        sessionId
      });
    }
  };
  walk(PROJECTS, 0);
  return out;
}

/** Read only what's new in each transcript since last time. */
function scan(initial = false) {
  if (loadPricing() && !initial) {
    // Somebody corrected a rate. Throw the priced history away and read it all
    // back at the new rates, otherwise adding a missing model would leave every
    // past response for it stuck at $0.
    console.log('[burnmeter] pricing.json changed - re-pricing all history');
    events.length = 0; seen.clear(); cursors.clear(); sessions.clear();
    limitHits.length = 0; limitSeen.clear();
    activeCacheAt = -1;
    initial = true;
  }
  const cutoff = CONFIG.lookbackDays > 0 ? Date.now() - CONFIG.lookbackDays * 864e5 : 0;
  const files = listTranscripts();
  filesTracked = files.length;
  let added = 0;

  for (const t of files) {
    let st;
    try { st = fs.statSync(t.file); } catch { continue; }
    if (initial && cutoff && st.mtimeMs < cutoff) { cursors.set(t.file, { at: st.size, promptId: null }); continue; }

    const cur = cursors.get(t.file) || { at: 0, promptId: null };
    let from = cur.at;
    if (st.size < from) { from = 0; cur.promptId = null; }   // file was truncated/rewritten
    if (st.size === from) continue;

    let chunk = '';
    try {
      const fd = fs.openSync(t.file, 'r');
      const len = st.size - from;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, from);
      fs.closeSync(fd);
      chunk = buf.toString('utf8');
    } catch { continue; }

    // Don't consume a trailing partial line — leave it for the next pass.
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl === -1) continue;
    const usable = chunk.slice(0, lastNl);

    const ctx = { dir: t.dir, sub: t.sub, kind: t.kind, workflow: t.workflow,
                  sessionId: t.sessionId, promptId: cur.promptId };
    const before = events.length;
    for (const line of usable.split('\n')) ingestLine(line.trim(), ctx);
    added += events.length - before;

    cursors.set(t.file, { at: from + Buffer.byteLength(usable, 'utf8') + 1, promptId: ctx.promptId });
  }

  if (added) events.sort((a, b) => a.t - b.t);
  lastScanMs = Date.now();
  return added;
}

// ----------------------------------------------------------- rate limits ----

const num = v => (typeof v === 'number' && isFinite(v) ? v : null);

/** Real 5-hour / weekly consumption, written by the statusline hook. */
let limitsCache = { mtime: -1, at: 0, value: null };
function readLimits() {
  const now = Date.now();
  // Re-stat at most every 2s; re-parse only when the file actually changed.
  if (now - limitsCache.at < 2000 && limitsCache.value) return withStale(limitsCache.value);
  limitsCache.at = now;
  let st;
  try { st = fs.statSync(LIMITS_F); } catch { limitsCache.value = NO_LIMITS; return NO_LIMITS; }
  if (st.mtimeMs === limitsCache.mtime && limitsCache.value) return withStale(limitsCache.value);
  limitsCache.mtime = st.mtimeMs;
  limitsCache.value = parseLimits();
  return withStale(limitsCache.value);
}
const NO_LIMITS = { fiveHourPct: null, weekPct: null, updatedAt: 0, stale: true };
const withStale = v => v === NO_LIMITS ? v
  : Object.assign({}, v, { stale: (Date.now() / 1000 - (v.updatedAt || 0)) > 900 });
function parseLimits() {
  try {
    const j = JSON.parse(fs.readFileSync(LIMITS_F, 'utf8'));
    return {
      fiveHourPct:   num(j.five_hour_pct),
      fiveHourReset: num(j.five_hour_reset),
      weekPct:       num(j.seven_day_pct),
      weekReset:     num(j.seven_day_reset),
      updatedAt:     num(j.updated_at) || 0,
      model:         j.model || null,
      contextPct:    num(j.context_pct),
      sessionCost:   num(j.session_cost),
      sessionId:     j.session_id || null
    };
  } catch {
    return NO_LIMITS;
  }
}

// ------------------------------------------------------------ aggregate ----

function sumRange(from, to = Infinity) {
  let cost = 0, n = 0, tokIn = 0, tokOut = 0, tokRead = 0, tokWrite = 0, sub = 0, think = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.t < from) break;
    if (e.t > to) continue;
    cost += e.c; n++; tokIn += e.i; tokOut += e.o; tokRead += e.r; tokWrite += e.w;
    think += e.k; if (e.sub) sub += e.c;
  }
  return { cost, requests: n, in: tokIn, out: tokOut, read: tokRead, write: tokWrite, think, subCost: sub };
}

function breakdown(from, key, limit = 12) {
  const map = new Map();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.t < from) break;
    const k = e[key] || 'unknown';
    const cur = map.get(k) || { cost: 0, requests: 0, tokens: 0 };
    cur.cost += e.c; cur.requests++; cur.tokens += e.i + e.o + e.r + e.w;
    map.set(k, cur);
  }
  return [...map.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, limit);
}

/*
 * The fee buys a billing period, not a calendar month. If the plan renews on
 * the 14th, "this month" is meaningless and "this period" is what matters.
 */
function periodStart(d = new Date()) {
  const day = Math.min(28, Math.max(1, Math.round(Number(CONFIG.renewalDay)) || 1));
  let y = d.getFullYear(), m = d.getMonth();
  if (d.getDate() < day) m -= 1;                 // renewal not reached yet this month
  return new Date(y, m, day).getTime();
}
function periodEnd(d = new Date()) {
  const ps = new Date(periodStart(d));
  return new Date(ps.getFullYear(), ps.getMonth() + 1, ps.getDate()).getTime();
}

/** Active hours and human prompts inside a window - the denominators for
 *  "what am I really paying per hour / per prompt". */
function windowStats(from) {
  const last = new Map();
  let activeMs = 0;
  for (const e of events) {
    if (e.t < from || !e.s) continue;
    const prev = last.get(e.s);
    if (prev != null) activeMs += Math.min(IDLE_GAP, Math.max(0, e.t - prev));
    last.set(e.s, e.t);
  }
  let prompts = 0;
  for (const sess of sessions.values())
    for (const pr of sess.prompts.values())
      if (pr.text && pr.t >= from) prompts++;
  return { activeMs, prompts };
}

function startOfMonth(d = new Date()) { return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
function endOfMonth(d = new Date())   { return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(); }
function startOfDay(d = new Date())   { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

function sparkline(hours = 24, buckets = 48) {
  const now = Date.now();
  const span = hours * 36e5;
  const from = now - span;
  const w = span / buckets;
  const out = new Array(buckets).fill(0);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.t < from) break;
    const b = Math.min(buckets - 1, Math.floor((e.t - from) / w));
    out[b] += e.c;
  }
  return out;
}

/**
 * Daily totals across the billing period, oldest first. Days not yet reached
 * are listed with cost 0 so the chart always shows the whole period.
 */
function dailyThisPeriod(pStart, pEnd) {
  const day0 = startOfDay(new Date(pStart));
  const days = Math.round((pEnd - pStart) / 864e5);
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(day0); d.setDate(d.getDate() + i);           // DST-safe
    out.push({ d: d.getTime(), cost: 0, requests: 0, tokens: 0 });
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.t < pStart) break;
    const idx = Math.round((startOfDay(new Date(e.t)) - day0) / 864e5);
    if (idx >= 0 && idx < days) {
      out[idx].cost += e.c; out[idx].requests++;
      out[idx].tokens += e.i + e.o + e.r + e.w;
    }
  }
  return out;
}

/** Day-by-day series over the last N days, oldest first. */
function dailySeries(days = 60) {
  const today = startOfDay();
  const from  = today - (days - 1) * 864e5;
  const out = [];
  for (let i = 0; i < days; i++) out.push({ d: from + i * 864e5, cost: 0, requests: 0, sub: 0 });
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.t < from) break;
    const idx = Math.floor((startOfDay(new Date(e.t)) - from) / 864e5);
    if (idx < 0 || idx >= days) continue;
    out[idx].cost += e.c; out[idx].requests++; if (e.sub) out[idx].sub += e.c;
  }
  return out;
}

/** Which hours of the day you actually burn money in. */
function hourHistogram(from) {
  const out = new Array(24).fill(0);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.t < from) break;
    out[new Date(e.t).getHours()] += e.c;
  }
  return out;
}

/* ------------------------------------------------------- self-referential --
 * The real 5-hour and weekly percentages come from the statusline hook, which
 * only runs in the terminal UI - in the desktop app those meters stay empty
 * forever. So derive a usable stand-in from the user's own history: how this
 * block compares with their own busy blocks.
 *
 * This is NOT Anthropic's allowance and must never be labelled as such. It
 * answers a different, still-useful question: "am I going harder than usual?"
 *
 * If the user knows their true percentage (the app shows it, or a terminal
 * session wrote limits.json) one calibration converts these into real numbers -
 * see calibrate() below.
 */

let selfCache = { n: -1, at: 0, fiveHour: null, week: null };

/** Cost per hour bucket across all recorded history. */
function hourlyBuckets(metric = 'cost') {
  if (!events.length) return [];
  const from = Math.floor(events[0].t / 36e5) * 36e5;
  const n = Math.ceil((Date.now() - from) / 36e5) + 1;
  const arr = new Float64Array(Math.max(1, n));
  const tokens = metric === 'tokens';
  for (const e of events) {
    const i = Math.floor((e.t - from) / 36e5);
    if (i >= 0 && i < arr.length) arr[i] += tokens ? (e.i + e.o + e.r + e.w) : e.c;
  }
  return arr;
}

/*
 * How this week compares with the biggest week you have actually managed.
 * Anthropic does not publish the weekly ceiling, so inventing one would be a
 * lie dressed as a gauge. Your own best rolling seven days is a number we can
 * stand behind: beat it and you genuinely found headroom you were not using.
 */
let weekMaxCache = { n: -1, at: 0, val: null };
function weekMax() {
  const now = Date.now();
  if (weekMaxCache.n === events.length && now - weekMaxCache.at < 30e3) return weekMaxCache.val;
  const arr = hourlyBuckets('tokens');
  const WIN = 24 * 7;
  const from = events.length ? Math.floor(events[0].t / 36e5) * 36e5 : now;
  let best = 0, bestEnd = 0, sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= WIN) sum -= arr[i - WIN];
    if (i >= WIN - 1 && sum > best) { best = sum; bestEnd = from + (i + 1) * 36e5; }
  }
  const c = sumRange(now - 7 * 864e5);
  const current = c.in + c.out + c.read + c.write;

  /*
   * A big week is either you pushing harder or the ceiling being raised on you.
   * Those are different facts and only one of them is a habit you can repeat,
   * so count the lockouts inside each window and let the two weeks be compared
   * on equal terms.
   */
  const lk = lockouts();
  const between = (from, to) => lk.filter(l => l.lastAt >= from && l.lastAt < to);
  const thisWin = between(now - 7 * 864e5, now + 1);
  const bestWin = bestEnd ? between(bestEnd - 7 * 864e5, bestEnd) : [];
  const assessable = a => a.filter(l => l.verdict !== 'unknown').length;
  const hits = {
    now: thisWin.length, best: bestWin.length,
    earlyNow: thisWin.filter(l => l.early).length,
    earlyBest: bestWin.filter(l => l.early).length,
    // How many of those we could actually judge, so a zero is readable.
    judgedNow: assessable(thisWin), judgedBest: assessable(bestWin)
  };
  // Lockouts inside the charted fortnight, so the chart can mark the days.
  const chartFrom = startOfDay() - 13 * 864e5;
  const marks = lk.filter(l => l.lastAt >= chartFrom)
    .map(l => ({ t: l.lastAt, kind: l.kind, early: !!l.early,
                 waitedMs: l.waitedMs, earlyByMs: l.earlyByMs }));
  // Enough history to have seen a full week? Below that, "best" is meaningless.
  const spanDays = events.length ? (now - events[0].t) / 864e5 : 0;
  const val = {
    current, best, bestEndedAt: bestEnd || null,
    haveFullWeek: spanDays >= 7,
    pct: best > 0 ? (current / best) * 100 : null,
    headroom: Math.max(0, best - current),
    record: best > 0 && current >= best,
    hits, marks,
    days: dailyTokens(14)
  };
  weekMaxCache = { n: events.length, at: now, val };
  return val;
}

/** Token totals per day, oldest first, for the week-max chart. */
function dailyTokens(days = 14) {
  const today = startOfDay();
  const from = today - (days - 1) * 864e5;
  const out = [];
  for (let i = 0; i < days; i++) out.push({ d: from + i * 864e5, tokens: 0, cost: 0 });
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.t < from) break;
    const idx = Math.round((startOfDay(new Date(e.t)) - from) / 864e5);
    if (idx >= 0 && idx < days) {
      out[idx].tokens += e.i + e.o + e.r + e.w;
      out[idx].cost += e.c;
    }
  }
  return out;
}

/** Percentile of every rolling `win`-bucket sum, ignoring idle stretches. */
function rollingPercentile(arr, win, p) {
  if (!arr.length || arr.length < win) return null;
  const sums = [];
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= win) sum -= arr[i - win];
    if (i >= win - 1) sums.push(sum);
  }
  const active = sums.filter(v => v > 0.05).sort((a, b) => a - b);
  if (active.length < 3) return null;
  return active[Math.min(active.length - 1, Math.floor(active.length * p))];
}

function selfLimits() {
  const now = Date.now();
  if (selfCache.n === events.length && now - selfCache.at < 60e3) return selfCache;
  const arr = hourlyBuckets();
  const busy5h = rollingPercentile(arr, 5, 0.9);
  const busyWk = rollingPercentile(arr, 24 * 7, 0.9);
  const cur5h = sumRange(now - 5 * 36e5).cost;
  const curWk = sumRange(now - 7 * 864e5).cost;
  const cal = CONFIG.calibration || null;
  const mk = (cur, ref, allowance) => {
    if (allowance > 0) return { pct: (cur / allowance) * 100, cur, ref: allowance, real: true };
    if (!ref) return null;
    return { pct: (cur / ref) * 100, cur, ref, real: false };
  };
  selfCache = {
    n: events.length, at: now,
    fiveHour: mk(cur5h, busy5h, cal && cal.fiveHourAllowance),
    week:     mk(curWk, busyWk, cal && cal.weekAllowance)
  };
  return selfCache;
}

/**
 * Turn one observed percentage into a standing allowance. If the user is at
 * $12 of value and the app says that is 30% of the 5-hour limit, the limit is
 * worth about $40 of value - and every later block can be measured against it.
 */
function calibrate(which, pct) {
  const now = Date.now();
  const cur = which === 'week'
    ? sumRange(now - 7 * 864e5).cost
    : sumRange(now - 5 * 36e5).cost;
  if (!(pct > 0) || !(cur > 0)) return null;
  const allowance = cur / (pct / 100);
  CONFIG.calibration = Object.assign({}, CONFIG.calibration, {
    [which === 'week' ? 'weekAllowance' : 'fiveHourAllowance']: allowance,
    [which === 'week' ? 'weekAt' : 'fiveHourAt']: now
  });
  saveConfig(CONFIG);
  selfCache.at = 0;
  return allowance;
}

/** >1 means burning faster than the window allows; <1 means leaving value on the table. */
function paceOf(pct, resetsInMs, windowMs) {
  if (pct == null || resetsInMs == null) return null;
  const consumedFraction = Math.min(1, Math.max(0, 1 - resetsInMs / windowMs));
  if (consumedFraction <= 0.02) return null;
  return (pct / 100) / consumedFraction;
}

// ------------------------------------------------------- session views ----

/*
 * Sessions get resumed days later, so end-minus-start is wall-clock span, not
 * time spent — one session here spans 1,066 hours. Active time sums the gaps
 * between consecutive responses, capping any gap longer than IDLE_GAP, which
 * is what makes $/hour mean anything.
 */
const IDLE_GAP = 5 * 60e3;
let activeCacheAt = -1;

function refreshActive() {
  if (activeCacheAt === events.length) return;
  for (const s of sessions.values()) s.activeMs = 0;
  const last = new Map();
  for (const e of events) {
    if (!e.s) continue;
    const s = sessions.get(e.s);
    if (!s) continue;
    const prev = last.get(e.s);
    if (prev != null) s.activeMs += Math.min(IDLE_GAP, Math.max(0, e.t - prev));
    last.set(e.s, e.t);
  }
  activeCacheAt = events.length;
}

function sessionSummary(s) {
  refreshActive();
  const models = Object.entries(s.models)
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.cost - a.cost);
  let humanPrompts = 0;
  for (const p of s.prompts.values()) if (p.text) humanPrompts++;
  return {
    id: s.id,
    title: sessionTitle(s),
    hasRealTitle: !!(s.customTitle || s.aiTitle),
    project: s.project || 'unknown',
    cwd: s.cwd,
    branch: s.branch && s.branch !== 'HEAD' ? s.branch : null,
    entrypoint: s.entrypoint,
    version: s.version,
    start: s.start || s.end,
    end: s.end,
    activeMs: s.activeMs || 0,
    spanMs: Math.max(0, s.end - (s.start || s.end)),
    durationMs: s.activeMs || 0,          // "duration" means active time
    perHour: s.activeMs > 60e3 ? s.cost / (s.activeMs / 36e5) : null,
    cost: s.cost,
    requests: s.requests,
    subCost: s.subCost,
    subRequests: s.subRequests,
    prompts: humanPrompts,
    costPerPrompt: humanPrompts ? s.cost / humanPrompts : null,
    tok: s.tok,
    topModel: models.length ? models[0].name : null,
    models
  };
}

function sessionDetail(s) {
  const base = sessionSummary(s);
  const prompts = s.promptOrder
    .map(pid => s.prompts.get(pid))
    .filter(p => p && (p.cost > 0 || p.text))
    .map(p => ({
      id: p.id,
      text: p.text,
      t: p.t,
      durationMs: Math.max(0, p.endT - p.t),
      cost: p.cost,
      requests: p.requests,
      subCost: p.subCost,
      subRequests: p.subRequests,
      tok: p.tok,
      models: Object.entries(p.models).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.cost - a.cost)
    }))
    .sort((a, b) => a.t - b.t);

  // Cost accumulated over the life of the session, for the drill-down chart.
  const timeline = [];
  let run = 0;
  for (const e of events) {
    if (e.s !== s.id) continue;
    run += e.c;
    timeline.push({ t: e.t, c: run });
  }
  return { ...base, promptList: prompts, timeline };
}

function listSessions(opts = {}) {
  const { from = 0, to = Infinity, q = '', sort = 'cost', limit = 400 } = opts;
  const needle = String(q || '').toLowerCase().trim();
  let out = [];
  for (const s of sessions.values()) {
    if (!s.requests) continue;
    const end = s.end || s.start;
    if (end < from || (s.start || end) > to) continue;
    const sum = sessionSummary(s);
    if (needle) {
      const hay = `${sum.title} ${sum.project} ${sum.cwd || ''} ${sum.topModel || ''}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    out.push(sum);
  }
  const sorters = {
    cost:     (a, b) => b.cost - a.cost,
    recent:   (a, b) => b.end - a.end,
    oldest:   (a, b) => a.start - b.start,
    duration: (a, b) => b.durationMs - a.durationMs,
    requests: (a, b) => b.requests - a.requests,
    rate:     (a, b) => (b.cost / Math.max(1, b.durationMs)) - (a.cost / Math.max(1, a.durationMs)),
    prompts:  (a, b) => b.prompts - a.prompts
  };
  out.sort(sorters[sort] || sorters.cost);
  const total = out.length;
  const grand = out.reduce((n, s) => n + s.cost, 0);
  return { sessions: out.slice(0, limit), total, grandCost: grand };
}

// ------------------------------------------------------------- state ----

function allTimeRange() {
  if (!events.length) return { from: Date.now(), to: Date.now() };
  return { from: events[0].t, to: events[events.length - 1].t };
}

/* ------------------------------------------------------------- instances --
 * Which Claude Code windows are actually running right now.
 *
 * The statusline hook would tell us the current session id, but it only fires
 * in the terminal UI - in the desktop app it never runs, which left this blind
 * and the "this session" reading permanently empty. The transcripts already
 * carry the answer: a session that produced a response in the last few minutes
 * is live, and each one is a separate window. No hook needed.
 */
const ACTIVE_WINDOW_MS = 15 * 60e3;   // still counts as running
const HOT_WINDOW_MS    = 90e3;        // mid-response right now

function activeSessions(windowMs = ACTIVE_WINDOW_MS) {
  const now = Date.now(), from = now - windowMs;
  const map = new Map();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.t < from) break;
    if (!e.s) continue;
    let a = map.get(e.s);
    if (!a) {
      a = { id: e.s, cost: 0, requests: 0, tokens: 0, subCost: 0,
            first: e.t, last: e.t, models: Object.create(null) };
      map.set(e.s, a);
    }
    a.cost += e.c; a.requests++; a.tokens += e.b;
    if (e.sub) a.subCost += e.c;
    if (e.t > a.last) a.last = e.t;
    if (e.t < a.first) a.first = e.t;
    a.models[e.m] = (a.models[e.m] || 0) + 1;
  }

  return [...map.values()].map(a => {
    const s = sessions.get(a.id);
    const models = Object.entries(a.models).sort((x, y) => y[1] - x[1]);
    // Rate over the window we actually observed, floored at a minute so a
    // single response doesn't read as an absurd hourly figure.
    const spanHr = Math.max(1 / 60, (now - a.first) / 36e5);
    return {
      id: a.id,
      title: s ? sessionTitle(s) : a.id.slice(0, 8),
      project: s ? (s.project || 'unknown') : 'unknown',
      cwd: s ? s.cwd : null,
      windowCost: a.cost,
      windowRequests: a.requests,
      windowTokens: a.tokens,
      subCost: a.subCost,
      perHour: a.cost / spanHr,
      lastSeen: a.last,
      idleMs: now - a.last,
      hot: (now - a.last) < HOT_WINDOW_MS,
      topModel: models.length ? models[0][0] : null,
      sessionCost: s ? s.cost : a.cost,
      sessionRequests: s ? s.requests : a.requests,
      sessionStart: s ? s.start : a.first
    };
  }).sort((x, y) => y.lastSeen - x.lastSeen);
}

function buildState() {
  const now = Date.now();
  const limits = readLimits();

  // --- needle: recent burn rate in $/hour -----------------------------------
  const nw = CONFIG.needleWindowSec * 1000;
  const rateNow  = sumRange(now - nw).cost / (nw / 36e5);
  const rateInst = sumRange(now - 60e3).cost * 60;
  const rate1h   = sumRange(now - 36e5).cost;

  // --- windows --------------------------------------------------------------
  const today  = sumRange(startOfDay());
  const week7  = sumRange(now - 7 * 864e5);
  const hour24 = sumRange(now - 864e5);
  const all    = sumRange(0);

  // 5-hour block: align to the real reset clock when the statusline gave us one.
  let blockFrom;
  if (limits.fiveHourReset) blockFrom = limits.fiveHourReset * 1000 - 5 * 36e5;
  else blockFrom = now - 5 * 36e5;
  const block = sumRange(Math.max(blockFrom, now - 5 * 36e5));
  const blockResetsIn = limits.fiveHourReset ? limits.fiveHourReset * 1000 - now : null;
  const weekResetsIn  = limits.weekReset ? limits.weekReset * 1000 - now : null;

  // --- the three numbers --------------------------------------------------
  //
  //   fee      what you pay: flat, per billing period
  //   retail   what the same usage would cost on pay-as-you-go API rates
  //   rate     actual dollars per retail dollar = fee / retail over 30 days
  //
  // Everything else is one of those or a ratio of two. The trailing 30 days
  // is the denominator because it is stable: a calendar month two days in
  // projects nonsense, a rolling month does not.
  const fee = Math.max(0.01, Number(CONFIG.monthlyUsd) || 0);
  const pStart = periodStart(), pEnd = periodEnd();
  const period = sumRange(pStart);
  const periodDays = (pEnd - pStart) / 864e5;
  const elapsed  = Math.max(1, now - pStart);
  const fraction = Math.min(1, elapsed / (pEnd - pStart));
  const daysLeft = Math.max(0, (pEnd - now) / 864e5);

  const d30 = sumRange(now - 30 * 864e5);
  const retail30 = d30.cost;
  const rate = retail30 > 0.01 ? fee / retail30 : null;       // null = no usage yet
  const tokens30 = d30.in + d30.out + d30.read + d30.write;
  const ws30 = windowStats(now - 30 * 864e5);
  const activeHours30 = ws30.activeMs / 36e5;

  // Projection from the rolling pace, not a two-day sample stretched across
  // a month.
  const perDay30 = retail30 / 30;
  const projected = period.cost + perDay30 * daysLeft;
  const multiple  = period.cost / fee;
  const breakEvenAt = period.cost >= fee && period.cost > 0
    ? pStart + (fee / period.cost) * elapsed : null;
  const perDayNeeded = fee / periodDays;

  const exchange = {
    fee, retail30, rate,
    multiple30: retail30 / fee,
    discount: rate != null ? 1 - rate : null,               // negative = paying over retail
    tokens30, activeHours30, prompts30: ws30.prompts,
    perMtokRetail: tokens30 > 0 ? retail30 / (tokens30 / 1e6) : null,
    perMtokActual: tokens30 > 0 ? fee / (tokens30 / 1e6) : null,
    perHourRetail: activeHours30 > 0.05 ? retail30 / activeHours30 : null,
    perHourActual: activeHours30 > 0.05 ? fee / activeHours30 : null,
    perPromptRetail: ws30.prompts > 0 ? retail30 / ws30.prompts : null,
    perPromptActual: ws30.prompts > 0 ? fee / ws30.prompts : null
  };
  const perDayActual = perDay30;
  const monthStart = pStart, monthEnd = pEnd;          // keep the old names alive below

  // All-time: how many months of subscription have you earned back?
  const span = allTimeRange();
  const monthsTracked = Math.max(1 / 30, (span.to - span.from) / (30.44 * 864e5));

  // Which windows are running. The statusline names the current one when it is
  // available; otherwise the most recently active session is the best answer,
  // and it is the right one in the overwhelmingly common case.
  const active = activeSessions();
  let live = null;
  if (limits.sessionId && sessions.has(limits.sessionId)) {
    live = sessionSummary(sessions.get(limits.sessionId));
  } else if (active.length && sessions.has(active[0].id)) {
    live = sessionSummary(sessions.get(active[0].id));
  }

  return {
    now,
    boot: BOOT_AT,
    version: VERSION,
    update: updateState,
    plan:  { name: CONFIG.planName, monthlyUsd: fee },
    scanning,
    filesTracked,
    eventsTracked: events.length,
    sessionsTracked: sessions.size,
    lastScanMs,
    bootMs,
    unknownModels: [...UNKNOWN_MODELS],
    dataFrom: span.from,

    rate: { perHour: rateNow, instant: rateInst, lastHour: rate1h, windowSec: CONFIG.needleWindowSec },

    windows: { today, hour24, block, week7, month: period, d30, all, blockResetsIn, weekResetsIn },

    mode: CONFIG.pricingMode || 'retail',
    exchange,
    period: {
      start: pStart, end: pEnd, days: periodDays, fraction, daysLeft,
      renewalDay: CONFIG.renewalDay || 1,
      retail: period.cost, requests: period.requests,
      feeElapsed: fee * fraction                            // what the clock has consumed
    },

    worth: {
      fee, spent: period.cost, multiple, projected,
      projectedMultiple: projected / fee,
      monthFraction: fraction,
      breakEvenAt, brokeEven: period.cost >= fee,
      perDayNeeded, perDayActual,
      daysLeft,
      allTimeValue: all.cost,
      allTimeFees: fee * monthsTracked,
      allTimeMultiple: all.cost / (fee * monthsTracked),
      monthsTracked
    },

    limits: {
      fiveHourPct: limits.fiveHourPct,
      weekPct:     limits.weekPct,
      stale:       limits.stale,
      updatedAt:   limits.updatedAt,
      contextPct:  limits.contextPct,
      model:       limits.model,
      sessionId:   limits.sessionId,
      fiveHourPace: paceOf(limits.fiveHourPct, blockResetsIn, 5 * 36e5),
      weekPace:     paceOf(limits.weekPct, weekResetsIn, 7 * 864e5),
      // Stand-in for when the statusline hook never runs (desktop app).
      self: selfLimits(),
      calibration: CONFIG.calibration || null
    },

    block: blockState(),
    live,
    active,
    activeCount: active.length,
    activeCost: active.reduce((n, a) => n + a.windowCost, 0),
    spark:  sparkline(24, 48),
    daily:  dailyThisPeriod(pStart, pEnd),
    // Goals are config rather than a scan result, so they are layered on top
    // of the cached scan instead of being trapped inside it.
    weekMax: Object.assign({}, weekMax(), {
      goal: Number(CONFIG.weekTokenGoal) || 0,
      coverageGoal: Number(CONFIG.blockCoverageGoal) || 0
    }),
    tuning: {
      weekTokenGoal: Number(CONFIG.weekTokenGoal) || 0,
      blockCoverageGoal: Number(CONFIG.blockCoverageGoal) || 0,
      earlyResetToleranceSec: Number(CONFIG.earlyResetToleranceSec) || 60,
      resetGraceMinutes: Number(CONFIG.resetGraceMinutes) || 30,
      idleAlert: !!CONFIG.idleAlert,
      idleAfterMin: Number(CONFIG.idleAfterMin) || 20,
      idleRepeatMin: Number(CONFIG.idleRepeatMin) || 60,
      quietFromHour: Number(CONFIG.quietFromHour),
      quietToHour: Number(CONFIG.quietToHour)
    },
    byModel:   breakdown(pStart, 'm'),
    byProject: breakdown(pStart, 'p'),
    recent: events.slice(-14).reverse().map(e => ({
      t: e.t, c: e.c, m: e.m, p: e.p, sub: e.sub,
      in: e.i, out: e.o, read: e.r, write: e.w, think: e.k
    }))
  };
}

/** Small payload for the floating gauge — cheap enough to poll hard. */
function buildMini() {
  const now = Date.now();
  const limits = readLimits();
  const nw = CONFIG.needleWindowSec * 1000;
  const month = sumRange(periodStart());
  const fee = Math.max(0.01, Number(CONFIG.monthlyUsd) || 0);
  const retail30m = sumRange(now - 30 * 864e5).cost;
  const today = sumRange(startOfDay());
  const blockResetsIn = limits.fiveHourReset ? limits.fiveHourReset * 1000 - now : null;
  const active = activeSessions();
  let liveId = limits.sessionId && sessions.has(limits.sessionId) ? limits.sessionId
             : (active.length ? active[0].id : null);
  let live = null;
  if (liveId && sessions.has(liveId)) {
    const s = sessions.get(liveId);
    live = { cost: s.cost, requests: s.requests, title: sessionTitle(s), start: s.start };
  }
  // A short burn history for the faces that draw a shape rather than a number
  // (equalizer bars, terminal sparkline). 20 buckets over the last 40 minutes.
  const SPARK_N = 20, SPARK_MS = 40 * 60e3;
  const spark = new Array(SPARK_N).fill(0);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.t < now - SPARK_MS) break;
    const b = Math.min(SPARK_N - 1, Math.floor((e.t - (now - SPARK_MS)) / (SPARK_MS / SPARK_N)));
    spark[b] += e.c;
  }

  return {
    now,
    boot: BOOT_AT,
    rate: sumRange(now - nw).cost / (nw / 36e5),
    burst: sumRange(now - 60e3).cost * 60,
    today: today.cost,
    month: month.cost,
    allTime: sumRange(0).cost,
    spark,
    multiple: month.cost / fee,
    fee,
    // Exchange rate, actual $ per retail $. Named to never collide with the
    // burn rate above - a duplicate `rate` key here silently replaced the
    // needle's reading with 0.03 for a whole release.
    xrate: retail30m > 0.01 ? fee / retail30m : null,
    mode: CONFIG.pricingMode || 'retail',
    periodFraction: Math.min(1, (now - periodStart()) / (periodEnd() - periodStart())),
    planName: CONFIG.planName,
    tokensLastMin: (() => { let t = 0; for (let i = events.length - 1; i >= 0; i--) { const e = events[i]; if (e.t < now - 60e3) break; t += e.b; } return t; })(),
    fiveHourPct: limits.fiveHourPct,
    weekPct: limits.weekPct,
    contextPct: limits.contextPct,
    self: selfLimits(),
    blockResetsIn,
    stale: limits.stale,
    live,
    block: (() => { const b = blockState();
      return { blocked: b.blocked, kind: b.kind, model: b.model,
               resetsInMs: b.resetsInMs, resetText: b.resetText }; })(),
    instances: active.length,
    instancesHot: active.filter(a => a.hot).length,
    instanceCost: active.reduce((n, a) => n + a.windowCost, 0),
    instanceRate: active.reduce((n, a) => n + a.perHour, 0),
    instanceList: active.slice(0, 6).map(a => ({
      title: a.title, project: a.project, perHour: a.perHour,
      windowCost: a.windowCost, hot: a.hot, idleMs: a.idleMs
    })),
    scale: CONFIG.miniScale,
    metric: CONFIG.miniMetric,
    skin: CONFIG.miniSkin,
    layout: CONFIG.miniLayout || 'single',
    rect: CONFIG.miniRect || null,
    cluster: CONFIG.miniCluster || ['rate', 'today', 'fivehour', 'week'],
    onTop: !!CONFIG.miniOnTop
  };
}

// ---------------------------------------------------------------- alerts ----

/*
 * Being locked out is not the expensive part. Not noticing when the lockout
 * ends is: an hour of sitting on your hands after capacity came back is an
 * hour of the allowance you paid for, gone.
 *
 * Three moments are worth a word, and each fires at most once per lockout:
 *   hit    you just got blocked - and here is when it says it comes back
 *   reset  the stated reset time has arrived, so try again
 *   back   work resumed, and whether it resumed earlier than promised
 *
 * Only transitions this process actually watched are announced. Restarting
 * the server does not re-announce a lockout from last week.
 */
let alertState = { key: null, sawBlocked: false, hit: false, reset: false, back: false };
const alertLog = [];

function notify(title, body, opts = {}) {
  alertLog.push({ t: Date.now(), title, body });
  if (alertLog.length > 50) alertLog.shift();
  console.log(`[burnmeter] ${title} - ${body}`);
  if (process.platform !== 'win32') return;
  const script = path.join(DESKTOP_D, 'notify.ps1');
  if (fs.existsSync(script)) {
    const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
                  '-Title', title, '-Body', body];
    if (CONFIG.alertSound && opts.sound !== false) argv.push('-Sound');
    try { execFile('powershell.exe', argv, { timeout: 10000, windowsHide: true }, () => {}); } catch {}
  }
  // Put the gauge where it will be seen, too: a toast can be missed.
  if (opts.raise !== false) raiseWindow('mini').catch(() => {});
  if (opts.party && CONFIG.partyOnReset) throwParty(title, body);
}

/*
 * A window of confetti. Only for good news - getting blocked does not deserve
 * a fanfare - and only one at a time.
 */
let partyUntil = 0;
function throwParty(title, body) {
  const now = Date.now();
  if (now < partyUntil) return;                       // one is already running
  const secs = Math.min(120, Math.max(3, Number(CONFIG.partySeconds) || 15));
  partyUntil = now + (secs + 4) * 1000;
  const media = partyMedia();
  const pick = media.length ? media[(Math.random() * media.length) | 0] : null;
  const q = `?title=${encodeURIComponent(title)}&sub=${encodeURIComponent(body)}` +
            `&secs=${secs}&sound=${CONFIG.alertSound ? 1 : 0}` +
            (pick ? `&img=${encodeURIComponent(pick)}` : '');
  openWindow('party', { query: q });
  // Chromium restores the profile's remembered bounds and quietly ignores
  // --window-size, and a party behind your other windows is not a party.
  setTimeout(() => {
    winCmd('party', ['-Action', 'size', '-Width', '900', '-Height', '620']);
    winCmd('party', ['-Action', 'top']);
  }, 1400);
  setTimeout(() => winClose('party'), (secs + 3) * 1000);   // belt and braces
}

/** Drive a window by title through the desktop helper. */
function winCmd(which, args) {
  if (process.platform !== 'win32') return;
  const script = path.join(DESKTOP_D, 'window.ps1');
  if (!fs.existsSync(script)) return;
  try {
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
       '-Title', WINDOW_TITLE[which] || 'BurnMeter', '-Exact', ...args],
      { timeout: 8000, windowsHide: true }, () => {});
  } catch {}
}

/** Close a window by title, for when the page's own window.close() is refused. */
function winClose(which) { winCmd(which, ['-Action', 'close']); }

const clockOf = ms => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const mins = ms => ms < 60e3 ? 'under a minute'
  : ms < 36e5 ? Math.round(ms / 60e3) + ' minutes'
  : (ms / 36e5).toFixed(1) + ' hours';

/*
 * Idle while capacity is going spare.
 *
 * On a flat-fee plan the expensive mistake is not overspending, it is sitting
 * still with a five-hour window open: the window expires whether or not you
 * use it, and nothing carries over. So this watches for nothing running while
 * there is room left against the week's target, and says so once.
 *
 * Deliberately opt-in, rate-limited, and silent at night. An app that nags you
 * to work at three in the morning is not a productivity tool, it is a problem.
 */
let idleState = { notifiedAt: 0, wasIdle: false };

/** Is `t` inside the do-not-disturb window? Handles it wrapping past midnight. */
function inQuietHours(t) {
  const from = Number(CONFIG.quietFromHour), to = Number(CONFIG.quietToHour);
  if (!isFinite(from) || !isFinite(to) || from === to) return false;
  const h = new Date(t).getHours();
  return from < to ? (h >= from && h < to) : (h >= from || h < to);
}

function checkIdle() {
  if (!CONFIG.idleAlert) return;
  const now = Date.now();
  if (inQuietHours(now)) return;
  if (!events.length) return;

  // Locked out is not idle. There is nothing to be done about it and saying
  // so would be the most annoying possible moment to be told to work harder.
  if (blockState().blocked) return;

  if (activeSessions(ACTIVE_WINDOW_MS).length) { idleState.wasIdle = false; return; }

  const idleFor = now - events[events.length - 1].t;
  const need = Math.max(5, Number(CONFIG.idleAfterMin) || 20) * 60e3;
  if (idleFor < need) { idleState.wasIdle = false; return; }

  const gapMin = Math.max(need, (Number(CONFIG.idleRepeatMin) || 60) * 60e3);
  if (now - idleState.notifiedAt < gapMin) return;

  // Only worth interrupting for if there is headroom actually being lost.
  const wm = weekMax();
  const target = Number(CONFIG.weekTokenGoal) || wm.best || 0;
  if (!target) return;
  const short = target - wm.current;
  if (short <= 0) return;                       // already at or past the target

  idleState.notifiedAt = now;
  idleState.wasIdle = true;
  const perDay = short / 7;
  notify('Nothing running',
    `Idle ${mins(idleFor)} with ${fmtTokens(short)} still to go this week `
    + `- about ${fmtTokens(perDay)} a day. The block you are in expires either way.`,
    { raise: false });
}

/** Same scaling the dashboard uses, so the toast and the page agree. */
function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return Math.round(n / 1e6) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}

function checkAlerts() {
  if (!CONFIG.alertOnReset) return;
  const b = blockState();
  if (!b.last) return;
  const key = String(b.last.t);
  if (key !== alertState.key) alertState = { key, sawBlocked: false, hit: false, reset: false, back: false };

  const now = Date.now();
  const fresh = now - b.last.lastAt < 12 * 3600e3;

  if (b.blocked && fresh) {
    if (!alertState.sawBlocked) {
      alertState.sawBlocked = true;
      // Only announce the hit itself if it happened while we were watching.
      if (now - b.last.lastAt < 5 * 60e3 && !alertState.hit) {
        alertState.hit = true;
        const what = b.kind === 'model' ? `${b.model} limit` : `${b.kind} limit`;
        notify('Locked out - ' + what,
          b.resetAt ? `Back at ${clockOf(b.resetAt)}, about ${mins(b.resetAt - now)} away.`
                    : 'No reset time given. BurnMeter will tell you when it clears.');
      }
    }
    // The moment the stated reset arrives.
    if (b.resetAt && !alertState.reset && now >= b.resetAt && now - b.resetAt < 10 * 60e3) {
      alertState.reset = true;
      notify('Limit should be clear', `It said ${clockOf(b.resetAt)}. That has passed - go.`,
             { party: true });
    }
  } else if (alertState.sawBlocked && !alertState.back && b.last.recoveredAt) {
    // We watched it blocked and work has resumed.
    alertState.back = true;
    notify('Capacity is back',
      b.last.early
        ? `Reset ${mins(b.last.earlyByMs)} earlier than it said. You have extra room.`
        : `Locked out for ${mins(b.last.waitedMs || 0)}.`,
      { party: true });
  }
}

// --------------------------------------------------------------- update ----

/*
 * We check the repo for a newer version and say so. We never install on our
 * own — replacing running code without being asked is not ours to decide.
 * Offline, private repo, no repo configured: all just mean "no news".
 */
let updateState = { checked: false, available: false, current: VERSION };
let updating = false;

async function checkForUpdate(quiet) {
  try {
    const r = await updater.check();
    updateState = Object.assign({ current: VERSION, checked: true }, r);
    if (r.ok && r.available && !quiet) {
      console.log(`[burnmeter] v${r.latest} is available (you have v${r.current}) — update from the dashboard, or: node update.js`);
    }
    pushState();
  } catch (e) {
    updateState = { checked: true, ok: false, current: VERSION, reason: e.message };
  }
  return updateState;
}

/** Relaunch into the new code once files are swapped. */
function relaunch() {
  for (const res of clients) { try { res.end(); } catch {} }
  clients.clear();
  const go = () => {
    try {
      spawn(process.execPath, [path.join(APP_DIR, 'server.js')],
            { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch {}
    process.exit(0);
  };
  try { server.close(go); } catch { go(); }
  setTimeout(go, 2500).unref?.();      // don't hang on a stuck socket
}

// --------------------------------------------------------------- server ----

const clients = new Set();

function pushState() {
  if (!clients.size) return;
  // Build each payload at most once, and only if something is listening for it.
  // The gauge is often the only window open all day; buildState is the costly
  // one and there's no reason to run it every second for nobody.
  let full = null, mini = null;
  for (const res of clients) {
    if (res._mini) { if (mini === null) mini = `data: ${JSON.stringify(buildMini())}\n\n`; }
    else if (full === null) full = `data: ${JSON.stringify(buildState())}\n\n`;
    if (full !== null && mini !== null) break;
  }
  for (const res of clients) {
    const payload = res._mini ? mini : full;
    if (payload) { try { res.write(payload); } catch {} }
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.css': 'text/css; charset=utf-8', '.json': 'application/json',
               '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
               '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
               '.webp': 'image/webp', '.avif': 'image/avif',
               '.mp4': 'video/mp4', '.webm': 'video/webm' };

function json(res, obj, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, cap = 8192) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', d => { body += d; if (body.length > cap) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;

  if (url.pathname === '/api/state')  return json(res, buildState());
  if (url.pathname === '/api/mini')   return json(res, buildMini());

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-store',
      connection: 'keep-alive', 'x-accel-buffering': 'no'
    });
    res._mini = q.get('mini') === '1';
    res.write(`data: ${JSON.stringify(res._mini ? buildMini() : buildState())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/sessions') {
    const now = Date.now();
    const spans = {
      today: startOfDay(), week: now - 7 * 864e5, month: startOfMonth(),
      d30: now - 30 * 864e5, all: 0
    };
    const from = spans[q.get('span')] !== undefined ? spans[q.get('span')] : 0;
    return json(res, listSessions({
      from,
      q: q.get('q') || '',
      sort: q.get('sort') || 'cost',
      limit: Math.min(1000, Number(q.get('limit')) || 400)
    }));
  }

  if (url.pathname === '/api/session') {
    const s = sessions.get(q.get('id'));
    if (!s) return json(res, { error: 'no such session' }, 404);
    return json(res, sessionDetail(s));
  }

  if (url.pathname === '/api/series') {
    const days = Math.min(400, Math.max(1, Number(q.get('days')) || 60));
    return json(res, {
      daily: dailySeries(days),
      hours: hourHistogram(Date.now() - days * 864e5),
      byModel:   breakdown(Date.now() - days * 864e5, 'm', 20),
      byProject: breakdown(Date.now() - days * 864e5, 'p', 20),
      total: sumRange(Date.now() - days * 864e5)
    });
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    const j = await readBody(req);
    if (!j) return json(res, { error: 'bad json' }, 400);
    if (typeof j.planName === 'string' && j.planName.trim()) CONFIG.planName = j.planName.trim().slice(0, 40);
    if (isFinite(Number(j.monthlyUsd)) && Number(j.monthlyUsd) >= 0) CONFIG.monthlyUsd = Number(j.monthlyUsd);
    if (isFinite(Number(j.miniScale))) CONFIG.miniScale = Math.min(2.5, Math.max(0.6, Number(j.miniScale)));
    if (typeof j.miniMetric === 'string') CONFIG.miniMetric = j.miniMetric.slice(0, 20);
    if (typeof j.miniSkin === 'string') CONFIG.miniSkin = j.miniSkin.slice(0, 20);
    if (j.miniLayout === 'single' || j.miniLayout === 'cluster') CONFIG.miniLayout = j.miniLayout;
    if (j.miniRect && typeof j.miniRect === 'object') {
      const n = (v, lo, hi) => Math.round(Math.min(hi, Math.max(lo, Number(v) || 0)));
      const w = n(j.miniRect.w, 160, 8000), h = n(j.miniRect.h, 80, 5000);
      if (w >= 160 && h >= 80) {
        CONFIG.miniRect = { x: n(j.miniRect.x, -20000, 20000), y: n(j.miniRect.y, -20000, 20000), w, h };
      }
    }
    if (Array.isArray(j.miniCluster)) {
      const ids = j.miniCluster.filter(x => typeof x === 'string' && x.length <= 20).slice(0, 8);
      if (ids.length >= 2) CONFIG.miniCluster = ids;
    }
    if (['retail', 'actual', 'deal', 'tokens', 'cache', 'weekmax'].includes(j.pricingMode))
      CONFIG.pricingMode = j.pricingMode;
    if (isFinite(Number(j.weekTokenGoal)))
      CONFIG.weekTokenGoal = Math.max(0, Math.round(Number(j.weekTokenGoal)));
    if (isFinite(Number(j.blockCoverageGoal)))
      CONFIG.blockCoverageGoal = Math.min(34, Math.max(0, Math.round(Number(j.blockCoverageGoal))));
    if (isFinite(Number(j.earlyResetToleranceSec)))
      CONFIG.earlyResetToleranceSec = Math.min(3600, Math.max(0, Math.round(Number(j.earlyResetToleranceSec))));
    if (isFinite(Number(j.resetGraceMinutes)))
      CONFIG.resetGraceMinutes = Math.min(720, Math.max(1, Math.round(Number(j.resetGraceMinutes))));
    if (typeof j.idleAlert === 'boolean') CONFIG.idleAlert = j.idleAlert;
    if (isFinite(Number(j.idleAfterMin)))
      CONFIG.idleAfterMin = Math.min(720, Math.max(5, Math.round(Number(j.idleAfterMin))));
    if (isFinite(Number(j.idleRepeatMin)))
      CONFIG.idleRepeatMin = Math.min(1440, Math.max(10, Math.round(Number(j.idleRepeatMin))));
    if (isFinite(Number(j.quietFromHour)))
      CONFIG.quietFromHour = Math.min(23, Math.max(0, Math.round(Number(j.quietFromHour))));
    if (isFinite(Number(j.quietToHour)))
      CONFIG.quietToHour = Math.min(23, Math.max(0, Math.round(Number(j.quietToHour))));
    if (isFinite(Number(j.renewalDay))) CONFIG.renewalDay = Math.min(28, Math.max(1, Math.round(Number(j.renewalDay))));
    if (typeof j.miniOnTop === 'boolean') CONFIG.miniOnTop = j.miniOnTop;
    if (isFinite(Number(j.needleWindowSec)) && Number(j.needleWindowSec) >= 30) CONFIG.needleWindowSec = Number(j.needleWindowSec);
    saveConfig(CONFIG);
    pushState();
    return json(res, { ok: true, config: { ...CONFIG } });
  }

  // Real OS window control for the floating gauge: always-on-top, resize,
  // corner-snap. Browsers can't do any of this to their own window, so the
  // page asks us and we drive it through desktop/window.ps1. Windows only.
  if ((url.pathname === '/api/ontop' || url.pathname === '/api/window') && req.method === 'POST') {
    const j = await readBody(req);
    if (!j) return json(res, { error: 'bad json' }, 400);
    if (process.platform !== 'win32') return json(res, { ok: false, reason: 'windows only' });
    const script = path.join(DESKTOP_D, 'window.ps1');
    if (!fs.existsSync(script)) return json(res, { ok: false, reason: 'helper missing' });

    let action = j.action;
    if (url.pathname === '/api/ontop') {
      action = j.on !== false ? 'top' : 'untop';
      CONFIG.miniOnTop = j.on !== false; saveConfig(CONFIG);
    }
    if (action === 'close') {
      winClose(j.which === 'party' ? 'party' : j.which === 'main' ? 'main' : 'mini');
      return json(res, { ok: true, action });
    }
    if (!['top', 'untop', 'size', 'corner', 'move', 'state'].includes(action))
      return json(res, { ok: false, reason: 'unknown action' }, 400);

    const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
                  '-Title', 'BurnMeter Gauge', '-Action', action];
    if (action === 'size') {
      const w = Math.round(Math.min(8000, Math.max(200, Number(j.width) || 380)));
      const h = Math.round(Math.min(5000, Math.max(80, Number(j.height) || 196)));
      argv.push('-Width', String(w), '-Height', String(h));
      CONFIG.miniScale = w / 380; saveConfig(CONFIG);
    }
    if (action === 'corner') argv.push('-Corner', ['TL', 'TR', 'BL', 'BR'].includes(j.corner) ? j.corner : 'BR');
    if (action === 'move') {
      const x = Math.round(Math.min(20000, Math.max(-20000, Number(j.x) || 0)));
      const y = Math.round(Math.min(20000, Math.max(-20000, Number(j.y) || 0)));
      argv.push('-X', String(x), '-Y', String(y));
    }

    execFile('powershell.exe', argv, { timeout: 10000, windowsHide: true }, (err, stdout) => {
      const out = String(stdout || '').trim();
      if (err && !out) return json(res, { ok: false, reason: err.message });
      json(res, { ok: /^(ok|state)/i.test(out), action, detail: out });
    });
    return;
  }

  // Open a second standalone OS window (dashboard or gauge).
  if (url.pathname === '/api/open' && req.method === 'POST') {
    const j = await readBody(req);
    if (!j) return json(res, { error: 'bad json' }, 400);
    const which = j.which === 'mini' ? 'mini' : 'main';
    // Already open? Bring it forward. Chromium will not hand us a second
    // window for a profile it is already running, so spawning would no-op.
    if (!j.force && await raiseWindow(which)) return json(res, { ok: true, raised: true });
    const ok = openWindow(which, j);
    return json(res, { ok });
  }

  if (url.pathname === '/api/calibrate' && req.method === 'POST') {
    const j = await readBody(req);
    if (!j) return json(res, { error: 'bad json' }, 400);
    if (j.clear) {
      CONFIG.calibration = null; saveConfig(CONFIG); selfCache.at = 0;
      return json(res, { ok: true, calibration: null });
    }
    const which = j.which === 'week' ? 'week' : 'fiveHour';
    const allowance = calibrate(which, Number(j.pct));
    if (allowance == null) return json(res, { ok: false, reason: 'need a percentage above 0, and some usage in the window' });
    pushState();
    return json(res, { ok: true, which, allowance, calibration: CONFIG.calibration });
  }

  if (url.pathname === '/api/update') {
    if (req.method === 'POST') {
      const j = await readBody(req);
      if (!j) return json(res, { error: 'bad json' }, 400);
      if (updating) return json(res, { ok: false, reason: 'already updating' });
      updating = true;
      const lines = [];
      const r = await updater.apply({ force: !!j.force, log: m => lines.push(m) });
      updating = false;
      if (r.ok && r.updated) {
        json(res, Object.assign({}, r, { log: lines, restarting: true }));
        console.log(`[burnmeter] updated ${r.from} -> ${r.to}, restarting`);
        setTimeout(relaunch, 400);
        return;
      }
      return json(res, Object.assign({}, r, { log: lines }));
    }
    if (url.searchParams.get('refresh') === '1') return json(res, await checkForUpdate(true));
    return json(res, updateState);
  }

  if (url.pathname === '/api/limits') {
    const all = lockouts();
    const now = Date.now();
    const days = Math.min(400, Math.max(1, Number(q.get('days')) || 90));
    const from = now - days * 864e5;
    const win = all.filter(l => l.t >= from);
    const blockedMs = win.reduce((n, l) => n + Math.min(l.waitedMs || 0, 6 * 3600e3), 0);
    // What does an hour just after a reset look like next to a normal hour?
    let afterReset = 0, afterResetHours = 0;
    for (const l of win) {
      if (!l.recoveredAt) continue;
      afterReset += sumRange(l.recoveredAt, l.recoveredAt + 36e5).cost;
      afterResetHours++;
    }
    const total = sumRange(from);
    const spanHours = Math.max(1, (now - Math.max(from, events.length ? events[0].t : from)) / 36e5);
    return json(res, {
      now, days,
      state: blockState(),
      lockouts: win.slice(-100).reverse(),
      totals: {
        count: win.length,
        blockedMs,
        early: win.filter(l => l.early).length,
        byKind: win.reduce((a, l) => { a[l.kind] = (a[l.kind] || 0) + 1; return a; }, {}),
        avgWaitMs: win.length ? blockedMs / win.length : 0,
        afterResetPerHour: afterResetHours ? afterReset / afterResetHours : null,
        typicalPerHour: total.cost / spanHours
      }
    });
  }

  if (url.pathname === '/api/alerts') {
    if (req.method === 'POST') {
      const j = await readBody(req);
      if (!j) return json(res, { error: 'bad json' }, 400);
      if (j.test) {
        notify('BurnMeter test alert', 'This is what a limit-reset alert looks like.',
               { party: j.party !== false });
        return json(res, { ok: true, sent: true });
      }
      if (typeof j.alertOnReset === 'boolean') CONFIG.alertOnReset = j.alertOnReset;
      if (typeof j.alertSound === 'boolean') CONFIG.alertSound = j.alertSound;
      if (typeof j.partyOnReset === 'boolean') CONFIG.partyOnReset = j.partyOnReset;
      if (isFinite(Number(j.partySeconds))) CONFIG.partySeconds = Math.min(120, Math.max(3, Math.round(Number(j.partySeconds))));
      saveConfig(CONFIG);
      return json(res, { ok: true, alertOnReset: CONFIG.alertOnReset, alertSound: CONFIG.alertSound,
                         partyOnReset: CONFIG.partyOnReset, partySeconds: CONFIG.partySeconds });
    }
    return json(res, { alertOnReset: CONFIG.alertOnReset, alertSound: CONFIG.alertSound,
                       partyOnReset: CONFIG.partyOnReset, partySeconds: CONFIG.partySeconds,
                       mediaDir: PARTY_D, media: partyMedia(),
                       recent: alertLog.slice(-15).reverse() });
  }

  /*
   * Every week you have on record, so a strategy can be checked against
   * history rather than argued about. Coverage is the interesting column:
   * a week has 33.6 five-hour blocks in it, and the ones you sleep through
   * are capacity that expires whether or not you ever hit a limit.
   */
  if (url.pathname === '/api/weeks') {
    const BLOCK = 5 * 36e5, WEEK = 7 * 864e5;
    if (!events.length) return json(res, { weeks: [] });
    const first = startOfDay(new Date(events[0].t));
    const now = Date.now();
    const buckets = new Map();
    const key = t => Math.floor((t - first) / WEEK);
    for (const e of events) {
      const k = key(e.t);
      let b = buckets.get(k);
      if (!b) buckets.set(k, b = { k, tokens: 0, cost: 0, requests: 0, blocks: new Set(), hours: new Set() });
      b.tokens += e.i + e.o + e.r + e.w;
      b.cost += e.c;
      b.requests++;
      b.blocks.add(Math.floor(e.t / BLOCK));
      b.hours.add(Math.floor(e.t / 36e5));
    }
    const lk = lockouts();
    const weeks = [...buckets.values()].sort((a, b) => a.k - b.k).map(b => {
      const start = first + b.k * WEEK, end = start + WEEK;
      const hits = lk.filter(l => l.lastAt >= start && l.lastAt < end);
      return {
        start, end, partial: end > now,
        tokens: b.tokens, cost: b.cost, requests: b.requests,
        blocksUsed: b.blocks.size, blocksPossible: Math.round(WEEK / BLOCK),
        activeHours: b.hours.size,
        lockouts: hits.length, early: hits.filter(l => l.early).length
      };
    });
    return json(res, { weeks });
  }

  if (url.pathname === '/api/health') {
    return json(res, { ok: true, events: events.length, sessions: sessions.size, scanning });
  }

  // static
  // Party media: matched against the actual directory listing rather than
  // resolved as a path, so nothing outside the folder is reachable however
  // the name is spelled.
  if (url.pathname.startsWith('/party-media/')) {
    const want = decodeURIComponent(url.pathname.slice('/party-media/'.length));
    const hit = partyMedia().find(f => f === want);
    if (!hit) { res.writeHead(404); return res.end('not found'); }
    const media = path.join(PARTY_D, hit);
    let st;
    try { st = fs.statSync(media); } catch { res.writeHead(404); return res.end('not found'); }
    const ctype = MIME[path.extname(hit).toLowerCase()] || 'application/octet-stream';

    // A <video> will not play from a chunked response with no length: it wants
    // a byte range and a total size before it will even report a duration.
    // Images never cared, which is why this went unnoticed until the first mp4.
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end   = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (!isFinite(start) || !isFinite(end) || start > end || end >= st.size) {
        res.writeHead(416, { 'content-range': 'bytes */' + st.size });
        return res.end();
      }
      res.writeHead(206, {
        'content-type': ctype,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${st.size}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store'
      });
      return fs.createReadStream(media, { start, end }).pipe(res);
    }
    res.writeHead(200, {
      'content-type': ctype,
      'content-length': st.size,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store'
    });
    return fs.createReadStream(media).pipe(res);
  }

  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  if (rel === '/mini') rel = '/mini.html';
  if (rel === '/party') rel = '/party.html';
  const file = path.join(PUBLIC_D, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_D)) { res.writeHead(403); return res.end('nope'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(data);
  });
});

// ------------------------------------------------------- window opening ----

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

function findBrowser() {
  for (const b of BROWSERS) if (fs.existsSync(b)) return b;
  return null;
}

/** Fire-and-forget call into desktop/window.ps1. Windows only; never throws. */
function winHelper(extraArgs) {
  if (process.platform !== 'win32') return;
  const script = path.join(DESKTOP_D, 'window.ps1');
  if (!fs.existsSync(script)) return;
  try {
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Title', 'BurnMeter Gauge', ...extraArgs],
      { timeout: 10000, windowsHide: true }, () => {});
  } catch {}
}

const WINDOW_TITLE = { mini: 'BurnMeter Gauge', main: 'BurnMeter', party: 'BurnMeter Party' };

const PARTY_EXT = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.svg',
                           '.mp4', '.webm']);

/** Whatever the user has dropped in party-media, newest first. */
function partyMedia() {
  try {
    return fs.readdirSync(PARTY_D)
      .filter(f => PARTY_EXT.has(path.extname(f).toLowerCase()))
      .filter(f => { try { return fs.statSync(path.join(PARTY_D, f)).isFile(); } catch { return false; } });
  } catch { return []; }
}

/** Bring an already-open window to the front. Resolves false if there isn't one. */
function raiseWindow(which) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(false);
    const script = path.join(DESKTOP_D, 'window.ps1');
    if (!fs.existsSync(script)) return resolve(false);
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
       '-Title', WINDOW_TITLE[which] || 'BurnMeter', '-Exact', '-Action', 'raise'],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => resolve(!err && /^ok/i.test(String(stdout).trim())));
  });
}

/** Launch a chromeless app window — a real, movable, minimizable OS window. */
function openWindow(which, opts = {}) {
  const base = `http://${CONFIG.host}:${CONFIG.port}`;
  const url  = which === 'mini'  ? `${base}/mini`
             : which === 'party' ? `${base}/party${opts.query || ''}`
             : base;
  const miniDefault = (CONFIG.miniLayout === 'cluster') ? '620,380' : '380,230';
  const rect = which === 'mini' ? CONFIG.miniRect : null;
  const size = which === 'mini'
    ? (opts.size || (rect ? `${rect.w},${rect.h}` : miniDefault))
    : which === 'party' ? (opts.size || '860,580')
    : (opts.size || '1380,940');

  if (process.platform === 'win32') {
    const exe = findBrowser();
    if (exe) {
      // A profile per window. Chromium forwards a second launch to whichever
      // process already owns the profile - it prints "Opening in existing
      // browser session" and no new window appears - so the gauge and the
      // dashboard sharing one profile meant that whichever opened second
      // silently never opened at all.
      const profile = path.join(APP_DIR, 'browser-profile' + (which === 'mini' ? '' : '-' + which));
      const args = [
        `--app=${url}`,
        `--window-size=${size}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,MediaRouter'
      ];
      // The party makes a noise on its own; without this Chromium's autoplay
      // policy silences a window nobody has clicked in.
      if (which === 'party') args.push('--autoplay-policy=no-user-gesture-required');
      const pos = opts.pos || (rect ? `${rect.x},${rect.y}` : null);
      if (pos) args.push(`--window-position=${pos}`);
      try {
        const child = require('child_process').spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
        // The gauge is an overlay, so park it out of the way once the window
        // exists, and restore the pin if it was left on. Best-effort: if the
        // helper isn't there the window simply opens where the browser put it.
        // With no remembered position, park it bottom-right rather than
        // wherever the browser chose. Always-on-top and the saved rect are
        // handled by the page itself, which cannot fire before its own window
        // exists - unlike a timer here.
        if (which === 'mini' && !rect) {
          setTimeout(() => winHelper(['-Action', 'corner', '-Corner', 'BR']), 2600);
        }
        return true;
      } catch (e) { console.error('[burnmeter] could not open window:', e.message); }
    }
  }
  // Fall back to the default browser.
  try {
    const cmd = process.platform === 'win32' ? 'cmd'
              : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    require('child_process').spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

// ----------------------------------------------------------------- boot ----

function boot() {
  try { fs.mkdirSync(PARTY_D, { recursive: true }); } catch {}
  loadPricing();
  const t0 = Date.now();
  process.stdout.write('[burnmeter] reading transcripts... ');
  const n = scan(true);
  scanning = false;
  bootMs = Date.now() - t0;
  const subFiles = listTranscripts().filter(t => t.sub).length;
  console.log(`${n} API responses across ${filesTracked} transcripts (${subFiles} subagent logs), ${sessions.size} sessions, in ${bootMs}ms`);

  if (!events.length) {
    console.log('[burnmeter] no usage found. Check CLAUDE_CONFIG_DIR / ~/.claude/projects exists.');
  } else {
    const all = sumRange(0), month = sumRange(startOfMonth());
    console.log(`[burnmeter] all-time API value $${all.cost.toFixed(2)} · this month $${month.cost.toFixed(2)} of $${CONFIG.monthlyUsd}`);
  }

  // Stat-ing every transcript every 1.2s costs ~3% of a core for nothing while
  // idle, and the tree only grows. Watch it instead: rescan when something
  // changes (coalesced, at most ~1.4/s), with a slow safety poll. If recursive
  // watching is unavailable on this platform, fall back to the old poll.
  let scanTimer = null, lastScanAt = 0;
  const requestScan = () => {
    if (scanTimer) return;
    const wait = Math.max(0, 700 - (Date.now() - lastScanAt));
    scanTimer = setTimeout(() => {
      scanTimer = null; lastScanAt = Date.now();
      if (scan()) { pushState(); checkAlerts(); }
      checkIdle();                       // idle is a non-event, so it ticks regardless
    }, wait);
  };
  let watching = false;
  try {
    const w = fs.watch(PROJECTS, { recursive: true, persistent: false }, () => requestScan());
    w.on('error', e => {
      console.log('[burnmeter] transcript watcher failed (' + e.message + '); polling instead');
      try { w.close(); } catch {}
      setInterval(() => { if (scan()) pushState(); }, CONFIG.pollMs);
    });
    watching = true;
  } catch (e) {
    console.log('[burnmeter] fs.watch unavailable (' + e.message + '); polling instead');
  }
  setInterval(() => { if (scan()) pushState(); }, watching ? 5000 : CONFIG.pollMs);

  // Leave a crumb the statusline can read without talking to the server.
  const writeWorthCache = () => {
    try {
      fs.writeFileSync(path.join(APP_DIR, 'worth-cache.json'), JSON.stringify({
        at: Date.now(),
        spent: sumRange(startOfMonth()).cost,
        fee: CONFIG.monthlyUsd,
        rate: sumRange(Date.now() - CONFIG.needleWindowSec * 1000).cost / (CONFIG.needleWindowSec / 3600)
      }));
    } catch {}
  };
  writeWorthCache();
  setInterval(writeWorthCache, 20000);
  setInterval(pushState, 1000);              // keep clocks and rates live
  setInterval(checkAlerts, 15000);           // limit hit / reset / recovery
  setTimeout(checkAlerts, 5000).unref?.();

  // Look for a new version shortly after boot, then a few times a day. Failure
  // is silent by design — being offline is not something to nag about.
  setTimeout(() => checkForUpdate(), 20000).unref?.();
  setInterval(() => checkForUpdate(true), 6 * 3600e3).unref?.();

  if (CONFIG.lookbackDays > 0) {
    setInterval(() => {                      // trim memory
      const cutoff = Date.now() - CONFIG.lookbackDays * 864e5;
      let drop = 0; while (drop < events.length && events[drop].t < cutoff) drop++;
      if (drop > 0) events.splice(0, drop);
    }, 60 * 60e3);
  }

  server.listen(CONFIG.port, CONFIG.host, () => {
    const url = `http://${CONFIG.host}:${CONFIG.port}`;
    console.log(`[burnmeter] v${VERSION} · ${CONFIG.planName} @ $${CONFIG.monthlyUsd}/mo  →  ${url}`);
    if (process.argv.includes('--open'))      openWindow('main');
    if (process.argv.includes('--open-mini')) openWindow('mini');
  });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      // Already running. Hand the --open switches to the live instance rather
      // than spawning the window ourselves: it knows the current layout, and
      // its corner-park timer survives - ours would die with this process,
      // which is why shortcut-launched gauges used to land at the top-left.
      console.error(`[burnmeter] port ${CONFIG.port} is busy — it's probably already running.`);
      const wants = process.argv.includes('--open') ? 'main'
                  : process.argv.includes('--open-mini') ? 'mini' : null;
      if (!wants) return process.exit(0);
      const body = JSON.stringify({ which: wants });
      const req = http.request({ host: CONFIG.host, port: CONFIG.port, path: '/api/open', method: 'POST',
                                 headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
                                 timeout: 3000 },
        res => { res.resume(); res.on('end', () => process.exit(0)); });
      req.on('error', () => { openWindow(wants); setTimeout(() => process.exit(0), 3500); });
      req.on('timeout', () => { req.destroy(); openWindow(wants); setTimeout(() => process.exit(0), 3500); });
      req.end();
      return;
    }
    throw e;
  });
}

if (require.main === module) boot();
module.exports = { VERSION, checkForUpdate, priceUsage, priceFor, buildState, buildMini, scan, events, sessions, loadPricing, listTranscripts };
