import { setMode } from './lib/set-mode.mjs';
import { UsageError, readInput, failure, renderHelp, schemaOf, schemaArg } from './lib/input.mjs';
import { currentSession } from './lib/agents.mjs';

const RUN = 'usage: node tools/proposals.mjs [session-id] [call-id] < mode.json';
const USAGE = `${RUN}\n       node tools/proposals.mjs --help lists the fields of mode.json`;

const FIELDS = [
  { name: 'mode', type: 'string', required: true, enum: ['corrections', 'ask', 'off'], help: ['corrections: propose writes a rule as soon as the agent proposes it', 'ask: the agent offers each rule, and keep writes it once the user agrees', 'off: the agent proposes a rule only when the user asks for one'] },
  { name: 'domain', type: 'string', help: ['optional, a domain to give a mode of its own; without it, or with global, the mode for global and', 'every domain without one of its own'] },
];

const help = () => renderHelp([RUN, '', 'Sets when agents propose rules, in vault.config.json. mode.json is an object with these fields:'], FIELDS, [
  '',
  'A session in the vault folder proposes as in corrections whatever the mode, since /ingest goes through each rule with',
  'the user.',
], 11);

const SUMMARY = {
  prompt: 'Sets when agents propose rules to the taste vault: corrections, ask or off, for every project or one domain. Call it only when the user asks; they allow or deny the change at the prompt.',
  code: "Sets when agents propose rules to the taste vault: corrections, ask or off, for every project or one domain. Call it only when the user asks. It returns an offer to end your reply with, which `keep` writes once the user's next message has its code.",
};

const args = process.argv.slice(2);
try {
  const variant = schemaArg(args);
  if (variant) console.log(JSON.stringify(schemaOf(SUMMARY[variant], FIELDS)));
  else if (args[0] === '--help' && args.length === 1) console.log(help());
  else if (args.length > 2) throw new UsageError();
  else console.log(setMode(args[0] ?? currentSession()?.id, readInput, { call: args[1] ?? null }));
} catch (e) {
  const f = failure(e, 'proposals', USAGE, 'Not set');
  console.error(f.message);
  process.exitCode = f.code;
}
