#!/usr/bin/env node
/*
 * BurnMeter installer.
 *
 *   node install.js               copy into ~/.claude/burnmeter and wire the statusline
 *   node install.js --no-statusline    copy only, leave settings.json alone
 *   node install.js --statusline       only wire the statusline (already installed)
 *   node install.js --uninstall        remove the statusLine entry (files stay)
 *
 * Safe to re-run. settings.json is backed up before any edit, and only the
 * "statusLine" key is touched.
 */
'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const HOME       = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const DEST       = path.join(CLAUDE_DIR, 'burnmeter');
const SETTINGS   = path.join(CLAUDE_DIR, 'settings.json');
const SRC        = __dirname;

const args = new Set(process.argv.slice(2));
const only  = args.has('--statusline');
const skip  = args.has('--no-statusline');
const undo  = args.has('--uninstall');

const ROOT_FILES = [
  'server.js', 'statusline.js', 'update.js', 'pricing.json',
  'package.json', 'version.json', 'README.md', 'LICENSE',
  'install.js', 'install-desktop.js', 'make-icon.js', 'make-manifest.js',
  'seed-demo.js', 'install.ps1', 'install.sh'
];
const COPY_DIRS = ['public', 'desktop'];

function copyDir(name){
  const from = path.join(SRC, name), to = path.join(DEST, name);
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)){
    const src = path.join(from, f);
    if (fs.statSync(src).isDirectory()) continue;      // no nested assets today
    fs.copyFileSync(src, path.join(to, f));
  }
}

function copyFiles(){
  if (path.resolve(SRC) === path.resolve(DEST)){
    console.log(`• already installed at ${DEST}`);
    return;
  }
  fs.mkdirSync(DEST, { recursive: true });
  for (const f of ROOT_FILES){
    const from = path.join(SRC, f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(DEST, f));
  }
  for (const d of COPY_DIRS) copyDir(d);

  // Never clobber an existing config — that's the user's plan and port. But do
  // migrate keys added since it was written, so new settings get their defaults.
  const cfgDst = path.join(DEST, 'config.json');
  const cfgSrc = path.join(SRC, 'config.json');
  if (fs.existsSync(cfgSrc)){
    if (!fs.existsSync(cfgDst)) fs.copyFileSync(cfgSrc, cfgDst);
    else {
      try {
        const base = JSON.parse(fs.readFileSync(cfgSrc, 'utf8'));
        const cur  = JSON.parse(fs.readFileSync(cfgDst, 'utf8'));
        let added = [];
        for (const k of Object.keys(base)) if (!(k in cur)){ cur[k] = base[k]; added.push(k); }
        // lookbackDays 45 was the old default and silently hid older transcripts.
        if (cur.lookbackDays === 45){ cur.lookbackDays = 0; added.push('lookbackDays->0'); }
        if (added.length){
          fs.writeFileSync(cfgDst, JSON.stringify(cur, null, 2));
          console.log(`• config.json updated (${added.join(', ')})`);
        }
      } catch { /* leave a hand-edited config alone */ }
    }
  }
  console.log(`• installed to ${DEST}`);
}

function readSettings(){
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    console.error(`\n✗ ${SETTINGS} is not valid JSON — fix it first, then re-run.\n  (${e.message})\n`);
    process.exit(1);
  }
}

function writeSettings(obj){
  if (fs.existsSync(SETTINGS)){
    const bak = SETTINGS + '.burnmeter-backup';
    fs.copyFileSync(SETTINGS, bak);
    console.log(`• backed up settings.json → ${path.basename(bak)}`);
  }
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2) + '\n');
}

function wireStatusline(){
  const s = readSettings();
  const cmd = `node "${path.join(DEST, 'statusline.js')}"`;
  if (s.statusLine && s.statusLine.command && !/burnmeter/.test(s.statusLine.command)){
    console.log('\n⚠ You already have a custom statusLine:');
    console.log(`    ${s.statusLine.command}`);
    console.log('  Not overwriting it. To use BurnMeter\'s, set it manually to:');
    console.log(`    ${cmd}`);
    console.log('  BurnMeter still needs it to read your 5-hour and weekly limits — those');
    console.log('  numbers are only available to a statusline hook. Everything else works without it.\n');
    return;
  }
  s.statusLine = { type: 'command', command: cmd, refreshInterval: 10, padding: 0 };
  writeSettings(s);
  console.log('• statusline wired up');
}

function unwire(){
  const s = readSettings();
  if (s.statusLine && /burnmeter/.test(s.statusLine.command || '')){
    delete s.statusLine;
    writeSettings(s);
    console.log('• statusLine removed from settings.json');
  } else console.log('• no BurnMeter statusLine found; nothing to remove');
}

console.log('\nBurnMeter\n');
if (undo){ unwire(); process.exit(0); }
if (!only) copyFiles();
if (!skip) wireStatusline();

const cfgPath = path.join(DEST, 'config.json');
let port = 4317;
try { port = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).port || 4317; } catch {}

if (process.platform === 'win32'){
  console.log(`
Next:

  1. Make it a desktop app   node "${path.join(DEST, 'install-desktop.js')}"

     That puts BurnMeter and BurnMeter Gauge on your desktop and starts the
     server at login. Both are real windows - move, resize, minimise, pin on
     top, drag to a second monitor.

  2. Or just run it now      node "${path.join(DEST, 'server.js')}" --open

  3. Set your plan price in the dashboard header (default: Max 20x, $200/mo).

  The 5-hour and weekly meters show an estimate from your own history. The real
  percentages reach the statusline hook, which only runs in the terminal UI - in
  the desktop app you can enter your true percentage once via "set real %" and
  BurnMeter reports real numbers from then on.
`);
} else {
  console.log(`
Next:

  1. Start it              node "${path.join(DEST, 'server.js')}"
  2. Open the dashboard    http://127.0.0.1:${port}
  3. Set your plan price in the header of the page (default: Max 20x, $200/mo)

  Restart Claude Code once so the statusline loads, then send one message - the
  5-hour and weekly meters fill in after the first API response of a session.

  Keep it running in the background:
    nohup node "${path.join(DEST, 'server.js')}" >/tmp/burnmeter.log 2>&1 &
`);
}
