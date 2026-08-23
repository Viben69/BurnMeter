#!/usr/bin/env node
/*
 * BurnMeter self-updater.
 *
 *   node update.js            check, and install if there's something newer
 *   node update.js --check    check only, print what it finds, change nothing
 *   node update.js --force    reinstall the remote version even if not newer
 *   node update.js --rollback restore the most recent backup
 *
 * How it works: the repo carries a version.json listing every shipped file with
 * its SHA-256. We fetch that, compare versions, download each changed file to a
 * staging directory, verify every hash, syntax-check the JavaScript, and only
 * then swap them in — backing up what was there first.
 *
 * What it will not do:
 *   - touch config.json, limits.json, or anything else that is your state
 *   - fetch from anywhere except the pinned repo, over HTTPS
 *   - install a file whose hash doesn't match, or whose JS doesn't parse
 *   - run on its own; the server only ever *checks*, you choose to apply
 *
 * Zero dependencies.
 */
'use strict';

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const crypto  = require('crypto');
const vm      = require('vm');

const APP_DIR = __dirname;
const STAGING = path.join(APP_DIR, '.update-staging');

// Only these hosts, ever. GitHub redirects raw content through the last two.
const ALLOWED_HOSTS = new Set([
  'api.github.com',                 // private repos, via the Contents API
  'raw.githubusercontent.com',      // public repos
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com'   // where the API redirects large blobs
]);

// Per-machine state. An update must never overwrite these.
const PRESERVE = new Set([
  'config.json', 'limits.json', 'worth-cache.json', 'statusline-trace.log'
]);

// ----------------------------------------------------------------- token ----

/*
 * A private repo needs a GitHub token. It lives in a file of its own rather
 * than in config.json, so that a config someone copies between machines - or
 * pastes into an issue - can never carry a credential with it.
 *
 *   ~/.claude/burnmeter/.token      one line, the token, nothing else
 *   $BURNMETER_TOKEN                wins over the file
 *
 * It is only ever sent to api.github.com, and never logged.
 */
const TOKEN_F = path.join(APP_DIR, '.token');

function readToken() {
  const env = (process.env.BURNMETER_TOKEN || '').trim();
  if (env) return env;
  try {
    const t = fs.readFileSync(TOKEN_F, 'utf8').trim();
    return t || null;
  } catch { return null; }
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_F, String(token).trim() + String.fromCharCode(10), { mode: 0o600 });
  try { fs.chmodSync(TOKEN_F, 0o600); } catch {}   // no-op on Windows, harmless
}

// ------------------------------------------------------------------ repo ----

/** Where updates come from: config.json wins, then package.json, then null. */
function repoInfo() {
  let url = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'config.json'), 'utf8'));
    if (cfg.updateRepo) url = cfg.updateRepo;
  } catch {}
  if (!url) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
      url = pkg.repository && pkg.repository.url;
    } catch {}
  }
  if (!url) return null;
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/i.exec(String(url));
  if (!m) return null;
  const owner = m[1], repo = m[2];
  if (owner === 'OWNER') return null;              // still the placeholder
  let branch = 'main';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'config.json'), 'utf8'));
    if (cfg.updateBranch) branch = String(cfg.updateBranch);
  } catch {}
  return { owner, repo, branch, raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}` };
}

function localVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

/** -1 / 0 / 1, comparing dotted numeric versions. */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ------------------------------------------------------------------ http ----

function get(url, opts = {}) {
  const { timeout = 12000, depth = 0, headers = {}, token = null } = opts;
  return new Promise((resolve, reject) => {
    if (depth > 4) return reject(new Error('too many redirects'));
    let u;
    try { u = new URL(url); } catch { return reject(new Error('bad url')); }
    if (u.protocol !== 'https:') return reject(new Error('https only'));
    if (!ALLOWED_HOSTS.has(u.host)) return reject(new Error('host not allowed: ' + u.host));

    const h = Object.assign({ 'user-agent': 'burnmeter-updater', 'accept': '*/*' }, headers);
    // The credential goes to GitHub's API and nowhere else - not to the CDN
    // hosts it redirects to, which reject it anyway and would only leak it.
    if (token && u.host === 'api.github.com') h.authorization = 'Bearer ' + token;

    const req = https.get(u, { headers: h }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url);
        return resolve(get(next.href, Object.assign({}, opts, {
          depth: depth + 1,
          token: next.host === 'api.github.com' ? token : null
        })));
      }
      if (res.statusCode !== 200) {
        res.resume();
        const hint = res.statusCode === 404 ? 'not found (private repo without a valid token?)'
                   : res.statusCode === 401 || res.statusCode === 403 ? 'access denied (check your token)'
                   : 'HTTP ' + res.statusCode;
        return reject(new Error(hint));
      }
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > 8 * 1024 * 1024) { req.destroy(new Error('response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Where one file lives. With a token we go through the Contents API, which is
 * the only route that works for a private repo; without one we use the raw CDN.
 * Both return identical bytes, so the hashes in version.json hold either way.
 */
function fileRequest(repo, name, token) {
  const rel = String(name).split(path.sep).join('/');
  const bust = 't=' + Date.now();
  if (token) {
    return {
      url: `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${encodeURI(rel)}` +
           `?ref=${encodeURIComponent(repo.branch)}&${bust}`,
      opts: { token, headers: { accept: 'application/vnd.github.raw' } }
    };
  }
  return { url: `${repo.raw}/${rel}?${bust}`, opts: {} };
}

// ----------------------------------------------------------------- check ----

/** Fetch the remote manifest. Resolves to a plain object; never throws. */
async function check() {
  const repo = repoInfo();
  const current = localVersion();
  if (!repo) {
    return { ok: false, current, reason: 'no update repo configured', configured: false };
  }
  const token = readToken();
  try {
    const r = fileRequest(repo, 'version.json', token);
    const body = await get(r.url, r.opts);
    const remote = JSON.parse(body.toString('utf8'));
    if (!remote.version || !remote.files) throw new Error('malformed version.json');
    const available = cmpVersion(remote.version, current) > 0;
    return {
      ok: true, configured: true, current,
      latest: remote.version,
      available,
      notes: remote.notes || '',
      published: remote.published || null,
      repo: `${repo.owner}/${repo.repo}`,
      private: !!token,
      fileCount: Object.keys(remote.files).length,
      checkedAt: Date.now()
    };
  } catch (e) {
    // Offline, DNS down, repo private — all the same to us: just don't update.
    return { ok: false, configured: true, current, reason: e.message, checkedAt: Date.now() };
  }
}

// ----------------------------------------------------------------- apply ----

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

/** JS must parse before we're willing to install it. */
function jsParses(source, name) {
  try { new vm.Script(source, { filename: name }); return true; }
  catch { return false; }
}

async function apply(opts = {}) {
  const log = opts.log || (() => {});
  const repo = repoInfo();
  if (!repo) return { ok: false, reason: 'no update repo configured' };

  const current = localVersion();
  const token = readToken();
  let remote;
  try {
    const r = fileRequest(repo, 'version.json', token);
    remote = JSON.parse((await get(r.url, r.opts)).toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'could not reach the repo: ' + e.message };
  }
  if (!remote.version || !remote.files) return { ok: false, reason: 'malformed version.json' };
  if (!opts.force && cmpVersion(remote.version, current) <= 0) {
    return { ok: true, updated: false, current, latest: remote.version, reason: 'already up to date' };
  }

  const names = Object.keys(remote.files).filter(n => {
    if (PRESERVE.has(n)) return false;                       // never clobber state
    if (n.includes('..') || path.isAbsolute(n)) return false; // path traversal
    return true;
  });

  // --- stage: download and verify everything before touching the install ----
  rmrf(STAGING);
  fs.mkdirSync(STAGING, { recursive: true });
  const changed = [];
  for (const name of names) {
    const want = String(remote.files[name]).toLowerCase();
    const dest = path.join(STAGING, name);
    if (!path.resolve(dest).startsWith(path.resolve(STAGING))) {
      rmrf(STAGING);
      return { ok: false, reason: 'refusing suspicious path: ' + name };
    }
    // Skip files we already have byte-for-byte.
    try {
      if (sha256(fs.readFileSync(path.join(APP_DIR, name))) === want) continue;
    } catch {}

    let body;
    try {
      const r = fileRequest(repo, name, token);
      body = await get(r.url, r.opts);
    } catch (e) {
      rmrf(STAGING);
      return { ok: false, reason: `download failed for ${name}: ${e.message}` };
    }
    const got = sha256(body);
    if (got !== want) {
      rmrf(STAGING);
      return { ok: false, reason: `hash mismatch on ${name} — refusing to install` };
    }
    if (name.endsWith('.js') && !jsParses(body.toString('utf8'), name)) {
      rmrf(STAGING);
      return { ok: false, reason: `${name} does not parse — refusing to install` };
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    changed.push(name);
    log(`staged ${name}`);
  }

  if (!changed.length) {
    rmrf(STAGING);
    return { ok: true, updated: false, current, latest: remote.version, reason: 'files already match' };
  }

  // --- back up what we're about to replace -------------------------------
  const backup = path.join(APP_DIR, `.backup-${current}-${Date.now()}`);
  fs.mkdirSync(backup, { recursive: true });
  for (const name of changed) {
    const from = path.join(APP_DIR, name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(backup, name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }

  // --- swap in ------------------------------------------------------------
  try {
    for (const name of changed) {
      const to = path.join(APP_DIR, name);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(STAGING, name), to);
      log(`installed ${name}`);
    }
  } catch (e) {
    // Put back whatever we managed to move.
    for (const name of changed) {
      const b = path.join(backup, name);
      if (fs.existsSync(b)) fs.copyFileSync(b, path.join(APP_DIR, name));
    }
    rmrf(STAGING);
    return { ok: false, reason: 'install failed and was rolled back: ' + e.message };
  }
  rmrf(STAGING);
  pruneBackups();

  return {
    ok: true, updated: true, from: current, to: remote.version,
    files: changed, notes: remote.notes || '', backup: path.basename(backup)
  };
}

/** Keep the three most recent backups, bin the rest. */
function pruneBackups() {
  try {
    const dirs = fs.readdirSync(APP_DIR)
      .filter(d => d.startsWith('.backup-'))
      .map(d => ({ d, t: fs.statSync(path.join(APP_DIR, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { d } of dirs.slice(3)) rmrf(path.join(APP_DIR, d));
  } catch {}
}

function rollback() {
  let dirs;
  try {
    dirs = fs.readdirSync(APP_DIR)
      .filter(d => d.startsWith('.backup-'))
      .map(d => ({ d, t: fs.statSync(path.join(APP_DIR, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  } catch { dirs = []; }
  if (!dirs.length) return { ok: false, reason: 'no backups to roll back to' };
  const from = path.join(APP_DIR, dirs[0].d);
  const restore = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, e.name);
      const relPath = path.join(rel, e.name);
      if (e.isDirectory()) { restore(src, relPath); continue; }
      const dest = path.join(APP_DIR, relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  };
  restore(from);
  return { ok: true, restored: dirs[0].d };
}

// ------------------------------------------------------------------ cli ----

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);

  if (args.has('--set-token')) {
    // Prefer stdin: an argument would end up in shell history.
    const inline = argv[argv.indexOf('--set-token') + 1];
    let token = inline && !inline.startsWith('--') ? inline : null;
    if (token) {
      console.error('note: passing the token as an argument leaves it in your shell history.');
    } else {
      process.stdout.write('Paste your GitHub token (input is not echoed back): ');
      token = await new Promise(resolve => {
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', d => (buf += d));
        process.stdin.on('end', () => resolve(buf.trim()));
      });
    }
    if (!token) { console.error('No token given.'); process.exit(1); }
    saveToken(token);
    console.log(String.fromCharCode(10) + 'Token saved to .token (this directory). Checking access...');
    const c = await check();
    if (c.ok) console.log(`OK - ${c.repo}, latest v${c.latest}, you have v${c.current}.`);
    else console.log(`Still cannot read the repo: ${c.reason}`);
    process.exit(c.ok ? 0 : 1);
  }

  if (args.has('--rollback')) {
    const r = rollback();
    console.log(r.ok ? `Rolled back to ${r.restored}. Restart BurnMeter.` : `Nothing to do: ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  }

  const c = await check();
  if (!c.configured) {
    console.log('No update repo configured yet.');
    console.log('Set "repository" in package.json, or "updateRepo" in config.json, to your GitHub URL.');
    process.exit(1);
  }
  if (!c.ok && /token|denied|not found/i.test(c.reason || '') && !readToken()) {
    console.log(`Cannot read the repo: ${c.reason}`);
    console.log('If it is private, add a token:  node update.js --set-token');
    process.exit(1);
  }
  if (!c.ok) {
    console.log(`Could not check for updates (${c.reason}). You're on ${c.current}.`);
    process.exit(0);                                   // offline is not an error
  }

  console.log(`installed ${c.current} · latest ${c.latest} · ${c.repo}`);
  if (!c.available && !args.has('--force')) {
    console.log('Already up to date.');
    process.exit(0);
  }
  if (args.has('--check')) {
    console.log(`Update available: ${c.latest}${c.notes ? ' — ' + c.notes : ''}`);
    process.exit(0);
  }

  console.log(`Updating ${c.current} → ${c.latest}...`);
  const r = await apply({ force: args.has('--force'), log: m => console.log('  ' + m) });
  if (!r.ok) { console.error('Update failed: ' + r.reason); process.exit(1); }
  if (!r.updated) { console.log(r.reason); process.exit(0); }
  console.log(`\nUpdated to ${r.to}. ${r.files.length} file(s) replaced.`);
  if (r.notes) console.log(r.notes);
  console.log(`Backup kept at ${r.backup} — "node update.js --rollback" undoes this.`);
  console.log('Restart BurnMeter to pick it up.');
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { check, apply, rollback, repoInfo, localVersion, cmpVersion, readToken, saveToken };
