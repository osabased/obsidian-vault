import fs from 'node:fs';
import { config, vaultPath, plural, toPosix } from './lib/vault.mjs';
import { clip, normTopic, topicNotes } from './lib/rules.mjs';
import { lint, tally } from './lib/lint.mjs';

const USAGE = 'usage: node tools/review.mjs status';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

class UsageError extends Error {}

function lintLine() {
  try {
    return `Lint: ${tally(lint())}`;
  } catch (e) {
    return `Lint: failed: ${e.message}`;
  }
}

function hookHealth() {
  const file = vaultPath('.state', 'errors.log');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const errors = text.split(/\r?\n/).filter(l => ISO.test(l));
  return errors.length ? [`${plural(errors.length, 'hook error')} in ${toPosix(file)}`, `  newest: ${clip(errors.at(-1), 300)}`] : ['No hook errors.'];
}

function emptyTopics() {
  try {
    const used = topicNotes();
    const lines = Object.entries(config().domains).flatMap(([d, c]) => {
      const empty = (c.topics ?? []).filter(t => !used.get(d)?.has(normTopic(t)));
      return empty.length ? [`${d}: ${empty.join(', ')}`] : [];
    });
    return lines.length ? lines : ['None.'];
  } catch (e) {
    return [`failed: ${e.message}`];
  }
}

const status = () => [lintLine(), '', 'Hook health', ...hookHealth(), '', 'Listed topics no rule has yet', ...emptyTopics()].join('\n');

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'status' && !rest.length) console.log(status());
  else throw new UsageError();
} catch (e) {
  if (e instanceof UsageError) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    console.error(`review failed: ${e.message}`);
    process.exitCode = 1;
  }
}
