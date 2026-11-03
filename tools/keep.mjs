import { ownEntry } from './lib/sessions.mjs';
import { typedFor, currentSession } from './lib/agents.mjs';
import { useCall } from './lib/calls.mjs';
import { readOffer, claimOffer, keptOffer, codeConsent, consentOf } from './lib/offers.mjs';
import { proposeRule } from './lib/propose-rule.mjs';
import { addDomain } from './lib/add-domain.mjs';
import { mainWorktree } from './lib/git.mjs';
import { setMode } from './lib/set-mode.mjs';
import { UsageError, readInput, refuse, failure, line, renderHelp, schemaOf, schemaArg } from './lib/input.mjs';

const RUN = 'usage: node tools/keep.mjs [session-id] [call-id] < keep.json';
const USAGE = `${RUN}\n       node tools/keep.mjs --help lists the fields of keep.json`;

const FIELDS = [
  { name: 'id', type: 'string', required: true, help: ['the id of the offer, like o-1a2b3c4d, as propose, domain or proposals returned it'] },
  { name: 'offer', type: 'string', required: true, help: ["the offer's lines, exactly as they were returned"] },
];

const help = () => renderHelp([RUN, '', 'keep.json is an object with these fields:'], FIELDS, [], 9);

const SUMMARY = {
  prompt: 'Keeps an offer that propose, domain or proposals returned. The user is shown the offer at the permission prompt and allows or denies it.',
  code: "Keeps an offer that propose, domain or proposals returned, and writes it once the user's next message has the offer's code.",
};

const PASS = "The vault's tools pass the session id themselves. From a shell, pass it as the first argument, or run this from the agent's own shell, which sets its session variable.";

function sessionOf(sid) {
  if (!sid) refuse(`there's no session id to keep an offer for. ${PASS}`);
  const { entry, notOwn } = ownEntry(sid);
  if (notOwn) refuse(notOwn);
  if (!entry) refuse(`the taste vault has no session ${sid}. ${PASS}`);
  return entry;
}

const NOUN = { rule: 'rule', evidence: 'rule', domain: 'domain', mode: 'setting' };

function notPending(o) {
  if (o.state === 'kept') return `offer \`${o.id}\` was already kept. Nothing more was written.`;
  if (o.state === 'superseded') return `offer \`${o.id}\` was replaced by a later offer of the same ${NOUN[o.kind] ?? 'change'}. Keep that one.`;
  return `offer \`${o.id}\` was already tried once. Propose it again.`;
}

// The offer is claimed before anything is written, so two keeps of it can't both write, and a keep refused past this
// point leaves it used: the agent proposes again, which makes a new offer. At the prompt the user allowed one call with
// the input they saw, so the call is spent before any check and the offer claimed before its lines are compared: a
// refused keep can't be run again, from the tool or a shell, with other lines. By a code, lines that don't match leave
// the offer pending, so the agent can pass the right ones.
function keep(sid, input, call) {
  const entry = sessionOf(sid);
  const p = input();
  const prompted = consentOf(entry) === 'prompt';
  if (prompted && !useCall(call, { session: String(sid), tool: 'keep', offer: typeof p.id === 'string' ? p.id : null, input: p })) {
    refuse("keep writes only from the vault's `keep` tool once the user allows it at the prompt; a shell run can't keep this session's offers.");
  }
  const unknown = Object.keys(p).find(k => !FIELDS.some(f => f.name === k));
  if (unknown) refuse(`${unknown} isn't a field keep.mjs takes. The \`keep\` tool's schema lists the fields.`);
  const id = line(p, 'id');
  if (typeof p.offer !== 'string' || !p.offer.trim()) refuse('offer is missing: pass the lines the offer was returned with.');
  const o = readOffer(id);
  if (!o || o.session !== String(sid)) refuse(`there's no offer \`${id}\` in this session. Propose it again.`);
  if (o.state !== 'pending') refuse(notPending(o));
  if (prompted && !claimOffer(id)) refuse(notPending(readOffer(id) ?? o));
  if (p.offer.replace(/\r\n?/g, '\n').trimEnd() !== o.text) {
    refuse(prompted
      ? `offer isn't the text propose returned for \`${id}\`, so the user didn't agree to what keep would write. Propose it again.`
      : `offer isn't the text propose returned for \`${id}\`. Pass its lines exactly.`);
  }
  let kept = { consent: 'prompt' };
  if (!prompted) {
    const why = codeConsent(entry, o);
    if (why) refuse(why);
    kept = { consent: 'code', approved: typedFor(entry)[o.typed] };
    if (!claimOffer(id)) refuse(notPending(readOffer(id) ?? o));
  }
  Object.assign(kept, { text: o.text, code: o.code });
  const out = o.kind === 'domain' ? addDomain(sid, o.fields, { kept, mainWorktree })
    : o.kind === 'mode' ? setMode(sid, o.fields, { kept })
    : proposeRule(sid, o.fields, { kept });
  keptOffer(id);
  return out;
}

const args = process.argv.slice(2);
try {
  const variant = schemaArg(args);
  if (variant) console.log(JSON.stringify(schemaOf(SUMMARY[variant], FIELDS)));
  else if (args[0] === '--help' && args.length === 1) console.log(help());
  else if (args.length > 2) throw new UsageError();
  else console.log(keep(args[0] ?? currentSession()?.id, readInput, args[1] ?? null));
} catch (e) {
  const f = failure(e, 'keep', USAGE, 'Not kept');
  console.error(f.message);
  process.exitCode = f.code;
}
