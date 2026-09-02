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
// statusline.js drops the real subscription rate-limit numbers here.
const LIMITS_F   = path.join(APP_DIR, 'limits.json');

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
  miniOnTop: false,
  // Set by POST /api/calibrate. { fiveHourAllowance, weekAllowance, ...At }
  calibration: null
};

const NUMERIC_KEYS = new Set(['monthlyUsd', 'port', 'lookbackDays', 'needleWindowSec', 'pollMs', 'miniScale']);

function loadConfig() {
  let c = { ...DEFAULT_CONFIG };
  try { Object.assign(c, JSON.parse(fs.readFileSync(CONFIG_F, 'utf8'))); }
  catch { saveConfig(c); }
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
function readLimits() {
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
      sessionId:     j.session_id || null,
      stale:         (Date.now() / 1000 - (num(j.updated_at) || 0)) > 900
    };
  } catch {
    return { fiveHourPct: null, weekPct: null, updatedAt: 0, stale: true };
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

/** Daily totals for the current calendar month. */
function dailyThisMonth() {
  const from = startOfMonth();
  const days = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const out = new Array(days).fill(0);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.t < from) break;
    out[new Date(e.t).getDate() - 1] += e.c;
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
function hourlyBuckets() {
  if (!events.length) return [];
  const from = Math.floor(events[0].t / 36e5) * 36e5;
  const n = Math.ceil((Date.now() - from) / 36e5) + 1;
  const arr = new Float64Array(Math.max(1, n));
  for (const e of events) {
    const i = Math.floor((e.t - from) / 36e5);
    if (i >= 0 && i < arr.length) arr[i] += e.c;
  }
  return arr;
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
  const month  = sumRange(startOfMonth());
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

  // --- money's worth --------------------------------------------------------
  const fee = Math.max(0.01, Number(CONFIG.monthlyUsd) || 0);
  const monthStart = startOfMonth(), monthEnd = endOfMonth();
  const elapsed  = Math.max(1, now - monthStart);
  const fraction = elapsed / (monthEnd - monthStart);
  const projected = month.cost / fraction;
  const multiple  = month.cost / fee;
  const breakEvenAt = month.cost > 0 ? monthStart + (fee / month.cost) * elapsed : null;
  const perDayNeeded = fee / ((monthEnd - monthStart) / 864e5);
  const perDayActual = month.cost / (elapsed / 864e5);

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

    windows: { today, hour24, block, week7, month, all, blockResetsIn, weekResetsIn },

    worth: {
      fee, spent: month.cost, multiple, projected,
      projectedMultiple: projected / fee,
      monthFraction: fraction,
      breakEvenAt, brokeEven: month.cost >= fee,
      perDayNeeded, perDayActual,
      daysLeft: (monthEnd - now) / 864e5,
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

    live,
    active,
    activeCount: active.length,
    activeCost: active.reduce((n, a) => n + a.windowCost, 0),
    spark:  sparkline(24, 48),
    daily:  dailyThisMonth(),
    byModel:   breakdown(startOfMonth(), 'm'),
    byProject: breakdown(startOfMonth(), 'p'),
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
  const month = sumRange(startOfMonth());
  const fee = Math.max(0.01, Number(CONFIG.monthlyUsd) || 0);
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
    rate: sumRange(now - nw).cost / (nw / 36e5),
    burst: sumRange(now - 60e3).cost * 60,
    today: today.cost,
    month: month.cost,
    allTime: sumRange(0).cost,
    spark,
    multiple: month.cost / fee,
    fee,
    planName: CONFIG.planName,
    tokensLastMin: (() => { let t = 0; for (let i = events.length - 1; i >= 0; i--) { const e = events[i]; if (e.t < now - 60e3) break; t += e.b; } return t; })(),
    fiveHourPct: limits.fiveHourPct,
    weekPct: limits.weekPct,
    contextPct: limits.contextPct,
    self: selfLimits(),
    blockResetsIn,
    stale: limits.stale,
    live,
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
    onTop: !!CONFIG.miniOnTop
  };
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
               '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

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
    if (!['top', 'untop', 'size', 'corner', 'state'].includes(action))
      return json(res, { ok: false, reason: 'unknown action' }, 400);

    const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
                  '-Title', 'BurnMeter Gauge', '-Action', action];
    if (action === 'size') {
      const w = Math.round(Math.min(1200, Math.max(200, Number(j.width) || 380)));
      const h = Math.round(Math.min(900, Math.max(80, Number(j.height) || 196)));
      argv.push('-Width', String(w), '-Height', String(h));
      CONFIG.miniScale = w / 380; saveConfig(CONFIG);
    }
    if (action === 'corner') argv.push('-Corner', ['TL', 'TR', 'BL', 'BR'].includes(j.corner) ? j.corner : 'BR');

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

  if (url.pathname === '/api/health') {
    return json(res, { ok: true, events: events.length, sessions: sessions.size, scanning });
  }

  // static
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  if (rel === '/mini') rel = '/mini.html';
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

/** Launch a chromeless app window — a real, movable, minimizable OS window. */
function openWindow(which, opts = {}) {
  const base = `http://${CONFIG.host}:${CONFIG.port}`;
  const url  = which === 'mini' ? `${base}/mini` : base;
  const size = which === 'mini' ? (opts.size || '380,230') : (opts.size || '1380,940');

  if (process.platform === 'win32') {
    const exe = findBrowser();
    if (exe) {
      const profile = path.join(APP_DIR, 'browser-profile');
      const args = [
        `--app=${url}`,
        `--window-size=${size}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,MediaRouter'
      ];
      if (opts.pos) args.push(`--window-position=${opts.pos}`);
      try {
        const child = require('child_process').spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
        // The gauge is an overlay, so park it out of the way once the window
        // exists, and restore the pin if it was left on. Best-effort: if the
        // helper isn't there the window simply opens where the browser put it.
        if (which === 'mini') {
          setTimeout(() => {
            winHelper(['-Action', 'corner', '-Corner', 'BR']);
            if (CONFIG.miniOnTop) setTimeout(() => winHelper(['-Action', 'top']), 500);
          }, 2600);
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

  setInterval(() => { if (scan()) pushState(); }, CONFIG.pollMs);

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
      // Already running. Honour the --open switches against the live instance,
      // then step aside. The spawned window is detached, but give it a beat to
      // hand off before this process disappears.
      console.error(`[burnmeter] port ${CONFIG.port} is busy — it's probably already running.`);
      if (process.argv.includes('--open'))      openWindow('main');
      if (process.argv.includes('--open-mini')) openWindow('mini');
      setTimeout(() => process.exit(0), 400);
      return;
    }
    throw e;
  });
}

if (require.main === module) boot();
module.exports = { VERSION, checkForUpdate, priceUsage, priceFor, buildState, buildMini, scan, events, sessions, loadPricing, listTranscripts };
