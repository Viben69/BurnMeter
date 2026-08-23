#!/usr/bin/env node
/*
 * BurnMeter statusline hook.
 *
 * Claude Code pipes session JSON to this on stdin. Two jobs:
 *   1. Snapshot the REAL subscription rate-limit numbers to limits.json,
 *      which is the only place they're exposed. The dashboard reads that file.
 *   2. Print a compact one-line burn readout in the terminal.
 *
 * Wire it up in ~/.claude/settings.json:
 *   { "statusLine": { "type": "command",
 *                     "command": "node ~/.claude/burnmeter/statusline.js",
 *                     "refreshInterval": 10 } }
 */

'use strict';
const fs = require('fs');
const path = require('path');

const APP_DIR  = __dirname;
const LIMITS_F = path.join(APP_DIR, 'limits.json');
const CONFIG_F = path.join(APP_DIR, 'config.json');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  // Tracer: record that we were invoked at all, before any parsing can fail.
  // Distinguishes "the host never calls this hook" from "it calls us with
  // something we choke on". Capped so it can never grow without bound.
  try {
    const f = path.join(APP_DIR, 'statusline-trace.log');
    let prev = '';
    try { prev = fs.readFileSync(f, 'utf8'); } catch {}
    const NL = String.fromCharCode(10);
    const line = new Date().toISOString() + '  ' + raw.length + ' bytes  ' + raw.slice(0, 400) + NL;
    fs.writeFileSync(f, (prev + line).split(NL).slice(-50).join(NL));
  } catch {}
  try { run(JSON.parse(raw || '{}')); } catch { process.exit(0); }
});

const C = {
  dim:  s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  grn:  s => `\x1b[32m${s}\x1b[0m`,
  ylw:  s => `\x1b[33m${s}\x1b[0m`,
  red:  s => `\x1b[31m${s}\x1b[0m`,
  cyn:  s => `\x1b[36m${s}\x1b[0m`,
  mag:  s => `\x1b[35m${s}\x1b[0m`
};

function heat(pct) { return pct == null ? C.dim : pct >= 85 ? C.red : pct >= 60 ? C.ylw : C.grn; }

function bar(pct, width = 10) {
  if (pct == null) return C.dim('─'.repeat(width));
  const filled = Math.round(Math.min(100, Math.max(0, pct)) / 100 * width);
  return heat(pct)('█'.repeat(filled)) + C.dim('░'.repeat(width - filled));
}

function until(epochSec) {
  if (!epochSec) return '';
  let s = Math.max(0, epochSec - Math.floor(Date.now() / 1000));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600);  s %= 3600;
  const m = Math.floor(s / 60);
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${m}m`;
  return `${m}m`;
}

function run(j) {
  const rl  = j.rate_limits || {};
  const fh  = rl.five_hour  || {};
  const sd  = rl.seven_day  || {};
  const cw  = j.context_window || {};
  const cost = j.cost || {};

  // 1. Snapshot for the dashboard.
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.writeFileSync(LIMITS_F, JSON.stringify({
      updated_at:       Math.floor(Date.now() / 1000),
      five_hour_pct:    typeof fh.used_percentage === 'number' ? fh.used_percentage : null,
      five_hour_reset:  typeof fh.resets_at === 'number' ? fh.resets_at : null,
      seven_day_pct:    typeof sd.used_percentage === 'number' ? sd.used_percentage : null,
      seven_day_reset:  typeof sd.resets_at === 'number' ? sd.resets_at : null,
      model:            j.model && j.model.display_name || null,
      model_id:         j.model && j.model.id || null,
      context_pct:      typeof cw.used_percentage === 'number' ? cw.used_percentage : null,
      session_cost:     typeof cost.total_cost_usd === 'number' ? cost.total_cost_usd : null,
      session_id:       j.session_id || null,
      cwd:              j.workspace && j.workspace.current_dir || j.cwd || null
    }, null, 2));
  } catch { /* statusline must never break the terminal */ }

  // 2. Print the line.
  let plan = { planName: 'plan', monthlyUsd: 0, port: 4317 };
  try { Object.assign(plan, JSON.parse(fs.readFileSync(CONFIG_F, 'utf8'))); } catch {}

  const parts = [];
  const model = (j.model && j.model.display_name) || '?';
  parts.push(C.mag(model));

  const dir = (j.workspace && j.workspace.current_dir) || j.cwd || '';
  // basename of a drive root is empty — fall back to the path itself.
  if (dir) parts.push(C.dim('◗') + ' ' + (path.basename(dir.replace(/[\\/]+$/, '')) || dir));

  const ctx = typeof cw.used_percentage === 'number' ? Math.round(cw.used_percentage) : null;
  if (ctx != null) parts.push(heat(ctx)(`ctx ${ctx}%`));

  if (typeof fh.used_percentage === 'number') {
    parts.push(`${C.dim('5h')} ${bar(fh.used_percentage, 8)} ${heat(fh.used_percentage)(Math.round(fh.used_percentage) + '%')}${fh.resets_at ? C.dim(' ↻' + until(fh.resets_at)) : ''}`);
  }
  if (typeof sd.used_percentage === 'number') {
    parts.push(`${C.dim('wk')} ${bar(sd.used_percentage, 8)} ${heat(sd.used_percentage)(Math.round(sd.used_percentage) + '%')}${sd.resets_at ? C.dim(' ↻' + until(sd.resets_at)) : ''}`);
  }
  if (typeof cost.total_cost_usd === 'number' && cost.total_cost_usd > 0) {
    parts.push(C.cyn('$' + cost.total_cost_usd.toFixed(2)) + C.dim(' this session'));
  }

  process.stdout.write(parts.join(C.dim('  │  ')) + '\n');

  // Second line: month-to-date value vs. what the plan costs.
  const worth = monthWorth(plan);
  if (worth) process.stdout.write(worth + '\n');
}

/** Cheap read of the dashboard's own numbers if the daemon is running; else silent. */
function monthWorth(plan) {
  const cacheF = path.join(APP_DIR, 'worth-cache.json');
  try {
    const w = JSON.parse(fs.readFileSync(cacheF, 'utf8'));
    if (Date.now() - w.at > 5 * 60e3) return null;
    const mult = w.spent / Math.max(0.01, plan.monthlyUsd);
    const color = mult >= 1 ? C.grn : mult >= 0.6 ? C.ylw : C.red;
    return C.dim('month ') + color('$' + w.spent.toFixed(2)) +
           C.dim(` of API value on a $${plan.monthlyUsd} ${plan.planName} · `) +
           color(mult.toFixed(2) + '×') +
           (mult >= 1 ? C.dim(' — plan paid for itself') : C.dim(` — $${(plan.monthlyUsd - w.spent).toFixed(2)} to break even`));
  } catch { return null; }
}
