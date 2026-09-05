/* BurnMeter dashboard. No dependencies — plain DOM + inline SVG. */
'use strict';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ------------------------------------------------------------ formatting ---

/*
 * Three lenses on the same number.
 *
 * Every figure the server sends is RETAIL: what the usage would cost on
 * pay-as-you-go API rates. On a flat plan that is a counterfactual, not a bill.
 * What you actually paid is the fee, and RATE (fee / retail over the last 30
 * days) turns any retail figure into its real share of that fee.
 *
 *   retail   $155.59            the counterfactual
 *   actual   $9.80              your share of the fee
 *   deal     $155.59 -> $9.80   both, so the discount is visible
 *
 * money() / moneyC() take a retail figure and speak in the current mode.
 * usd() is for figures that are already real money (the fee itself) and must
 * never be converted.
 */
let MODE = 'retail';
let RATE = null;
let modePendingUntil = 0;

const usd = (v, dp = 2) =>
  '$' + (Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const usdC = v => {
  const n = Math.abs(Number(v) || 0);
  if (n === 0) return '$0';
  if (n >= 10000) return '$' + (n / 1000).toFixed(1) + 'k';
  if (n >= 100)   return '$' + n.toFixed(0);
  if (n >= 1)     return '$' + n.toFixed(2);
  return '$' + n.toFixed(n >= 0.01 ? 2 : 3);
};
const toActual = v => RATE == null ? null : (Number(v) || 0) * RATE;

function money(v, dp = 2) {
  const a = toActual(v);
  if (MODE === 'actual' && a != null) return usd(a, dp);
  if (MODE === 'deal'   && a != null) return `${usd(v, dp)} \u2192 ${usd(a, dp)}`;
  return usd(v, dp);
}
function moneyC(v) {
  const a = toActual(v);
  if (MODE === 'actual' && a != null) return usdC(a);
  if (MODE === 'deal'   && a != null) return `${usdC(v)}\u2192${usdC(a)}`;
  return usdC(v);
}
/** One value only, for axes and anything that cannot fit a pair. */
const money1 = v => (MODE === 'retail' || RATE == null) ? usdC(v) : usdC(toActual(v));

/** The words that go with a figure in this mode. */
const LENS = {
  retail: { noun: 'at API rates',         col: 'At API rates' },
  actual: { noun: 'of your fee',          col: 'Your cost' },
  deal:   { noun: 'retail \u2192 actual', col: 'Retail \u2192 actual' }
};
const lens = () => LENS[MODE] || LENS.retail;
const toks = v => {
  const n = Number(v) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(Math.round(n));
};
const dur = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
};
const ago = t => {
  const d = Date.now() - t;
  if (d < 60e3) return 'just now';
  if (d < 36e5) return Math.floor(d / 60e3) + 'm ago';
  if (d < 864e5) return Math.floor(d / 36e5) + 'h ago';
  const days = Math.floor(d / 864e5);
  if (days < 7) return days + 'd ago';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const clock = t => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const shortModel = m => String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');

const SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6'];
const seriesColor = i => `var(${SERIES[i % SERIES.length]})`;

function heat(pct) {
  if (pct == null) return 'var(--muted)';
  return pct >= 90 ? 'var(--crit)' : pct >= 75 ? 'var(--serious)'
       : pct >= 55 ? 'var(--warn)' : 'var(--good)';
}

// ----------------------------------------------------------------- theme ---

const THEME_KEY = 'burnmeter.theme';
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch {}
}
applyTheme((() => { try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch { return 'dark'; } })());
$('#btnTheme').onclick = () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

// ------------------------------------------------------------- tooltips ---

const tipEl = $('#tip');
function showTip(ev, html) {
  tipEl.innerHTML = html;
  tipEl.style.opacity = '1';
  const r = tipEl.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY - r.height - 10;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
  if (y < 8) y = ev.clientY + 18;
  tipEl.style.left = x + 'px';
  tipEl.style.top = y + 'px';
}
const hideTip = () => { tipEl.style.opacity = '0'; };
document.addEventListener('scroll', hideTip, true);

// -------------------------------------------------------------- svg help ---

const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const clear = n => { while (n.firstChild) n.removeChild(n.firstChild); };

// ================================================================== state ===

let STATE = null;
let ACTIVE = 'overview';
let sessionsCache = null;

// ============================================================ gauge (SVG) ===

const GMAX = 300;                                    // $/hr at full deflection
const gFrac = v => Math.min(1, Math.log10(1 + Math.max(0, v)) / Math.log10(1 + GMAX));
const GTICKS = [0, 1, 5, 10, 25, 50, 100, 300];

function drawGauge(rate) {
  const el = $('#gauge');
  clear(el);
  const cx = 160, cy = 162, r = 120;
  const pt = (f, rad = r) => {
    const a = Math.PI * (1 + Math.min(1, Math.max(0, f)));
    return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  };
  const arc = (f0, f1, rad, color, w, cap) => {
    const [x0, y0] = pt(f0, rad), [x1, y1] = pt(f1, rad);
    svg('path', {
      d: `M${x0.toFixed(2)} ${y0.toFixed(2)} A${rad} ${rad} 0 ${f1 - f0 > .5 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      fill: 'none', stroke: color, 'stroke-width': w, 'stroke-linecap': cap || 'butt'
    }, el);
  };

  // Track, banded by intensity so the colour itself carries meaning.
  const bands = [
    [0.00, gFrac(5),   'var(--good)'],
    [gFrac(5), gFrac(25),  'var(--warn)'],
    [gFrac(25), gFrac(80), 'var(--serious)'],
    [gFrac(80), 1.0,       'var(--crit)']
  ];
  arc(0, 1, r, 'var(--surface-3)', 16, 'round');
  for (const [a, b, c] of bands) {
    const g = svg('g', { opacity: .22 }, el);
    const [x0, y0] = pt(a), [x1, y1] = pt(b);
    svg('path', {
      d: `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      fill: 'none', stroke: c, 'stroke-width': 16
    }, g);
  }

  // Filled portion up to the current reading.
  const f = gFrac(rate);
  const cur = rate >= 80 ? 'var(--crit)' : rate >= 25 ? 'var(--serious)' : rate >= 5 ? 'var(--warn)' : 'var(--good)';
  if (f > 0.004) arc(0, f, r, cur, 16, 'round');

  // Ticks + labels.
  for (const t of GTICKS) {
    const tf = gFrac(t);
    const [ax, ay] = pt(tf, r - 12), [bx, by] = pt(tf, r - 21);
    svg('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: 'var(--baseline)', 'stroke-width': 1.5 }, el);
    const [lx, ly] = pt(tf, r - 36);
    const tx = svg('text', {
      x: lx, y: ly + 4, 'text-anchor': 'middle', class: 'axlab', fill: 'var(--muted)'
    }, el);
    tx.textContent = t === GTICKS[GTICKS.length - 1] ? t + '+' : t;
  }

  // Needle.
  const [nx, ny] = pt(f, r - 30);
  const [tx1, ty1] = pt(f + .5 > 1 ? f - .5 : f + .5, 13);
  svg('line', {
    x1: tx1, y1: ty1, x2: nx, y2: ny, stroke: 'var(--ink)', 'stroke-width': 3.5,
    'stroke-linecap': 'round', style: 'transition:all .55s cubic-bezier(.2,.7,.3,1)'
  }, el);
  svg('circle', { cx, cy, r: 9, fill: 'var(--surface-3)', stroke: 'var(--hair)' }, el);
  svg('circle', { cx, cy, r: 3.5, fill: cur }, el);
}

// ========================================================= overview render ==

function renderOverview(s) {
  renderInstances(s);

  // --- gauge ---
  // A click on the switch must win over the next second's server frame, or
  // the lens flickers back until the config write lands.
  if (Date.now() > modePendingUntil) MODE = s.mode || 'retail';
  RATE = s.exchange ? s.exchange.rate : null;
  syncModeSwitch();

  drawGauge(s.rate.perHour);
  $('#rateWindow').textContent = `${Math.round(s.rate.windowSec / 60)} min average`;
  const r = s.rate.perHour, ra = toActual(r);
  $('#rateBig').innerHTML = `${MODE === 'retail' || ra == null ? usd(r) : usd(ra)}<small>/hr</small>`;
  $('#rateNote').textContent = r <= 0.005
    ? 'Idle \u2014 nothing has hit the API in the last few minutes.'
    : MODE === 'actual' && ra != null
      ? `An hour at this pace uses ${usd(ra)} of your ${usd(s.exchange.fee, 0)} \u2014 ${(ra / s.exchange.fee * 100).toFixed(1)}% of the period.`
    : MODE === 'deal' && ra != null
      ? `An hour at this pace is ${usd(r)} at API rates, and ${usd(ra)} of your fee.`
      : `An hour at this pace would cost ${usd(r)} on pay-as-you-go API rates.`;
  $('#rateChips').innerHTML = [
    `<span class="chip">last minute <b>${moneyC(s.rate.instant)}/hr</b></span>`,
    `<span class="chip">last hour <b>${moneyC(s.rate.lastHour)}</b></span>`,
    `<span class="chip">today <b>${moneyC(s.windows.today.cost)}</b></span>`,
    s.live ? `<span class="chip">this session <b>${moneyC(s.live.cost)}</b></span>` : ''
  ].join('');

  renderHero(s);

  // --- limits ---
  const Lm = s.limits;
  const rows = [];
  rows.push(limitRow('fiveHour', '5-hour', Lm.fiveHourPct, Lm.fiveHourPace, s.windows.blockResetsIn,
    `${moneyC(s.windows.block.cost)} ${lens().noun} in this block`, Lm.self && Lm.self.fiveHour));
  rows.push(limitRow('week', 'Weekly', Lm.weekPct, Lm.weekPace, s.windows.weekResetsIn,
    `${moneyC(s.windows.week7.cost)} ${lens().noun} in the last 7 days`, Lm.self && Lm.self.week));
  if (Lm.contextPct != null) {
    rows.push(meter('Context window', Lm.contextPct, null, null,
      Lm.model ? `current session on ${Lm.model}` : 'current session'));
  }
  $('#limits').innerHTML = rows.join('');

  const anyReal = Lm.fiveHourPct != null;
  const calibrated = !!(Lm.calibration && (Lm.calibration.fiveHourAllowance || Lm.calibration.weekAllowance));
  $('#limitsTag').innerHTML = anyReal
    ? (Lm.stale ? '<span style="color:var(--muted)">last seen ' + ago(Lm.updatedAt * 1000) + '</span>' : 'live')
    : calibrated ? '<span style="color:var(--s1)">calibrated estimate</span>'
    : '<span style="color:var(--muted)">estimated from your history</span>';

  // --- windows ---
  const wn = s.windows, resp = w => `${w.requests.toLocaleString()} responses`;
  $('#windowsTag').textContent = lens().noun;
  $('#windows').innerHTML = [
    stat('Today', money(wn.today.cost), resp(wn.today)),
    stat('5-hour block', money(wn.block.cost), resp(wn.block)),
    stat('7 days', money(wn.week7.cost), resp(wn.week7)),
    stat('This period', money(wn.month.cost), resp(wn.month)),
    stat('30 days', money(wn.d30.cost), resp(wn.d30))
  ].join('');

  drawSpark(s.spark);
  drawDaily(s);

  // --- warnings / footer ---
  const warns = [];
  if (s.unknownModels.length)
    warns.push(`No price on file for <b>${s.unknownModels.map(esc).join(', ')}</b> — counted as $0.
                Add the rate to <code>pricing.json</code>.`);
  if (Lm.fiveHourPct == null && !calibrated)
    warns.push(`The 5-hour and weekly figures above are <b>estimates from your own history</b>, not
                Anthropic's allowance. The real percentages are only handed to the statusline hook,
                which runs in the terminal UI — not the desktop app. If you can see your true
                percentage anywhere, hit <b>set real %</b> on either meter: one number is enough for
                BurnMeter to work out the whole window and report real percentages from then on.`);
  $('#warn').innerHTML = warns.join('<br>');
  $('#warn').classList.toggle('hidden', !warns.length);

  renderUpdate(s);

  $('#footNote').innerHTML = MODE === 'actual'
    ? `Figures are <b>your share of the ${usd(s.exchange.fee, 0)} fee</b>, allocated by usage: each item's pay-as-you-go
       cost \u00d7 ${RATE != null ? (RATE * 100).toFixed(1) + '\u00a2' : '?'} per retail dollar, the rate from your last 30 days.`
    : MODE === 'deal'
    ? `Each figure is <b>pay-as-you-go API cost \u2192 your share of the fee</b>. The arrow is the discount the plan gives you.`
    : `Every dollar here is <b>what this usage would cost on pay-as-you-go API rates</b>. It is not a bill \u2014 on a
       subscription you pay the flat fee and nothing else. Switch to <i>Actual</i> to see your real share of it.`;
  $('#thValue').textContent = lens().col;
  $('#feedThValue').textContent = lens().col;
  $('#dailyLegend').textContent = MODE === 'actual' ? 'daily, your cost' : MODE === 'deal' ? 'daily, retail \u2192 actual' : 'daily, at API rates';
  $('#footStats').innerHTML =
    `BurnMeter v${esc(s.version || '?')} \u00b7 tracking <b>${s.eventsTracked.toLocaleString()}</b> API responses across
     <b>${s.sessionsTracked}</b> sessions and <b>${s.filesTracked}</b> transcripts,
     back to ${new Date(s.dataFrom).toLocaleDateString()}. Prices from <code>pricing.json</code>.`;
}

/*
 * The lockout banner. Sits above everything on every tab, because the one
 * thing worth interrupting you for is "capacity is back".
 */
function renderBlockBar(s) {
  const bar = $('#blockbar');
  const b = s.block;
  if (!b || !b.last) { bar.classList.add('hidden'); return; }
  const now = s.now;

  if (b.blocked) {
    bar.classList.remove('hidden', 'clear');
    const what = b.kind === 'model' ? `${esc(b.model)} limit` : `${esc(b.kind)} limit`;
    const due = b.resetsInMs;
    bar.innerHTML = due != null && due > 0
      ? `<span>Locked out — <b>${what}</b>.</span>
         <span class="big">${dur(due)}</span><span style="color:var(--ink-2)">until it says ${esc(b.resetText || '')}</span>`
      : due != null
        ? `<span><b>${what}</b> — the stated reset time has passed. Try again.</span>`
        : `<span>Locked out — <b>${what}</b>. No reset time given.</span>`;
    return;
  }

  // Just came back: say so briefly, and loudly if it was early.
  const back = b.last.recoveredAt;
  if (back && now - back < 20 * 60e3) {
    bar.classList.remove('hidden');
    bar.classList.add('clear');
    bar.innerHTML = b.last.early
      ? `<span><b>Capacity came back early</b> — ${dur(b.last.earlyByMs)} before it said. Extra room, use it.</span>`
      : `<span><b>Capacity is back.</b> You were out for ${dur(b.last.waitedMs || 0)}.</span>`;
    return;
  }
  bar.classList.add('hidden');
}

async function loadLimits() {
  const days = $('#lDays').value;
  const d = await (await fetch('/api/limits?days=' + days)).json();
  const a = await (await fetch('/api/alerts')).json().catch(() => ({}));
  if (document.activeElement !== $('#lAlert')) $('#lAlert').checked = !!a.alertOnReset;
  if (document.activeElement !== $('#lSound')) $('#lSound').checked = !!a.alertSound;
  if (document.activeElement !== $('#lParty')) $('#lParty').checked = !!a.partyOnReset;
  mediaInfo = { dir: a.mediaDir || '', media: a.media || [] };
  $('#lMedia').textContent = mediaInfo.media.length
    ? `Party image (${mediaInfo.media.length})` : 'Party image…';

  // --- current state ---
  const st = d.state;
  $('#lStateTag').textContent = st.blocked ? 'locked out' : 'clear';
  $('#lState').innerHTML = st.blocked
    ? `<div class="bignum" style="color:var(--crit)">${st.resetsInMs > 0 ? dur(st.resetsInMs) : 'now'}</div>
       <div class="sub2">until the ${esc(st.kind)} limit resets${st.resetText ? ' (' + esc(st.resetText) + ')' : ''}
       · blocked since ${new Date(st.since).toLocaleTimeString()}</div>`
    : st.last
      ? `<div class="bignum" style="color:var(--good)">Clear</div>
         <div class="sub2">last lockout ${ago(st.last.t)}${st.last.waitedMs ? ' · cost you ' + dur(st.last.waitedMs) : ''}</div>`
      : `<div class="bignum" style="color:var(--good)">Clear</div><div class="sub2">no lockouts on record</div>`;

  // --- totals ---
  const t = d.totals;
  const perWeek = t.count / Math.max(1, d.days / 7);
  $('#lTotals').innerHTML = [
    stat('Lockouts', t.count, `${perWeek.toFixed(1)} a week`),
    stat('Time lost', dur(t.blockedMs), 'waiting for a reset'),
    stat('Average wait', dur(t.avgWaitMs), 'per lockout'),
    stat('Early resets', t.early, t.early ? 'came back sooner than stated' : 'none seen yet')
  ].join('');

  // --- what a reset is worth ---
  const ar = t.afterResetPerHour, tp = t.typicalPerHour;
  $('#lAfter').innerHTML = [
    stat('First hour back', ar == null ? '—' : money(ar), 'value, hour after a reset'),
    stat('A typical hour', money(tp), 'across the whole window'),
    stat('Ratio', ar == null || !tp ? '—' : (ar / tp).toFixed(1) + '\u00d7', 'how hard you go once free')
  ].join('');
  $('#lAfterNote').innerHTML = ar == null || !tp ? ''
    : ar > tp
      ? `You work <b>${(ar / tp).toFixed(1)}\u00d7</b> harder in the hour after a reset than in an average hour.
         Every minute between the reset and you noticing is worth about <b>${money(ar / 60)}</b>.`
      : `The hour after a reset is no busier than any other — you are probably not catching them as they happen.`;

  // --- history ---
  const tb = $('#lTable tbody');
  $('#lCount').textContent = `${d.lockouts.length} in the last ${d.days} days`;
  $('#lEmpty').classList.toggle('hidden', d.lockouts.length > 0);
  tb.innerHTML = d.lockouts.map(l => {
    const outcome = l.early
      ? `<span style="color:var(--good)">early by ${dur(l.earlyByMs)}</span>`
      : !l.recoveredAt ? '<span style="color:var(--muted)">never resumed</span>'
      : l.resetAt ? 'on time' : 'resumed';
    return `<tr>
      <td>${new Date(l.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
      <td>${l.kind === 'model' ? esc(l.model) : esc(l.kind)}</td>
      <td class="n">${l.hits}</td>
      <td>${l.resetText ? esc(l.resetText) : '<span style="color:var(--muted)">not stated</span>'}</td>
      <td class="n">${l.waitedMs ? dur(l.waitedMs) : '—'}</td>
      <td>${outcome}</td>
    </tr>`;
  }).join('');
}

/* Update banner. The server only ever checks; installing is a click. */
function renderUpdate(s) {
  const bar = $('#updatebar');
  const u = s.update || {};
  if (!u.ok || !u.available) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.innerHTML = `
    <span>Version <b>${esc(u.latest)}</b> is available — you're on ${esc(u.current)}.</span>
    ${u.notes ? `<span class="notes">${esc(u.notes)}</span>` : ''}
    <span class="spacer"></span>
    <button class="primary" id="btnUpdate">Update &amp; restart</button>
    <button class="toggle" id="btnUpdateLater">Not now</button>`;
  $('#btnUpdateLater').onclick = () => bar.classList.add('hidden');
  $('#btnUpdate').onclick = async () => {
    const b = $('#btnUpdate');
    b.disabled = true; b.textContent = 'Updating…';
    const r = await fetch('/api/update', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    }).then(r => r.json()).catch(() => ({ ok: false, reason: 'server unreachable' }));
    if (!r.ok) {
      b.disabled = false; b.textContent = 'Update & restart';
      bar.innerHTML += `<div style="width:100%;color:var(--crit);margin-top:6px">
        Update failed: ${esc(r.reason || 'unknown')}</div>`;
      return;
    }
    if (!r.updated) { b.textContent = r.reason || 'already current'; return; }
    bar.innerHTML = `<span>Updated to <b>${esc(r.to)}</b> — ${r.files.length} file(s).
      Restarting…</span>`;
    // The server relaunches itself; the SSE stream reconnects on its own.
    setTimeout(() => location.reload(), 4000);
  };
}

/*
 * Every Claude Code window that has produced a response recently, and what each
 * one is costing. Derived from the transcripts, so it works without the
 * statusline hook - which is what made this invisible in the desktop app.
 */
function renderInstances(s) {
  const card = $('#instancesCard');
  const list = s.active || [];
  if (!list.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');

  const hot = list.filter(a => a.hot).length;
  $('#instancesTag').innerHTML =
    `${list.length} session${list.length > 1 ? 's' : ''} active` +
    (hot ? ` · <span style="color:var(--good)">${hot} mid-response</span>` : '') +
    ` · ${money(s.activeCost)} in the last 15 min`;

  $('#instances').innerHTML = list.map(a => `
    <div class="inst" data-sid="${esc(a.id)}" style="cursor:pointer">
      <span class="beat${a.hot ? ' hot' : ''}"></span>
      <div class="who">
        <div class="t">${esc(a.title)}</div>
        <div class="p">${esc(a.project)}${a.topModel ? ' · ' + esc(shortModel(a.topModel)) : ''}
          · ${a.hot ? 'now' : dur(a.idleMs) + ' idle'}</div>
      </div>
      <div class="fig"><div class="v">${moneyC(a.perHour)}</div><div class="k">per hour</div></div>
      <div class="fig opt"><div class="v">${moneyC(a.windowCost)}</div><div class="k">15 min</div></div>
      <div class="fig opt"><div class="v">${toks(a.windowTokens)}</div><div class="k">tokens</div></div>
      <div class="fig"><div class="v">${money(a.sessionCost)}</div><div class="k">session</div></div>
    </div>`).join('');

  $$('#instances .inst').forEach(el => {
    el.onclick = () => openSession(el.dataset.sid);
  });
}

/*
 * The hero card answers one question per mode.
 *   retail  what would this period have cost without the plan?
 *   actual  what am I paying, and where has it gone?
 *   deal    how good is the trade?
 */
function renderHero(s) {
  const w = s.worth, x = s.exchange, P = s.period;
  const fee = x.fee;
  const day = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  $('#worthTag').textContent = `${day(P.start)} \u2013 ${day(P.end - 1)}`;
  const fill = $('#worthFill'), mark = $('#worthMark');
  const brokeEvenTxt = w.breakEvenAt ? `paid for itself on <b>${day(w.breakEvenAt)}</b>` : null;

  if (MODE === 'actual') {
    $('#worthTitle').textContent = 'What you pay';
    $('#worthSpent').textContent = usd(fee, 0);
    $('#worthSub').textContent = 'flat, this period \u2014 whatever you use';
    const alloc = RATE != null ? P.retail * RATE : null;
    $('#worthMult').textContent = alloc != null ? usd(alloc) : '\u2014';
    $('#worthSub2').textContent = 'of it used so far, by usage';
    fill.style.width = Math.min(100, P.fraction * 100) + '%';
    fill.style.background = 'var(--s1)';
    mark.style.left = (alloc != null ? Math.min(100, alloc / fee * 100) : 0) + '%';
    $('#worthVerdict').innerHTML =
      `The clock has consumed <b>${usd(P.feeElapsed)}</b> of the fee \u2014 ${Math.round(P.fraction * 100)}% of the period.` +
      (alloc != null
        ? ` Measured by what you've actually done, this period's usage is worth <b>${usd(alloc)}</b> of the ${usd(fee, 0)}
           \u2014 that's <b>${usd(P.retail)}</b> of work at API rates, at ${(RATE * 100).toFixed(1)}\u00a2 per retail dollar.`
        : '');
    $('#worthStats').innerHTML = [
      stat('Per day', usd(w.perDayNeeded), `the fee, spread over ${Math.round(P.days)} days`),
      stat('Per active hour', x.perHourActual != null ? usd(x.perHourActual) : '\u2014', `${x.activeHours30.toFixed(0)}h active in 30 days`),
      stat('Per prompt', x.perPromptActual != null ? usd(x.perPromptActual) : '\u2014', `${x.prompts30.toLocaleString()} prompts in 30 days`),
      stat('Per Mtok', x.perMtokActual != null ? usd(x.perMtokActual) : '\u2014', `${toks(x.tokens30)} tokens in 30 days`)
    ].join('');
    return;
  }

  if (MODE === 'deal') {
    $('#worthTitle').textContent = 'The deal';
    const disc = x.discount;
    $('#worthSpent').textContent = disc == null ? '\u2014'
      : disc >= 0 ? `${(disc * 100).toFixed(0)}% off` : `${((-disc) * 100).toFixed(0)}% over`;
    $('#worthSub').textContent = 'vs pay-as-you-go, last 30 days';
    $('#worthMult').innerHTML = x.multiple30 > 0 ? x.multiple30.toFixed(1) + '&times;' : '\u2014';
    $('#worthSub2').textContent = 'what the fee buys';
    fill.style.width = (x.retail30 > 0 ? Math.min(100, fee / x.retail30 * 100) : 0) + '%';
    fill.style.background = disc >= .5 ? 'var(--s3)' : disc >= 0 ? 'var(--s4)' : 'var(--s2)';
    mark.style.left = '100%';
    $('#worthVerdict').innerHTML = RATE == null
      ? 'No usage in the last 30 days to compare against.'
      : disc >= 0
        ? `Over the last 30 days you got <b>${usd(x.retail30)}</b> of API-rate work for <b>${usd(fee, 0)}</b> \u2014
           <b>${(RATE * 100).toFixed(1)}\u00a2</b> per retail dollar. This period ${brokeEvenTxt || 'has not broken even yet'}.`
        : `Over the last 30 days you used <b>${usd(x.retail30)}</b> of API-rate work and paid <b>${usd(fee, 0)}</b> \u2014
           the plan is costing you <b>${(1 / RATE).toFixed(1)}\u00d7</b> what pay-as-you-go would.`;
    const pair = (a, b, dp = 2) => a == null || b == null ? '\u2014' : `${usd(a, dp)} \u2192 ${usd(b, dp)}`;
    $('#worthStats').innerHTML = [
      stat('Per active hour', pair(x.perHourRetail, x.perHourActual), 'retail \u2192 what you pay'),
      stat('Per prompt', pair(x.perPromptRetail, x.perPromptActual), `${x.prompts30.toLocaleString()} prompts`),
      stat('Per Mtok', pair(x.perMtokRetail, x.perMtokActual), `${toks(x.tokens30)} tokens`),
      stat('All time', `${usd(w.allTimeValue, 0)} \u2192 ${usd(w.allTimeFees, 0)}`, `${w.allTimeMultiple.toFixed(1)}\u00d7 over ${w.monthsTracked.toFixed(1)} mo`)
    ].join('');
    return;
  }

  // retail
  $('#worthTitle').textContent = 'Without the plan';
  $('#worthSpent').textContent = usd(P.retail);
  $('#worthSub').textContent = 'this period, at pay-as-you-go API rates';
  $('#worthMult').innerHTML = w.multiple.toFixed(2) + '&times;';
  $('#worthSub2').textContent = `the ${usd(fee, 0)} fee`;
  fill.style.width = Math.min(100, (P.retail / fee) * 100) + '%';
  fill.style.background = w.multiple >= 1 ? 'var(--s3)' : w.multiple >= .6 ? 'var(--s4)' : 'var(--s2)';
  mark.style.left = '100%';
  $('#worthVerdict').innerHTML = w.brokeEven
    ? `This period's usage would already cost <b>${usd(P.retail)}</b> on the API \u2014 the plan ${brokeEvenTxt}.
       At the 30-day pace it'll reach about <b>${usd(w.projected)}</b> (${w.projectedMultiple.toFixed(1)}\u00d7) by ${day(P.end - 1)}.`
    : `<b>${usd(fee - P.retail)}</b> more at API rates and the plan breaks even this period.
       At the 30-day pace it'll reach about <b>${usd(w.projected)}</b> (${w.projectedMultiple.toFixed(1)}\u00d7) by ${day(P.end - 1)}.`;
  $('#worthStats').innerHTML = [
    stat('Projected', usd(w.projected), `${w.projectedMultiple.toFixed(1)}\u00d7 by period end, from the 30-day pace`),
    stat('Per day', usd(w.perDayActual), `30-day average \u00b7 need ${usd(w.perDayNeeded)} to break even`),
    stat('Days left', Math.ceil(w.daysLeft), `${Math.round(P.fraction * 100)}% through the period`),
    stat('All time', usd(w.allTimeValue), `${w.allTimeMultiple.toFixed(1)}\u00d7 over ${w.monthsTracked.toFixed(1)} mo`)
  ].join('');
}

const stat = (k, v, s) =>
  `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s || ''}</div></div>`;

/*
 * The true percentages only exist inside a terminal session, via the statusline
 * hook. When they are absent we show a clearly-marked stand-in derived from the
 * user's own history, plus a one-shot calibration: type the real percentage in
 * once and every later reading becomes a real percentage.
 */
function limitRow(kind, name, realPct, pace, resetsIn, note, self) {
  if (realPct != null) return meter(name + ' limit', realPct, pace, resetsIn, note);
  if (!self) {
    return meter(name + ' limit', null, null, resetsIn,
      'no reading yet — needs a terminal session or a calibration below');
  }
  const pct = Math.min(999, self.pct);
  const c = heat(Math.min(100, pct));
  const label = self.real ? `${name} limit` : `${name} — vs your own busiest`;
  const sub = self.real
    ? `calibrated: ${moneyC(self.ref)} of API value is your full window`
    : `${moneyC(self.cur)} of ${moneyC(self.ref)} — your 90th-percentile ${name.toLowerCase()} window`;
  return `<div class="meter">
    <div class="mlab">
      <span class="mname">${label}${self.real ? '' : ' <span class="sub2">(estimate)</span>'}</span>
      <span class="mval" style="color:${c}">${Math.round(pct)}%</span>
    </div>
    <div class="mtrack"><div class="mfill" style="width:${Math.min(100, pct)}%;background:${c}"></div></div>
    <div class="mnote">${sub}
      <button class="toggle" data-calib="${kind}" style="margin-left:4px">set real %</button>
    </div>
  </div>`;
}

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-calib]');
  if (!b) return;
  const kind = b.dataset.calib;
  const which = kind === 'week' ? 'week' : 'fiveHour';
  const label = which === 'week' ? 'weekly' : '5-hour';
  const val = prompt(
    `What does Claude Code say your ${label} usage is right now, as a percentage?

` +
    `Enter the number it shows (e.g. 42). BurnMeter works out what your full ` +
    `window is worth from that, and every later reading becomes a real percentage.

` +
    `Leave blank and press OK to clear an existing calibration.`);
  if (val === null) return;
  if (val.trim() === '') {
    await fetch('/api/calibrate', { method: 'POST', headers: { 'content-type': 'application/json' },
                                    body: JSON.stringify({ clear: true }) });
    return;
  }
  const r = await fetch('/api/calibrate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ which, pct: Number(val) })
  }).then(r => r.json()).catch(() => ({ ok: false, reason: 'server unreachable' }));
  if (!r.ok) alert('Could not calibrate: ' + (r.reason || 'unknown'));
});

function meter(name, pct, pace, resetsIn, note) {
  const has = pct != null;
  const val = has ? Math.round(pct) + '%' : '—';
  const c = heat(pct);
  let paceTxt = '';
  if (pace != null) {
    paceTxt = pace >= 1.05 ? `<span style="color:var(--serious)">${pace.toFixed(2)}× faster than the window allows</span>`
            : pace <= 0.9  ? `<span style="color:var(--good)">${Math.round(pace * 100)}% of pace — room to push</span>`
            : `on pace`;
  }
  const reset = resetsIn != null && resetsIn > 0 ? ` · resets in ${dur(resetsIn)}` : '';
  return `<div class="meter">
    <div class="mlab"><span class="mname">${name}</span><span class="mval" style="color:${c}">${val}</span></div>
    <div class="mtrack${has ? '' : ' plain'}">
      <div class="mfill" style="width:${has ? Math.min(100, pct) : 0}%;background:${c}"></div>
    </div>
    <div class="mnote">${note || ''}${paceTxt ? ' · ' + paceTxt : ''}${reset}</div>
  </div>`;
}

// -------------------------------------------------------------- 24h spark --

function drawSpark(data) {
  const el = $('#spark'); clear(el);
  const W = 620, H = 118, pad = 4;
  const max = Math.max(0.0001, ...data);
  const n = data.length;
  const bw = (W - pad * 2) / n;
  svg('line', { x1: 0, y1: H - 1, x2: W, y2: H - 1, class: 'baseline' }, el);
  data.forEach((v, i) => {
    const h = Math.max(v > 0 ? 2 : 0, (v / max) * (H - 16));
    const x = pad + i * bw;
    const fresh = i >= n - 2;
    const rect = svg('rect', {
      x: x + .5, y: H - 1 - h, width: Math.max(1, bw - 1.5), height: h,
      fill: fresh ? 'var(--s2)' : 'var(--s1)', opacity: fresh ? 1 : .55, rx: 1
    }, el);
    const mins = Math.round((n - i) * (24 * 60 / n));
    rect.addEventListener('mouseenter', e =>
      showTip(e, `<b>${money(v)}</b><br><span style="color:var(--muted)">${mins > 60 ? Math.round(mins / 60) + 'h' : mins + 'm'} ago · 30 min bucket</span>`));
    rect.addEventListener('mouseleave', hideTip);
  });
}

// ------------------------------------------------------------ daily chart --

function drawDaily(s) {
  const el = $('#daily'); clear(el);
  // One bar per day of the billing period. Days not reached yet are ghosted.
  const data = s.daily || [];
  const W = 940, H = 220, L = 52, R = 12, T = 12, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const needPerDay = s.worth.perDayNeeded;
  const max = Math.max(needPerDay * 1.25, ...data.map(x => x.cost), 0.01);
  const now = Date.now();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  let todayIdx = data.findIndex(x => x.d === midnight.getTime());
  if (todayIdx < 0) { const f = data.findIndex(x => x.d > now); todayIdx = f < 0 ? data.length - 1 : f - 1; }
  const y = v => T + ih - (v / max) * ih;
  const bw = iw / Math.max(1, data.length);

  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    svg('line', { x1: L, y1: yy, x2: W - R, y2: yy, class: i ? 'gridline' : 'baseline' }, el);
    const t = svg('text', { x: L - 8, y: yy + 3.5, 'text-anchor': 'end', class: 'axlab' }, el);
    t.textContent = money1(v);
  }

  data.forEach((x, i) => {
    const v = x.cost;
    const h = v > 0 ? Math.max(2, (v / max) * ih) : 0;
    const xx = L + i * bw;
    const isToday = i === todayIdx, future = x.d > now;
    const r = svg('rect', {
      x: xx + bw * .16, y: T + ih - h, width: bw * .68, height: h,
      fill: isToday ? 'var(--s2)' : 'var(--s1)', opacity: future ? .18 : 1, rx: 2
    }, el);
    const d = new Date(x.d);
    r.addEventListener('mouseenter', e => showTip(e,
      `<b>${money(v)}</b><br><span style="color:var(--muted)">${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}${isToday ? ' \u00b7 today' : ''}${x.requests ? ` \u00b7 ${x.requests.toLocaleString()} responses` : ''}</span>`));
    r.addEventListener('mouseleave', hideTip);
    if (i % 2 === 0 || data.length <= 16) {
      const t = svg('text', { x: xx + bw / 2, y: H - 8, 'text-anchor': 'middle', class: 'axlab' }, el);
      t.textContent = d.getDate();
    }
  });

  // Break-even pace line.
  const py = y(needPerDay);
  svg('line', {
    x1: L, y1: py, x2: W - R, y2: py, stroke: 'var(--baseline)',
    'stroke-width': 1.5, 'stroke-dasharray': '5 4'
  }, el);
  const lab = svg('text', { x: W - R - 4, y: py - 6, 'text-anchor': 'end', class: 'axlab', fill: 'var(--ink-2)' }, el);
  lab.textContent = MODE === 'actual' ? `the fee: ${usdC(needPerDay * (RATE || 1))}/day` : `break even ${usdC(needPerDay)}/day`;

  const past = data.filter(x => x.d <= now);
  const over = past.filter(x => x.cost >= needPerDay).length;
  $('#dailyTag').textContent = `${over} of ${past.length} days beat the break-even pace`;
}

// ================================================================ sessions ==

async function loadSessions(force) {
  const q = $('#sQuery').value.trim();
  const span = $('#sSpan').value;
  const sort = $('#sSort').value;
  const url = `/api/sessions?span=${span}&sort=${sort}&q=${encodeURIComponent(q)}&limit=400`;
  if (!force && sessionsCache && sessionsCache.url === url) return renderSessions(sessionsCache.data);
  const data = await (await fetch(url)).json();
  sessionsCache = { url, data };
  renderSessions(data);
}

function renderSessions(data) {
  const tb = $('#sTable tbody');
  tb.innerHTML = '';
  $('#sEmpty').classList.toggle('hidden', data.sessions.length > 0);
  const max = Math.max(0.01, ...data.sessions.map(s => s.cost));

  $('#sSummary').innerHTML =
    `<b>${data.total}</b> sessions \u00b7 <b>${money(data.grandCost)}</b> ${lens().noun}`;

  for (const s of data.sessions) {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.onclick = () => openSession(s.id);
    const perHr = s.perHour;
    const delegPct = s.cost > 0 ? (s.subCost / s.cost) * 100 : 0;
    tr.innerHTML = `
      <td class="trunc" style="max-width:300px">
        <div class="trunc" style="max-width:300px">${esc(s.title)}</div>
        <div class="sub2 trunc" style="max-width:300px">${esc(shortModel(s.topModel))} · ${s.requests.toLocaleString()} responses</div>
      </td>
      <td class="trunc" style="max-width:130px" title="${esc(s.cwd || '')}">${esc(s.project)}${s.branch ? `<div class="sub2">${esc(s.branch)}</div>` : ''}</td>
      <td>${ago(s.end)}<div class="sub2">${new Date(s.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div></td>
      <td class="n">${dur(s.activeMs)}${s.spanMs > s.activeMs * 1.6 ? `<div class="sub2">over ${dur(s.spanMs)}</div>` : ''}</td>
      <td class="n">${s.prompts || '—'}${s.costPerPrompt ? `<div class="sub2">${moneyC(s.costPerPrompt)} ea</div>` : ''}</td>
      <td class="n">${perHr ? moneyC(perHr) : '—'}</td>
      <td class="n">${s.subCost > 0 ? moneyC(s.subCost) + `<div class="sub2">${delegPct.toFixed(0)}%</div>` : '—'}</td>
      <td class="n">
        <div style="font-weight:640">${money(s.cost)}</div>
        <div class="minibar" style="background:var(--s1);width:${Math.max(3, (s.cost / max) * 100)}%;margin-left:auto;margin-top:4px"></div>
      </td>`;
    tb.appendChild(tr);
  }
}

// ---------------------------------------------------------- session drawer --

const drawer = $('#drawer');
drawer.addEventListener('click', e => { if (e.target === drawer) closeDrawer(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
function closeDrawer() { drawer.classList.remove('open'); }

async function openSession(id) {
  drawer.classList.add('open');
  $('#drawerPanel').innerHTML = '<div class="empty">Loading…</div>';
  const s = await (await fetch('/api/session?id=' + encodeURIComponent(id))).json();
  if (s.error) { $('#drawerPanel').innerHTML = '<div class="empty">Session not found.</div>'; return; }

  const perHr = s.perHour;
  const maxP = Math.max(0.0001, ...s.promptList.map(p => p.cost));
  const tokTotal = s.tok.in + s.tok.out + s.tok.read + s.tok.write;

  const prompts = s.promptList.length ? s.promptList.map((p, i) => `
    <div class="promptrow${p.cost >= maxP * .6 && maxP > 0.05 ? ' big' : ''}">
      <div style="display:flex;gap:12px;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <div class="ptext">${p.text ? esc(p.text) : '<i style="color:var(--muted)">(no prompt text recorded — tool loop or continuation)</i>'}</div>
          <div class="pmeta">
            <span>#${i + 1}</span>
            <span>${clock(p.t)}</span>
            <span>${dur(p.durationMs)}</span>
            <span>${p.requests} responses</span>
            ${p.subCost > 0 ? `<span style="color:var(--s5)">${moneyC(p.subCost)} delegated (${p.subRequests})</span>` : ''}
            <span>${toks(p.tok.in + p.tok.out + p.tok.read + p.tok.write)} tokens</span>
            ${p.tok.think ? `<span>${toks(p.tok.think)} thinking</span>` : ''}
            <span>${p.models.map(m => esc(shortModel(m.name))).join(', ')}</span>
          </div>
        </div>
        <div style="text-align:right;flex:none">
          <div class="pcost">${money(p.cost)}</div>
          <div class="minibar" style="background:var(--s1);width:${Math.max(6, (p.cost / maxP) * 76)}px;margin-left:auto;margin-top:5px"></div>
        </div>
      </div>
    </div>`).join('')
    : '<div class="empty">No individual prompts recorded for this session.</div>';

  $('#drawerPanel').innerHTML = `
    <div class="dhead">
      <div style="min-width:0">
        <h3>${esc(s.title)}</h3>
        <div class="sub2">${esc(s.cwd || s.project)}${s.branch ? ' · ' + esc(s.branch) : ''}
          · ${new Date(s.start).toLocaleString()} · ${s.entrypoint ? esc(s.entrypoint) : ''}</div>
      </div>
      <div class="spacer"></div>
      <button class="icon" onclick="document.getElementById('drawer').classList.remove('open')">✕</button>
    </div>

    <div class="statline" style="margin-top:0">
      ${stat(lens().col, money(s.cost), `${s.requests.toLocaleString()} responses`)}
      ${stat('Active time', dur(s.activeMs), perHr ? money(perHr) + '/hr while working' : '')}
      ${stat('Prompts', s.prompts || '—', s.costPerPrompt ? money(s.costPerPrompt) + ' each' : '')}
      ${stat('Delegated', money(s.subCost), `${s.subRequests} subagent responses`)}
      ${stat('Tokens', toks(tokTotal), `${toks(s.tok.out)} out · ${toks(s.tok.read)} cached`)}
      ${stat('Spanned', dur(s.spanMs), 'first to last response')}
    </div>

    <div class="card" style="margin-top:14px;padding:14px 16px">
      <h2>Cost accumulating through the session</h2>
      <div class="chartbox"><svg id="sTimeline" viewBox="0 0 700 150" style="width:100%;height:150px"></svg></div>
    </div>

    <div class="card" style="margin-top:12px;padding:14px 16px">
      <h2>Models</h2>
      ${s.models.map((m, i) => `
        <div class="meter" style="margin-bottom:10px">
          <div class="mlab">
            <span class="mname"><i class="swatch" style="background:${seriesColor(i)}"></i>${esc(shortModel(m.name))}</span>
            <span class="mval">${money(m.cost)}</span>
          </div>
          <div class="mtrack plain"><div class="mfill" style="width:${(m.cost / Math.max(0.0001, s.cost)) * 100}%;background:${seriesColor(i)}"></div></div>
          <div class="mnote">${m.requests.toLocaleString()} responses · ${toks(m.tokens)} tokens</div>
        </div>`).join('')}
    </div>

    <h2 style="font-size:10.5px;font-weight:650;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:20px 0 10px">
      Where the money went, prompt by prompt
    </h2>
    ${prompts}`;

  drawTimeline(s);
}

function drawTimeline(s) {
  const el = $('#sTimeline'); if (!el) return; clear(el);
  const pts = s.timeline;
  const W = 700, H = 150, L = 48, R = 10, T = 10, B = 20;
  const iw = W - L - R, ih = H - T - B;
  if (pts.length < 2) { svg('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'axlab' }, el).textContent = 'not enough data'; return; }
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const max = pts[pts.length - 1].c || 0.01;
  const X = t => L + ((t - t0) / Math.max(1, t1 - t0)) * iw;
  const Y = c => T + ih - (c / max) * ih;

  for (let i = 0; i <= 3; i++) {
    const v = (max / 3) * i, yy = Y(v);
    svg('line', { x1: L, y1: yy, x2: W - R, y2: yy, class: i ? 'gridline' : 'baseline' }, el);
    svg('text', { x: L - 7, y: yy + 3.5, 'text-anchor': 'end', class: 'axlab' }, el).textContent = money1(v);
  }
  let d = '';
  for (const p of pts) d += (d ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.c).toFixed(1);
  svg('path', { d: d + `L${X(t1).toFixed(1)} ${T + ih}L${L} ${T + ih}Z`, fill: 'var(--s1)', opacity: .16 }, el);
  svg('path', { d, fill: 'none', stroke: 'var(--s1)', 'stroke-width': 2 }, el);
  svg('text', { x: L, y: H - 5, class: 'axlab' }, el).textContent = clock(t0);
  svg('text', { x: W - R, y: H - 5, 'text-anchor': 'end', class: 'axlab' }, el).textContent = clock(t1);
}

// =============================================================== breakdown ==

async function loadBreakdown() {
  const days = $('#bDays').value;
  const d = await (await fetch('/api/series?days=' + days)).json();
  $('#bSummary').innerHTML =
    `<b>${money(d.total.cost)}</b> · ${d.total.requests.toLocaleString()} responses · ${toks(d.total.in + d.total.out + d.total.read + d.total.write)} tokens`;
  drawBDaily(d.daily);
  fillBreak($('#bModel tbody'), d.byModel, d.total.cost, shortModel);
  fillBreak($('#bProject tbody'), d.byProject, d.total.cost, x => x);
  drawHours(d.hours);
}

function fillBreak(tb, rows, total, nameFn) {
  tb.innerHTML = '';
  const max = Math.max(0.0001, ...rows.map(r => r.cost));
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><i class="swatch" style="background:${seriesColor(i)}"></i>${esc(nameFn(r.name))}</td>
      <td class="n">${r.requests.toLocaleString()}</td>
      <td class="n">${toks(r.tokens)}</td>
      <td class="n" style="font-weight:640">${money(r.cost)}<div class="sub2">${total > 0 ? ((r.cost / total) * 100).toFixed(1) + '%' : ''}</div></td>
      <td><div class="minibar" style="background:${seriesColor(i)};width:${(r.cost / max) * 100}%"></div></td>`;
    tb.appendChild(tr);
  });
  if (!rows.length) tb.innerHTML = '<tr><td colspan="5" class="empty">Nothing in this window.</td></tr>';
}

function drawBDaily(daily) {
  const el = $('#bDaily'); clear(el);
  const W = 940, H = 230, L = 54, R = 12, T = 12, B = 30;
  const iw = W - L - R, ih = H - T - B;
  const max = Math.max(0.01, ...daily.map(d => d.cost));
  const bw = iw / daily.length;
  const y = v => T + ih - (v / max) * ih;

  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    svg('line', { x1: L, y1: yy, x2: W - R, y2: yy, class: i ? 'gridline' : 'baseline' }, el);
    svg('text', { x: L - 8, y: yy + 3.5, 'text-anchor': 'end', class: 'axlab' }, el).textContent = money1(v);
  }
  const step = Math.ceil(daily.length / 14);
  daily.forEach((d, i) => {
    const x = L + i * bw, w = Math.max(1, bw * .72);
    const hMain = ((d.cost - d.sub) / max) * ih, hSub = (d.sub / max) * ih;
    if (d.cost > 0) {
      svg('rect', { x: x + bw * .14, y: y(d.cost), width: w, height: Math.max(1, hSub), fill: 'var(--s5)', rx: 1.5 }, el);
      svg('rect', { x: x + bw * .14, y: y(d.cost) + hSub, width: w, height: Math.max(1, hMain), fill: 'var(--s1)', rx: 1.5 }, el);
    }
    const hit = svg('rect', { x, y: T, width: bw, height: ih, fill: 'transparent' }, el);
    hit.addEventListener('mouseenter', e => showTip(e,
      `<b>${money(d.cost)}</b><br><span style="color:var(--muted)">${new Date(d.d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}<br>
       ${d.requests.toLocaleString()} responses${d.sub > 0 ? ` · ${money(d.sub)} delegated` : ''}</span>`));
    hit.addEventListener('mouseleave', hideTip);
    if (i % step === 0) {
      svg('text', { x: x + bw / 2, y: H - 10, 'text-anchor': 'middle', class: 'axlab' }, el)
        .textContent = new Date(d.d).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
    }
  });
}

function drawHours(hours) {
  const el = $('#bHours'); clear(el);
  const W = 940, H = 190, L = 54, R = 12, T = 12, B = 28;
  const iw = W - L - R, ih = H - T - B;
  const max = Math.max(0.01, ...hours);
  const bw = iw / 24;
  const y = v => T + ih - (v / max) * ih;
  for (let i = 0; i <= 3; i++) {
    const v = (max / 3) * i, yy = y(v);
    svg('line', { x1: L, y1: yy, x2: W - R, y2: yy, class: i ? 'gridline' : 'baseline' }, el);
    svg('text', { x: L - 8, y: yy + 3.5, 'text-anchor': 'end', class: 'axlab' }, el).textContent = money1(v);
  }
  const nowH = new Date().getHours();
  hours.forEach((v, i) => {
    const x = L + i * bw;
    const h = v > 0 ? Math.max(2, (v / max) * ih) : 0;
    const r = svg('rect', {
      x: x + bw * .16, y: T + ih - h, width: bw * .68, height: h,
      fill: i === nowH ? 'var(--s2)' : 'var(--s1)', rx: 2
    }, el);
    r.addEventListener('mouseenter', e => showTip(e,
      `<b>${money(v)}</b><br><span style="color:var(--muted)">${String(i).padStart(2, '0')}:00 – ${String(i).padStart(2, '0')}:59</span>`));
    r.addEventListener('mouseleave', hideTip);
    if (i % 2 === 0)
      svg('text', { x: x + bw / 2, y: H - 9, 'text-anchor': 'middle', class: 'axlab' }, el)
        .textContent = String(i).padStart(2, '0');
  });
}

// ==================================================================== live ==

function renderFeed(s) {
  const tb = $('#feed tbody');
  $('#feedEmpty').classList.toggle('hidden', s.recent.length > 0);
  tb.innerHTML = s.recent.map(e => `
    <tr>
      <td>${clock(e.t)}</td>
      <td>${esc(shortModel(e.m))}</td>
      <td class="trunc" style="max-width:150px">${esc(e.p)}</td>
      <td>${e.sub ? '<span class="pill" style="color:var(--s5)">delegated</span>' : ''}</td>
      <td class="n">${toks(e.in)}</td>
      <td class="n">${toks(e.out)}</td>
      <td class="n">${e.think ? toks(e.think) : '—'}</td>
      <td class="n">${toks(e.read)}</td>
      <td class="n">${toks(e.write)}</td>
      <td class="n" style="font-weight:640">${money(e.c, e.c < 0.01 ? 4 : 2)}</td>
    </tr>`).join('');
}

// ==================================================================== tabs ==

function selectTab(name) {
  ACTIVE = name;
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  for (const t of ['overview', 'sessions', 'breakdown', 'limits', 'live'])
    $('#tab-' + t).classList.toggle('hidden', t !== name);
  location.hash = name;
  if (name === 'sessions')  loadSessions();
  if (name === 'breakdown') loadBreakdown();
  if (name === 'limits')    loadLimits();
}
$$('.tabs button').forEach(b => b.onclick = () => selectTab(b.dataset.tab));

// ================================================================= plumbing =

let bootSeen = null;
function apply(s) {
  // Server restarted (an update, usually): this page's code may be stale.
  if (s.boot) {
    if (bootSeen && s.boot !== bootSeen) { location.reload(); return; }
    bootSeen = s.boot;
  }
  STATE = s;
  $('#dot').className = 'dot' + (s.scanning ? ' warn' : '');
  $('#livetext').textContent = s.scanning ? 'scanning' : 'live';
  if (document.activeElement !== $('#planName')) $('#planName').value = s.plan.name;
  if (document.activeElement !== $('#planUsd'))  $('#planUsd').value  = s.plan.monthlyUsd;
  if (document.activeElement !== $('#planRenew') && s.period) $('#planRenew').value = s.period.renewalDay;
  if (s.exchange) RATE = s.exchange.rate;
  renderBlockBar(s);
  if (ACTIVE === 'overview') renderOverview(s);
  if (ACTIVE === 'live')     renderFeed(s);
}

let es;
function connect() {
  es = new EventSource('/api/stream');
  es.onmessage = ev => { try { apply(JSON.parse(ev.data)); } catch {} };
  es.onerror = () => {
    $('#dot').className = 'dot off';
    $('#livetext').textContent = 'disconnected';
    es.close();
    setTimeout(connect, 2500);
  };
}

$('#planSave').onclick = async () => {
  await fetch('/api/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planName: $('#planName').value, monthlyUsd: Number($('#planUsd').value),
                           renewalDay: Number($('#planRenew').value) || 1 })
  });
  const b = $('#planSave'); b.textContent = 'Saved'; setTimeout(() => b.textContent = 'Save', 1400);
};
$('#planUsd').addEventListener('keydown', e => { if (e.key === 'Enter') $('#planSave').click(); });
$('#planName').addEventListener('keydown', e => { if (e.key === 'Enter') $('#planSave').click(); });

/* Retail / Deal / Actual. Saved server-side so the gauge follows. */
function syncModeSwitch() {
  $$('#modeSwitch button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === MODE)));
}
$$('#modeSwitch button').forEach(b => b.onclick = async () => {
  MODE = b.dataset.mode;
  modePendingUntil = Date.now() + 3000;
  syncModeSwitch();
  if (STATE) { renderOverview(STATE); if (ACTIVE === 'live') renderFeed(STATE); }
  if (ACTIVE === 'sessions')  loadSessions(true);
  if (ACTIVE === 'breakdown') loadBreakdown();
  await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' },
                               body: JSON.stringify({ pricingMode: MODE }) }).catch(() => {});
});

$('#btnMini').onclick = async () => {
  // Ask the server to spawn a real OS window; fall back to a popup if it can't.
  const r = await fetch('/api/open', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ which: 'mini', size: '380,230' })
  }).then(r => r.json()).catch(() => ({ ok: false }));
  if (!r.ok) window.open('/mini', 'burnmeter-mini', 'width=380,height=196,menubar=no,toolbar=no,location=no,status=no');
};

let sessionsTimer, breakdownTimer;
$('#sQuery').addEventListener('input', () => { clearTimeout(sessionsTimer); sessionsTimer = setTimeout(() => loadSessions(true), 220); });
$('#sSpan').onchange = () => loadSessions(true);
$('#sSort').onchange = () => loadSessions(true);
$('#bDays').onchange = () => loadBreakdown();
setInterval(() => {
  if (ACTIVE === 'sessions')  loadSessions(true);
  if (ACTIVE === 'breakdown') loadBreakdown();
  if (ACTIVE === 'limits')    loadLimits();
}, 20000);
$('#lDays').onchange = () => loadLimits();
$('#lTest').onclick = async () => {
  const b = $('#lTest'); b.disabled = true; b.textContent = 'Sent';
  await fetch('/api/alerts', { method: 'POST', headers: { 'content-type': 'application/json' },
                               body: JSON.stringify({ test: true }) }).catch(() => {});
  setTimeout(() => { b.disabled = false; b.textContent = 'Test alert'; }, 1800);
};
const saveAlerts = () => fetch('/api/alerts', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ alertOnReset: $('#lAlert').checked, alertSound: $('#lSound').checked,
                         partyOnReset: $('#lParty').checked })
}).catch(() => {});
$('#lAlert').onchange = saveAlerts;
$('#lSound').onchange = saveAlerts;
$('#lParty').onchange = saveAlerts;

let mediaInfo = { dir: '', media: [] };
$('#lMedia').onclick = () => {
  const n = mediaInfo.media.length;
  alert(
    'Drop any image, GIF or video in this folder and the party uses it instead of the '
    + 'drawn figure:\n\n' + mediaInfo.dir + '\n\n'
    + (n ? `${n} file(s) in there now: ${mediaInfo.media.slice(0, 6).join(', ')}`
         + (n > 1 ? '\n\nWith more than one, it picks at random each time.' : '')
       : 'Nothing in there yet, so the drawn figure is being used.')
    + '\n\nAnimated GIFs and mp4/webm video work. Nothing in that folder is ever uploaded.'
  );
};

selectTab((location.hash || '#overview').slice(1) || 'overview');
connect();
