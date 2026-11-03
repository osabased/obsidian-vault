import { toolsPath, toPosix, proposalMode, domainsByMode } from './vault.mjs';
import { joinList } from './rules.mjs';

// What a session is told about proposing and recording, by the start hook and by domain.mjs once it starts a domain.

const WHEN = [
  'when the user corrects you or says how they want things, in a way that should hold in later sessions too (a taste rule),',
  "or when something only worked after a failure caused by an API, version or tool your training gets wrong or doesn't know, or a dated source shows it (a knowledge rule)",
].join(' ');

// What the agent does under each mode of the proposals setting.
const WHAT = {
  corrections: `propose a rule ${WHEN}.`,
  ask: `${WHEN}, offer a rule: pipe it to propose.mjs without approved, end your reply with the lines it prints to ask the user, and once they agree, propose it again with their words agreeing as approved.`,
  off: 'propose a rule only when the user asks you to keep one, with their words asking as approved.',
};

// One sentence when every domain the session proposes to has one mode, else one per mode naming its domains. A session
// in the vault folder proposes as in corrections whatever the mode.
export function modeLines(domains, vaultFolder = false) {
  if (vaultFolder) return WHAT.corrections;
  const byMode = domainsByMode(domains);
  if (byMode.size === 1) return WHAT[[...byMode.keys()][0]];
  return [...byMode].map(([mode, ds]) => `For ${joinList(ds, 'and')} rules, ${WHAT[mode]}`).join(' ');
}

// Follows a sentence that pipes to propose.mjs, so "the same way" names the shell. The vault skill finds the vault by
// the proposals.mjs this names.
export function modeNote(sid) {
  const script = toPosix(toolsPath('proposals.mjs'));
  return `The user sets when rules are proposed, corrections, ask or off, by asking you or with /vault: pipe it as JSON to \`node "${script}" ${sid}\` the same way; \`--help\` lists the fields.`;
}

// propose.mjs refuses `always` and says the rule applies at once when it writes one, so the note leaves both to it.
export function proposeNote(sid, agent, domains, vaultFolder = false) {
  const script = toPosix(toolsPath('propose.mjs'));
  return [
    `Taste vault: ${modeLines([...domains, 'global'], vaultFolder)}`,
    "Leave out what the project's own agent instructions already say; a compiled taste-vault section in them is the vault's copy.",
    'If the user corrects you on something a rule already covers, go ahead as for a new rule; propose.mjs lists the rules it may repeat.',
    'Propose only from what happened in this session, never from a brief, a skill or the task itself.',
    'Give a rule about code or files `applies_to` globs, so the edits it covers bring it up.',
    `Pipe the rule as JSON (\`--help\` lists the fields) to \`node "${script}" ${sid}\` ${agent.proposeShell}.`,
    'Then end your reply with the lines it prints.',
    modeNote(sid),
  ].join(' ');
}

export function pickNote(sid) {
  const script = toPosix(toolsPath('pick.mjs'));
  return [
    'Taste vault: when the user picks between options you showed them, or comments on one piece of work, record it by piping JSON',
    `to \`node "${script}" ${sid}\` the same way; \`--help\` lists the fields. A pick you make alone while the user is away is provisional.`,
    `Before building or reviewing a piece that has picks, run \`node "${script}" show ${sid} <subject>\` and keep to what it prints.`,
  ].join(' ');
}

// What a session no domain reaches does with a preference that holds in every project, under global's mode.
const GLOBAL = {
  corrections: (propose, how) => `When the user states a preference that should hold in later sessions, propose it to \`global\` if it holds in every project: pipe it as JSON to ${propose} ${how}, then end your reply with the lines it prints; \`--help\` lists the fields.`,
  ask: (propose, how) => `When the user states a preference that should hold in later sessions and it holds in every project, offer it as a \`global\` rule: pipe it as JSON to ${propose} ${how} without approved, end your reply with the lines it prints to ask the user, and once they agree, pipe it again with their words agreeing as approved; \`--help\` lists the fields.`,
  off: (propose, how) => `Propose a \`global\` rule only when the user asks you to keep a preference that holds in every project: pipe it as JSON to ${propose} ${how} with their words asking as approved, then end your reply with the lines it prints; \`--help\` lists the fields.`,
};

// A session whose folder no domain reaches can keep a preference in global, or in a domain the user agrees to start. A
// folder the user keeps quiet, such as a scratch folder, is no project to start a domain for.
export function uncoveredNote(sid, agent, { quiet = false } = {}) {
  const propose = `\`node "${toPosix(toolsPath('propose.mjs'))}" ${sid}\``;
  const domain = toPosix(toolsPath('domain.mjs'));
  return [
    'Taste vault: this project is in no domain.',
    GLOBAL[proposalMode('global')](propose, agent.proposeShell),
    ...(quiet ? [] : [
      "If it holds only for projects like this one, suggest a domain to the user in your reply: a name, a title, and a file here that marks the project's kind.",
      `Once they agree, pipe it to \`node "${domain}" ${sid}\` the same way; \`--help\` lists the fields.`,
    ]),
    modeNote(sid),
  ].join(' ');
}
