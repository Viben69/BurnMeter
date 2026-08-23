#!/usr/bin/env node
/*
 * Generates a fake ~/.claude/projects tree so you can see the widget populated
 * before you've built up real history. Writes to a temp dir — never touches
 * your real transcripts.
 *
 *   node seed-demo.js
 *   CLAUDE_CONFIG_DIR=<printed path> node server.js
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

const ROOT = process.argv.find(a => a.startsWith('--dir='))?.slice(6)
          || path.join(os.tmpdir(), 'burnmeter-demo');
const PROJ = path.join(ROOT, 'projects');
fs.rmSync(PROJ, { recursive: true, force: true });

const projects = [
  ['-Users-mike-code-printfarm', 'claude-opus-5',   1.0],
  ['-Users-mike-code-storefront','claude-sonnet-5', 0.7],
  ['-Users-mike-notes',          'claude-haiku-4-5',0.3]
];
const id = p => p + crypto.randomBytes(12).toString('hex');
const now = Date.now();
let lines = 0;

for (const [dir, model, weight] of projects){
  const d = path.join(PROJ, dir);
  fs.mkdirSync(d, { recursive: true });

  for (let day = 21; day >= 0; day--){
    const sessions = day === 0 ? 2 : Math.random() < 0.25 ? 0 : 1 + (Math.random() * 2 | 0);
    for (let s = 0; s < sessions; s++){
      const sid = crypto.randomUUID();
      const out = [];
      // A working session: starts sometime in the day, runs 20–140 minutes.
      const startHour = 8 + Math.random() * 11;
      let t = now - day * 864e5;
      t = new Date(t).setHours(startHour | 0, (Math.random() * 60) | 0, 0, 0);
      if (day === 0) t = now - (30 + Math.random() * 110) * 60e3;   // still burning right now
      let ctx = 12000 + Math.random() * 20000;
      const turns = 6 + (Math.random() * 34 | 0);

      for (let i = 0; i < turns; i++){
        t += (8 + Math.random() * 90) * 1000;
        if (t > now) break;
        const fresh = i === 0 ? ctx : 400 + Math.random() * 9000 * weight;
        const read  = i === 0 ? 0 : ctx;
        ctx += fresh;
        const outTok = (120 + Math.random() * 2600 * weight) | 0;
        const usage = {
          input_tokens: 2,
          cache_creation_input_tokens: fresh | 0,
          cache_read_input_tokens: read | 0,
          output_tokens: outTok,
          output_tokens_details: { thinking_tokens: (Math.random() * outTok * 0.5) | 0 },
          cache_creation: { ephemeral_1h_input_tokens: fresh | 0, ephemeral_5m_input_tokens: 0 }
        };
        const rec = {
          type: 'assistant', sessionId: sid, requestId: id('req_'),
          timestamp: new Date(t).toISOString(), cwd: '/x', version: '2.1.240',
          uuid: crypto.randomUUID(), userType: 'external', isSidechain: false,
          message: { id: id('msg_'), type: 'message', role: 'assistant', model,
                     content: [{ type: 'text', text: 'ok' }], usage }
        };
        // Transcripts repeat each response as it streams — the parser must dedupe.
        const dup = 1 + (Math.random() * 3 | 0);
        for (let k = 0; k < dup; k++) out.push(JSON.stringify(rec));
        if (ctx > 170000) ctx = 15000;     // /compact
      }
      if (out.length){ fs.writeFileSync(path.join(d, sid + '.jsonl'), out.join('\n') + '\n'); lines += out.length; }
    }
  }
}
console.log(`seeded ${lines} transcript lines → ${PROJ}`);
console.log(`\nrun:  CLAUDE_CONFIG_DIR="${ROOT}" node "${path.join(__dirname,'server.js')}"\n`);
