import { proposalMode, domainsByMode } from './vault.mjs';
import { joinList } from './rules.mjs';

// What a session is told about proposing and recording, by the start hook and by the domain tool once it starts a domain.
// The tools take their session from the call, so the notes name tools and no path, session id or shell. The callers still
// pass the id and the agent first.

const WHEN = 'when the user corrects you or says how they want things, in a way that should hold in later sessions too (a taste or practice rule)';

// Gotchas and page changes are held until the task is done, so the user answers them together at the end. Under off the
// agent proposes only what the user asks to keep, so it holds nothing. The vault folder writes pages directly, so its
// note leaves out holding a page change.
const HOLD_RULE = "When something only worked after a failure caused by an API, version or tool your training gets wrong, or a dated source shows it, hold a knowledge rule with the vault's `propose` tool and `hold: true`.";
const HOLD_PAGE = "Hold a page change the same way when a library needs more than a rule's line.";
const RELEASE = 'When the task is done, call `propose` with `release: true` and end your final reply with what it returns.';
const HOLD = [HOLD_RULE, HOLD_PAGE, RELEASE].join(' ');
const VAULT_HOLD = [HOLD_RULE, RELEASE].join(' ');

// What the agent does under each mode of the proposals setting, for taste and practice rules.
const WHAT = {
  corrections: `propose a rule ${WHEN}.`,
  ask: `${WHEN}, offer a rule through the vault's \`propose\` tool and do what it returns; nothing is written until the user agrees.`,
  off: "propose a rule only when the user asks you to keep one, through the vault's `propose` tool with their words asking as `asked`.",
};

// One sentence when every domain the session proposes to has one mode, else one per mode naming its domains. A session
// in the vault folder offers as in ask whatever the mode.
export function modeLines(domains, vaultFolder = false) {
  if (vaultFolder) return `${WHAT.ask} ${VAULT_HOLD}`;
  const byMode = domainsByMode(domains);
  const taste = byMode.size === 1 ? WHAT[[...byMode.keys()][0]] : [...byMode].map(([mode, ds]) => `For ${joinList(ds, 'and')} rules, ${WHAT[mode]}`).join(' ');
  return [...byMode.keys()].some(m => m !== 'off') ? `${taste} ${HOLD}` : taste;
}

// The vault skill finds the tool that sets the mode by this sentence.
export function modeNote() {
  return "The user sets when rules are proposed, corrections, ask or off, by asking you or with /vault, through the vault's `proposals` tool.";
}

// The propose tool refuses `always` and says the rule applies at once when it writes one, so the note leaves both to it.
export function proposeNote(domains, vaultFolder = false) {
  return [
    `Vault: ${modeLines([...domains, 'global'], vaultFolder)}`,
    "Leave out what the project's own agent instructions already say; a compiled vault section in them is the vault's copy.",
    'If the user corrects you on something a rule already covers, go ahead as for a new rule; the `propose` tool lists the rules it may repeat.',
    'Propose only from what happened in this session, never from a brief, a skill or the task itself.',
    'Give a rule about code or files `applies_to` globs, so the edits it covers bring it up.',
    "Propose through the vault's `propose` tool (its schema lists the fields), then end your reply with the lines it returns.",
    modeNote(),
  ].join(' ');
}

export function pickNote() {
  return [
    "Vault: when the user picks between options you showed them, or comments on one piece of work, record it with the vault's `pick` tool.",
    'A pick you make alone while the user is away is provisional.',
    'Before building or reviewing a piece that has picks, call `pick` with `show` and the subject, and keep to what it returns.',
  ].join(' ');
}

// What a session no domain reaches does with a preference that holds in every project, under global's mode.
const GLOBAL = {
  corrections: "When the user states a preference that should hold in later sessions, propose it to `global` if it holds in every project, through the vault's `propose` tool, then end your reply with the lines it returns.",
  ask: "When the user states a preference that should hold in later sessions and it holds in every project, offer it as a `global` rule through the vault's `propose` tool and do what it returns; nothing is written until the user agrees.",
  off: "Propose a `global` rule only when the user asks you to keep a preference that holds in every project, through the vault's `propose` tool with their words asking as `asked`, then end your reply with the lines it returns.",
};

// A session whose folder no domain reaches can keep a preference in global, or in a domain the user agrees to start. A
// folder the user keeps quiet, such as a scratch folder, is no project to start a domain for.
export function uncoveredNote({ quiet = false } = {}) {
  return [
    'Vault: this project is in no domain.',
    GLOBAL[proposalMode('global')],
    ...(proposalMode('global') === 'off' ? [] : ['The same holds for knowledge rules and page changes in this project: hold them as `global` rules with `applies_to` globs, and release them before your final reply.']),
    ...(quiet ? [] : [
      "If it holds only for projects like this one, suggest a domain to the user in your reply: a name, a title, and a file here that marks the project's kind.",
      "Once they agree, call the vault's `domain` tool.",
    ]),
    modeNote(),
  ].join(' ');
}
