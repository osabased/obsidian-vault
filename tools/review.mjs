import { config, plural, toPosix, guarded, hookErrors, errorsLog } from './lib/vault.mjs';
import { clip, normTopic, topicNotes } from './lib/rules.mjs';
import { lint, tally } from './lib/lint.mjs';
import { lintRan } from './lib/sessions.mjs';

const USAGE = 'usage: node tools/review.mjs status';

class UsageError extends Error {}

function lintLine() {
  try {
    return `Lint: ${tally(lint())}`;
  } catch (e) {
    return `Lint: failed: ${e.message}`;
  }
}

function hookHealth() {
  const errors = hookErrors();
  if (!errors.length) return ['No hook errors.'];
  const { at, message } = errors.at(-1);
  return [`${plural(errors.length, 'hook error')} in ${toPosix(errorsLog())}`, `  newest: ${clip(`${at} ${message}`, 300)}`];
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
  if (cmd !== 'status' || rest.length) throw new UsageError();
  console.log(status());
  // /lint runs status first, so this is what quiets the session-start error line and reminder. A failed stamp is
  // logged, and session start reports it.
  guarded('lint stamp', lintRan);
} catch (e) {
  if (e instanceof UsageError) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    console.error(`review failed: ${e.message}`);
    process.exitCode = 1;
  }
}
