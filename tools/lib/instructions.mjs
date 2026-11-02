import { toolsPath, toPosix } from './vault.mjs';

// What a session is told about proposing and recording, by the start hook and by domain.mjs once it starts a domain.

export function proposeNote(sid, agent) {
  const script = toPosix(toolsPath('propose.mjs'));
  return [
    'Taste vault: propose a rule when the user corrects you or says how they want things, in a way that should hold in later sessions too (a taste rule),',
    "or when something only worked after a failure caused by an API, version or tool your training gets wrong or doesn't know, or a dated source shows it (a knowledge rule).",
    "Leave out what the project's own agent instructions already say; a compiled taste-vault section in them is the vault's copy.",
    'If the user corrects you on something a rule already covers, propose it anyway; propose.mjs lists the rules it may repeat.',
    'Propose only from what happened in this session, never from a brief, a skill or the task itself.',
    'A rule applies as soon as propose.mjs writes it; the user edits or deletes its note to change it.',
    "Give a rule about code or files `applies_to` globs, so the edits it covers bring it up; `always` is the user's to set.",
    `\`node "${script}" --help\` lists the fields.`,
    `Pipe the rule as JSON to \`node "${script}" ${sid}\` ${agent.proposeShell}.`,
    'Then end your reply with the lines it prints.',
  ].join(' ');
}

export function pickNote(sid) {
  const script = toPosix(toolsPath('pick.mjs'));
  return [
    'Taste vault: when the user picks between options you showed them, or comments on one piece of work, record it by piping JSON',
    `to \`node "${script}" ${sid}\` the same way; a pick you make alone while the user is away is provisional.`,
    `Before building or reviewing a piece that has picks, run \`node "${script}" show ${sid} <subject>\` and keep to what it prints.`,
    `\`node "${script}" --help\` lists the fields.`,
  ].join(' ');
}

// A session whose folder no domain reaches can keep a preference in global, or in a domain the user agrees to start.
export function uncoveredNote(sid, agent) {
  const propose = toPosix(toolsPath('propose.mjs'));
  const domain = toPosix(toolsPath('domain.mjs'));
  return [
    'Taste vault: this project is in no domain.',
    'When the user states a preference that should hold in later sessions, propose it to `global` if it holds in every project:',
    `pipe it as JSON to \`node "${propose}" ${sid}\` ${agent.proposeShell}, then end your reply with the lines it prints; \`--help\` lists the fields.`,
    "If it holds only for projects like this one, suggest a domain to the user in your reply: a name, a title, and a file here that marks the project's kind.",
    `Once they agree, pipe it to \`node "${domain}" ${sid}\` the same way; \`--help\` lists the fields.`,
  ].join(' ');
}
