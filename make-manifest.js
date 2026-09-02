#!/usr/bin/env node
/*
 * Cuts a release. Run this in the repo before you commit and push.
 *
 *   node make-manifest.js                          rebuild version.json as-is
 *   node make-manifest.js --bump patch              1.0.0 -> 1.0.1
 *   node make-manifest.js --bump minor --notes "…"  1.0.0 -> 1.1.0, with notes
 *
 * It writes version.json: the version, release notes, and a SHA-256 for every
 * shipped file. That file is what installed copies fetch to decide whether they
 * are out of date, and what update.js verifies each download against.
 *
 * Per-machine state (config.json, limits.json, …) is deliberately not listed —
 * an update must never overwrite somebody's settings.
 */
'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const APP_DIR = __dirname;

// Everything that makes up a release, and nothing that doesn't.
const ROOT_FILES = [
  'server.js', 'statusline.js', 'install.js', 'install-desktop.js',
  'make-icon.js', 'make-manifest.js', 'update.js', 'seed-demo.js',
  'pricing.json', 'package.json', 'README.md', 'LICENSE',
  'install.ps1', 'install.sh'
];
const DIRS = ['public', 'desktop'];

const SKIP = new Set([
  'config.json', 'limits.json', 'worth-cache.json', 'statusline-trace.log', 'version.json'
]);

const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/*
 * A syntax error in an HTML page's inline <script> is silent: the file loads,
 * the tag is ignored, and the page renders blank. update.js already refuses to
 * install a .js file that will not parse; this extends the same guarantee to
 * the script inside our HTML, which is where most of the gauge lives.
 */
function checkInlineScripts() {
  const vm = require('vm');
  const bad = [];
  for (const dir of DIRS) {
    const d = path.join(APP_DIR, dir);
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) {
      if (!name.endsWith('.html')) continue;
      const html = fs.readFileSync(path.join(d, name), 'utf8');
      const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
      let m, i = 0;
      while ((m = re.exec(html))) {
        i++;
        if (!m[1].trim()) continue;
        try { new vm.Script(m[1], { filename: dir + '/' + name + ' <script ' + i + '>' }); }
        catch (e) { bad.push(dir + '/' + name + ' script #' + i + ': ' + e.message); }
      }
    }
  }
  return bad;
}


function collect() {
  const files = {};
  for (const f of ROOT_FILES) {
    const p = path.join(APP_DIR, f);
    if (fs.existsSync(p) && !SKIP.has(f)) files[f] = sha256(p);
  }
  for (const d of DIRS) {
    const dir = path.join(APP_DIR, d);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (!fs.statSync(p).isFile() || SKIP.has(name)) continue;
      files[`${d}/${name}`] = sha256(p);           // forward slashes: it's a URL path
    }
  }
  return files;
}

function bump(version, kind) {
  const p = String(version).split('.').map(n => parseInt(n, 10) || 0);
  while (p.length < 3) p.push(0);
  if (kind === 'major') { p[0]++; p[1] = 0; p[2] = 0; }
  else if (kind === 'minor') { p[1]++; p[2] = 0; }
  else p[2]++;
  return p.join('.');
}

const argv = process.argv.slice(2);
const argOf = name => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const pkgPath = path.join(APP_DIR, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const kind = argOf('bump');
if (kind) {
  if (!['major', 'minor', 'patch'].includes(kind)) {
    console.error('--bump takes major, minor or patch');
    process.exit(1);
  }
  pkg.version = bump(pkg.version, kind);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`version -> ${pkg.version}`);
}

let notes = argOf('notes');
if (notes == null) {
  // Keep the previous notes rather than silently blanking them.
  try { notes = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'version.json'), 'utf8')).notes || ''; }
  catch { notes = ''; }
}

const broken = checkInlineScripts();
if (broken.length) {
  console.error('\nRefusing to cut a release - an inline script will not parse:\n');
  for (const b of broken) console.error('  ' + b);
  console.error('\nA page with a broken inline script renders blank, silently.\n');
  process.exit(1);
}

const files = collect();
const manifest = {
  version: pkg.version,
  notes,
  published: new Date().toISOString(),
  files
};
fs.writeFileSync(path.join(APP_DIR, 'version.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`version.json written — v${pkg.version}, ${Object.keys(files).length} files`);
if (pkg.repository && /OWNER/.test(pkg.repository.url || '')) {
  console.log('\n! repository in package.json is still the placeholder.');
  console.log('  Updates will not work until it points at your real GitHub repo.');
}
console.log('\nNext:  git add -A && git commit -m "release v' + pkg.version + '" && git push');
