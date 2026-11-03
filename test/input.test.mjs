import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId } from './fixture.mjs';

// The scripts that read their fields as JSON on stdin say why the input was refused before the usage, since an agent
// whose shell mangled a backslash otherwise sees only the usage and guesses.
const SCRIPTS = ['propose.mjs', 'pick.mjs', 'proposals.mjs', 'domain.mjs'];

function started(t) {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid);
  return { v, sid };
}

test('JSON that does not parse exits 2 with the parser\'s reason and where, then the usage', t => {
  const { v, sid } = started(t);
  for (const script of SCRIPTS) {
    const r = v.run(script, [sid], { input: '{"triggers": ["export\\s+function"]}' });
    assert.equal(r.code, 2, script);
    assert.match(r.stderr, /^The input isn't valid JSON: Bad escaped character in JSON at position \d+.*\.\nusage: node tools\//, script);
    assert.equal(v.exists('raw/inbox'), false, script);
  }
});

test('no input, or JSON that is not an object, exits 2 saying so', t => {
  const { v, sid } = started(t);
  for (const script of SCRIPTS) {
    assert.match(v.run(script, [sid], { input: ' \n' }).stderr, /^No JSON came on stdin\.\nusage: /, script);
    for (const input of ['[1]', 'null', '"x"']) {
      const r = v.run(script, [sid], { input });
      assert.equal(r.code, 2, `${script} ${input}`);
      assert.match(r.stderr, /^The input must be one JSON object\.\nusage: /, `${script} ${input}`);
    }
  }
});
