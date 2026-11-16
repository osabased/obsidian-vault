import { addDomain } from './lib/add-domain.mjs';
import { mainWorktree } from './lib/git.mjs';
import { UsageError, readInput, failure, renderHelp, schemaOf, schemaArg } from './lib/input.mjs';
import { currentSession } from './lib/agents.mjs';

const RUN = 'usage: node tools/domain.mjs [session-id] < domain.json';
const USAGE = `${RUN}\n       node tools/domain.mjs --help lists the fields of domain.json`;

const FIELDS = [
  { name: 'name', type: 'string', required: true, help: ["the domain's key, lowercase-kebab-case; not global, and not a domain the vault already has"] },
  { name: 'title', type: 'string', required: true, help: ['a short phrase on one line'] },
  { name: 'topics', type: 'string[]', help: ["the topics the domain's rules will have, a list of short strings"] },
  { name: 'marker', type: 'string', help: ['a file name, with no folder in it, that every project of the kind has, such as its manifest.', "This session's folder or a folder above it must hold it; the nearest that does is the project's root."] },
  { name: 'path', type: 'boolean', help: ["true, for a project no file marks: this session's project folder goes in vault.local.json, on this", 'machine only'] },
  { name: 'vaultOnly', type: 'boolean', help: ['true, from a session in the vault folder, for a domain that holds pages only', 'Give one of marker, path and vaultOnly.'] },
];

const help = () => renderHelp([RUN, '', 'domain.json is an object with these fields:'], FIELDS, [
  '',
  'Suggest the domain to the user in your reply and wait for their answer: an option they pick is your words, not theirs.',
], 13);

const SUMMARY = {
  prompt: 'Starts a vault domain for projects of one kind, once the user agrees to it. It returns an offer to pass to `keep`; nothing is written until the user allows it.',
  code: "Starts a vault domain for projects of one kind, once the user agrees to it. It returns an offer to end your reply with, which `keep` writes once the user's next message has its code.",
};

const args = process.argv.slice(2);
try {
  const variant = schemaArg(args);
  if (variant) console.log(JSON.stringify(schemaOf(SUMMARY[variant], FIELDS)));
  else if (args[0] === '--help' && args.length === 1) console.log(help());
  else if (args.length > 1) throw new UsageError();
  else console.log(addDomain(args[0] ?? currentSession()?.id, readInput, { mainWorktree }));
} catch (e) {
  const f = failure(e, 'domain', USAGE, 'Not added');
  console.error(f.message);
  process.exitCode = f.code;
}
