import { domainTopics, maxChars } from './lib/rules.mjs';
import { proposeRule } from './lib/propose-rule.mjs';
import { UsageError, readInput, failure, renderHelp, schemaOf, schemaArg } from './lib/input.mjs';
import { currentSession } from './lib/agents.mjs';
import { readCall } from './lib/calls.mjs';
import { mainWorktree } from './lib/git.mjs';

const RUN = 'usage: node tools/propose.mjs [session-id] [call-id] < rule.json';
const USAGE = `${RUN}\n       node tools/propose.mjs --help lists the fields of rule.json`;

const topicLines = () => [...domainTopics()].flatMap(([d, topics]) => (topics.length ? [`  ${d}: ${topics.join(', ')}`] : []));

const S = 'string';
const row = (label, help, indent) => ({ label, help, ...(indent && { indent }) });

const fields = () => [
  { name: 'domain', type: S, help: ["this session's domain (in the vault folder, any domain that isn't vaultOnly), or global for every project;", 'a session in a folder no domain reaches proposes to global only'] },
  { name: 'slug', type: S, help: ['lowercase-kebab-case'] },
  { name: 'kind', type: S, enum: ['taste', 'practice', 'knowledge'], help: ['"taste": how something should look or feel to a person: visual design, copy, game feel;', '"practice": how the agent should work: planning, building, testing, reviewing, answering;', '"knowledge": a fact about an API, version or tool that your training gets wrong or doesn\'t know'] },
  { name: 'do', type: S, label: 'do, not', help: [`one line each. Do, Not and Because, with their labels, come to at most ${maxChars('practice')} characters;`, `a knowledge rule's, with its as_of date, at most ${maxChars('knowledge')}`] },
  { name: 'not', type: S },
  { name: 'because', type: S, help: ["the user's reason, or for knowledge the cause; empty rather than invented"] },
  { name: 'topic', type: S, help: ["a short topic; reuse one the domain's rules or pages have, or one of its listed topics:", ...topicLines()] },
  { name: 'basis', type: S, enum: ['stated', 'inferred', 'pick', 'reading', 'failure', 'source'], help: ['and what to cite for it, written into the note as given:'] },
  row('stated', ["the user's words state the rule. quote: their words, as they typed them in this session", 'page: instead of a session, the vault path of a page of the user\'s own, one with author: user,', 'like wiki/<domain>/<folder>/<slug>.md. quote: their words on that page; propose.mjs refuses one it', "doesn't hold. The page's frontmatter and its ## Agent notes aren't the user's words."], 2),
  row('inferred', ['taste and practice only: you generalized a correction. quote: the words you generalized, as the user typed them', 'A quote may leave words out with …; propose.mjs refuses one the user never typed in this session.'], 2),
  row('pick', ["taste and practice only: the user's recorded answer from an earlier session backs the rule.", 'pick: the id of a row in raw/picks/ (q-).', "The row's own words are cited; a row backs one rule. A provisional, replaced or confirmed pick backs none."], 2),
  row('reading', ['taste and practice only: your own reading of what you saw, labelled as yours. reading: what you saw, in one line'], 2),
  row('failure', ['knowledge only: something worked only after a failure.', 'error: one line of the error as it was printed', 'fix: what fixed it, in one line', 'file: the file you fixed, from the project root'], 2),
  row('source', ['knowledge only: a dated source shows it.', 'source: its URL, or a file under raw/refs/', 'source_date: when the source was published or last updated, as YYYY-MM-DD', "quote: the source's words; propose.mjs refuses one a text file under raw/refs/ doesn't hold"], 2),
  ...['quote', 'page', 'pick', 'reading', 'error', 'fix', 'file', 'source', 'source_date'].map(name => ({ name, type: S, describe: 'see basis' })),
  { name: 'keywords', type: 'string[]', help: ['words a request about it would use'] },
  { name: 'applies_to', type: 'string[]', help: ['globs from the project root; give them to a rule about code or files'] },
  { name: 'triggers', type: 'string[]', help: ['regexes tested against the new text of an edit; when given, the rule applies only if one matches', 'A rule needs keywords or applies_to.', "always: true is the user's to set in Obsidian, so propose.mjs refuses it."] },
  { name: 'always', type: 'boolean', describe: 'see triggers' },
  { name: 'repeats', type: S, help: ['optional, the key of the rule in the vault this one repeats, like example-ui/flat-buttons:', "propose.mjs adds this rule's Evidence line to that note and writes no new one"] },
  { name: 'asked', type: S, help: ["the user's words asking you to keep the rule, as they typed them in their latest message. Needed outside", 'the vault folder when proposals is off for the domain.'] },
  { name: 'hold', type: 'boolean', help: ['true holds the offer until you release it'] },
  { name: 'release', type: 'boolean', help: ['true, alone: returns every offer this session holds'] },
  { name: 'queued', type: S, help: ['the id of a review queue entry (u-) to offer again; besides it, only asked, and repeats or slug for a rule entry'] },
  { name: 'text', type: S, help: ["with page: a page change, the page's whole new text. Always an offer. A text that adds open: true", 'asks the user to let agents write that page directly'] },
  { name: 'package', type: S, help: ['knowledge only: the library the rule is about, as ecosystem/name like npm/react'] },
  { name: 'change', type: S, label: 'change, key', enum: ['reword', 'retire', 'move'], help: ["with the rule's key. reword replaces the do, not, because, applies_to, keywords, kind, topic or checked_with you", 'give and needs a basis like a new rule, unless it gives checked_with alone; a knowledge rule keeps its kind; retire takes because and', 'superseded_by; move takes domain'] },
  ...['key', 'superseded_by', 'checked_with'].map(name => ({ name, type: S, describe: 'see change' })),
];

const help = () => renderHelp([RUN, '', 'rule.json is an object with these fields:'], fields(), [
  '',
  'If the rule may repeat ones in the vault, propose.mjs lists them and refuses once. If it repeats one, propose',
  'it again with repeats set to that rule; if not, propose it again as it is.',
  '',
  "A knowledge rule's as_of is set for you: the source_date for a source, the day it was first proposed otherwise. With repeats, it moves up when that day is later.",
], 13);

const SUMMARY = {
  prompt: "Proposes a taste, practice or knowledge rule to the vault, or new evidence for a rule it has. Under corrections a project session's unheld rule is written at once; anything else returns an offer to pass to `keep`, and nothing is written until the user allows it. A subagent's proposals go to the review queue.",
  code: "Proposes a taste, practice or knowledge rule to the vault, or new evidence for a rule it has. Under corrections a project session's unheld rule is written at once; anything else returns an offer to end your reply with, which `keep` writes once the user's next message has its code. A subagent's proposals go to the review queue.",
};

const args = process.argv.slice(2);
try {
  const variant = schemaArg(args);
  if (variant) console.log(JSON.stringify(schemaOf(SUMMARY[variant], fields())));
  else if (args[0] === '--help' && args.length === 1) console.log(help());
  else if (args.length > 2) throw new UsageError();
  else {
    // A subagent's user is its caller, who can't answer the prompt, so its rules wait in the queue for the user.
    const queueAs = readCall(args[1])?.subagent
      ? { why: 'unattended', unattended: 'subagent', reply: id => `Queued \`${id}\` for the user's review; nothing is written. Tell your caller what you queued.` }
      : null;
    console.log(proposeRule(args[0] ?? currentSession()?.id, readInput, { queueAs, mainWorktree }));
  }
} catch (e) {
  const f = failure(e, 'propose', USAGE, 'Not proposed');
  console.error(f.message);
  process.exitCode = f.code;
}
