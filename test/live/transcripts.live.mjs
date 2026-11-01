// VAULT_LIVE=1 node --test test/live/*.live.mjs
// The live half of the typed-text provider test (design 6.7c). Each agent's transcript format is undocumented, so this
// checks that the fields its provider reads are in this machine's newest session file. It reads and never writes, and it
// prints only counts and field names, never a message's text or a file's path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const live = { skip: !process.env.VAULT_LIVE && 'set VAULT_LIVE=1 to check the transcripts on this machine' };
const ADAPTERS = path.join(import.meta.dirname, '..', '..', 'tools', 'adapters');
const names = fs.readdirSync(ADAPTERS).filter(n => fs.existsSync(path.join(ADAPTERS, n, 'adapter.mjs')));

for (const name of names) {
  test(`${name}: the fields its provider reads are in this machine's newest transcript`, live, async t => {
    const adapter = await import(new URL(`../../tools/adapters/${name}/adapter.mjs`, import.meta.url));
    const file = adapter.newestTranscript(os.homedir());
    if (!file) return t.skip(`no ${name} session file on this machine`);
    const { ok, missing, records } = adapter.transcriptCheck(file);
    t.diagnostic(`${name}: ${records} records in the newest session file; missing: ${missing.length ? missing.join(', ') : 'none'}`);
    assert.ok(ok, `${name}'s newest transcript lacks ${missing.join(', ')}`);
  });
}
