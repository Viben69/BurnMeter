/* BurnMeter dashboard. No dependencies — plain DOM + inline SVG. */
'use strict';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ------------------------------------------------------------ formatting ---

const money = (v, dp = 2) => {
  const n = Number(v) || 0;
  return '$' + n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
};
const moneyC = v => {                       // compact, for tight spaces
  const n = Math.abs(Number(v) || 0);
  if (n === 0) return '$0';
  if (n >= 10000) return '$' + (n / 1000).toFixed(1) + 'k';
  if (n >= 100)   return '$' + n.toFixed(0);
  if (n >= 1)     return '$' + n.toFixed(2);
  return '$' + n.toFixed(n >= 0.01 ? 2 : 3);
};
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
  // --- gauge ---
  drawGauge(s.rate.perHour);
  $('#rateWindow').textContent = `${Math.round(s.rate.windowSec / 60)} min average`;
  $('#rateBig').innerHTML = `${money(s.rate.perHour)}<small>/hr</small>`;
  $('#rateNote').textContent = s.rate.perHour > 0.005
    ? `Keep this up for an hour and you'd pull ${money(s.rate.perHour)} of API-rate value out of the plan.`
    : 'Idle — nothing has hit the API in the last few minutes.';
  $('#rateChips').innerHTML = [
    `<span class="chip">last minute <b>${moneyC(s.rate.instant)}/hr</b></span>`,
    `<span class="chip">last hour <b>${moneyC(s.rate.lastHour)}</b></span>`,
    `<span class="chip">today <b>${moneyC(s.windows.today.cost)}</b></span>`,
    s.live ? `<span class="chip">this session <b>${moneyC(s.live.cost)}</b></span>` : ''
  ].join('');

  // --- money's worth ---
  const w = s.worth;
  $('#worthSpent').textContent = money(w.spent);
  $('#worthSub').textContent = `of API value this month · plan costs ${money(w.fee, 0)}`;
  $('#worthMult').innerHTML = w.multiple.toFixed(2) + '&times;';
  const pct = Math.min(100, (w.spent / w.fee) * 100);
  const fill = $('#worthFill');
  fill.style.width = pct + '%';
  fill.style.background = w.multiple >= 1 ? 'var(--s3)' : w.multiple >= .6 ? 'var(--s4)' : 'var(--s2)';
  $('#worthMark').style.left = '100%';
  $('#worthTag').textContent = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const overBy = w.spent - w.fee;
  $('#worthVerdict').innerHTML = w.brokeEven
    ? `The plan paid for itself <b>${w.breakEvenAt ? new Date(w.breakEvenAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}</b>. Everything since is
       <b>${money(overBy)}</b> of value you'd otherwise have paid for — you're getting <b>${w.multiple.toFixed(1)}×</b> what you put in.`
    : `<b>${money(w.fee - w.spent)}</b> more of API-rate value would break even this month.
       At the current pace you'll land on <b>${money(w.projected)}</b>
       (${w.projectedMultiple.toFixed(2)}×) by month end —
       ${w.projectedMultiple >= 1 ? 'comfortably ahead.' : 'short of the fee.'}`;

  $('#worthStats').innerHTML = [
    stat('Projected', money(w.projected), `${w.projectedMultiple.toFixed(2)}× by month end`),
    stat('Per day', money(w.perDayActual), `need ${money(w.perDayNeeded)}/day`),
    stat('Days left', Math.ceil(w.daysLeft), `${Math.round(w.monthFraction * 100)}% through`),
    stat('All time', money(w.allTimeValue), `${w.allTimeMultiple.toFixed(1)}× over ${w.monthsTracked.toFixed(1)} mo`)
  ].join('');

  // --- limits ---
  const L = s.limits;
  const rows = [];
  rows.push(limitRow('fiveHour', '5-hour', L.fiveHourPct, L.fiveHourPace, s.windows.blockResetsIn,
    `${moneyC(s.windows.block.cost)} of value in this block`, L.self && L.self.fiveHour));
  rows.push(limitRow('week', 'Weekly', L.weekPct, L.weekPace, s.windows.weekResetsIn,
    `${moneyC(s.windows.week7.cost)} of value in the last 7 days`, L.self && L.self.week));
  if (L.contextPct != null) {
    rows.push(meter('Context window', L.contextPct, null, null,
      L.model ? `current session on ${L.model}` : 'current session'));
  }
  $('#limits').innerHTML = rows.join('');

  const anyReal = L.fiveHourPct != null;
  const calibrated = !!(L.calibration && (L.calibration.fiveHourAllowance || L.calibration.weekAllowance));
  $('#limitsTag').innerHTML = anyReal
    ? (L.stale ? '<span style="color:var(--muted)">last seen ' + ago(L.updatedAt * 1000) + '</span>' : 'live')
    : calibrated ? '<span style="color:var(--s1)">calibrated estimate</span>'
    : '<span style="color:var(--muted)">estimated from your history</span>';

  // --- windows ---
  $('#windows').innerHTML = [
    stat('Today', money(s.windows.today.cost), `${s.windows.today.requests.toLocaleString()} responses`),
    stat('5-hour block', money(s.windows.block.cost), `${s.windows.block.requests.toLocaleString()} responses`),
    stat('7 days', money(s.windows.week7.cost), `${s.windows.week7.requests.toLocaleString()} responses`),
    stat('Month', money(s.windows.month.cost), `${s.windows.month.requests.toLocaleString()} responses`)
  ].join('');

  drawSpark(s.spark);
  drawDaily(s);

  // --- warnings / footer ---
  const warns = [];
  if (s.unknownModels.length)
    warns.push(`No price on file for <b>${s.unknownModels.map(esc).join(', ')}</b> — counted as $0.
                Add the rate to <code>pricing.json</code>.`);
  if (L.fiveHourPct == null && !calibrated)
    warns.push(`The 5-hour and weekly figures above are <b>estimates from your own history</b>, not
                Anthropic's allowance. The real percentages are only handed to the statusline hook,
                which runs in the terminal UI — not the desktop app. If you can see your true
                percentage anywhere, hit <b>set real %</b> on either meter: one number is enough for
                BurnMeter to work out the whole window and report real percentages from then on.`);
  $('#warn').innerHTML = warns.join('<br>');
  $('#warn').classList.toggle('hidden', !warns.length);

  renderUpdate(s);

  $('#footStats').innerHTML =
    `BurnMeter v${esc(s.version || '?')} · tracking <b>${s.eventsTracked.toLocaleString()}</b> API responses across
     <b>${s.sessionsTracked}</b> sessions and <b>${s.filesTracked}</b> transcripts,
     back to ${new Date(s.dataFrom).toLocaleDateString()}. Prices from <code>pricing.json</code>.`;
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
  const data = s.daily;
  const W = 940, H = 220, L = 52, R = 12, T = 12, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const needPerDay = s.worth.perDayNeeded;
  const max = Math.max(needPerDay * 1.25, ...data, 0.01);
  const today = new Date().getDate() - 1;
  const y = v => T + ih - (v / max) * ih;
  const bw = iw / data.length;

  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    svg('line', { x1: L, y1: yy, x2: W - R, y2: yy, class: i ? 'gridline' : 'baseline' }, el);
    const t = svg('text', { x: L - 8, y: yy + 3.5, 'text-anchor': 'end', class: 'axlab' }, el);
    t.textContent = moneyC(v);
  }

  data.forEach((v, i) => {
    const h = v > 0 ? Math.max(2, (v / max) * ih) : 0;
    const x = L + i * bw;
    const isToday = i === today;
    const r = svg('rect', {
      x: x + bw * .16, y: T + ih - h, width: bw * .68, height: h,
      fill: isToday ? 'var(--s2)' : 'var(--s1)', opacity: i > today ? .18 : 1, rx: 2
    }, el);
    const d = new Date(new Date().getFullYear(), new Date().getMonth(), i + 1);
    r.addEventListener('mouseenter', e => showTip(e,
      `<b>${money(v)}</b><br><span style="color:var(--muted)">${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}${isToday ? ' · today' : ''}</span>`));
    r.addEventListener('mouseleave', hideTip);
    if (i % 2 === 0 || data.length <= 16) {
      const t = svg('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle', class: 'axlab' }, el);
      t.textContent = i + 1;
    }
  });

  // Break-even pace line.
  const py = y(needPerDay);
  svg('line', {
    x1: L, y1: py, x2: W - R, y2: py, stroke: 'var(--baseline)',
    'stroke-width': 1.5, 'stroke-dasharray': '5 4'
  }, el);
  const lab = svg('text', { x: W - R - 4, y: py - 6, 'text-anchor': 'end', class: 'axlab', fill: 'var(--ink-2)' }, el);
  lab.textContent = `break even ${money(needPerDay)}/day`;

  const over = data.filter(v => v >= needPerDay).length;
  $('#dailyTag').textContent = `${over} of ${today + 1} days beat the break-even pace`;
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
    `<b>${data.total}</b> sessions · <b>${money(data.grandCost)}</b> of API value`;

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
      ${stat('API value', money(s.cost), `${s.requests.toLocaleString()} responses`)}
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
    svg('text', { x: L - 7, y: yy + 3.5, 'text-anchor': 'end', class: 'axlab' }, el).textContent = moneyC(v);
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
    svg('text', { x: L - 8, y: yy + 3.5, 'text-anchor': 'end', class: 'axlab' }, el).textContent = moneyC(v);
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
    svg('text', { x: L - 8, y: yy + 3.5, 'text-anchor': 'end', class: 'axlab' }, el).textContent = moneyC(v);
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
  for (const t of ['overview', 'sessions', 'breakdown', 'live'])
    $('#tab-' + t).classList.toggle('hidden', t !== name);
  location.hash = name;
  if (name === 'sessions')  loadSessions();
  if (name === 'breakdown') loadBreakdown();
}
$$('.tabs button').forEach(b => b.onclick = () => selectTab(b.dataset.tab));

// ================================================================= plumbing =

function apply(s) {
  STATE = s;
  $('#dot').className = 'dot' + (s.scanning ? ' warn' : '');
  $('#livetext').textContent = s.scanning ? 'scanning' : 'live';
  if (document.activeElement !== $('#planName')) $('#planName').value = s.plan.name;
  if (document.activeElement !== $('#planUsd'))  $('#planUsd').value  = s.plan.monthlyUsd;
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
    body: JSON.stringify({ planName: $('#planName').value, monthlyUsd: Number($('#planUsd').value) })
  });
  const b = $('#planSave'); b.textContent = 'Saved'; setTimeout(() => b.textContent = 'Save', 1400);
};
$('#planUsd').addEventListener('keydown', e => { if (e.key === 'Enter') $('#planSave').click(); });
$('#planName').addEventListener('keydown', e => { if (e.key === 'Enter') $('#planSave').click(); });

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
}, 20000);

selectTab((location.hash || '#overview').slice(1) || 'overview');
connect();
