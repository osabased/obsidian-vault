import { parseNote, agentNotesSpan, AGENT_NOTES, TOP_HEADING, wroteByUser } from './rules.mjs';

// The checks the edit hook and a page offer share: what a change may do to a page the user wrote, and to a rule.

const headingLine = l => TOP_HEADING.test(l);

// A page the user wrote may gain lines under `## Agent notes`, or that heading with lines at its end, and nothing else.
// Lines added without a heading in the way are the same text wherever the diff puts them, so any placement inside the
// section is enough. Added lines can still move where the section ends, as an unclosed fence does, so the section must
// end after the edit where it ended before.
function bodyNotesAdded(before, after) {
  const [b, a] = [before, after].map(s => s.split('\n'));
  const span = agentNotesSpan(b);
  const now = agentNotesSpan(a);
  if (!span) {
    if (!after.startsWith(before)) return false;
    const rest = after.slice(before.length);
    const gap = rest.match(/^\n*/)[0];
    if (!gap && before && !before.endsWith('\n')) return false;
    const [first, ...added] = rest.slice(gap.length).split('\n');
    const at = a.length - added.length - 1;
    return AGENT_NOTES.test(first) && added.some(l => l.trim()) && !added.some(headingLine) && now?.at === at && now.end === a.length;
  }
  if (a.length < b.length || now?.at !== span.at || a.length - now.end !== b.length - span.end) return false;
  let head = 0;
  while (head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < b.length && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  if (head + tail < b.length) return false;
  const at = Math.max(span.at + 1, b.length - tail);
  return at <= Math.min(span.end, head) && !a.slice(at, at + a.length - b.length).some(headingLine);
}

// A frontmatter line can read as a heading or a fence, so the section is found in the body, and the frontmatter must
// stay as it was.
const frontmatter = (text, note) => (note.ok ? text.slice(0, text.length - note.body.length).replace(/\n$/, '') : '');
const onlyNotesAdded = (before, after, was, now) => frontmatter(before, was) === frontmatter(after, now) && bodyNotesAdded(was.body, now.body);

export const usersOwn = rel => `${rel} is the user's own writing, so it stays as they wrote it. Add notes as new lines under ## Agent notes, and change nothing else in the file.`;

// was and now are the parsed before and after, for a caller that has them already. A before of null passes as '' with a
// was of null.
export function userNoteGuard(rel, before, after, was = parseNote(before, rel), now = parseNote(after, rel)) {
  if (wroteByUser(now) && !wroteByUser(was)) {
    return `${rel} would be marked author: user. The user sets author: user themselves; the agent doesn't make a page theirs.`;
  }
  if (!wroteByUser(was) || after === before || onlyNotesAdded(before, after, was, now)) return null;
  return usersOwn(rel);
}

// The text of a file before and after an edit, with each parsed: before is null for a new file, and after null when the
// change can't be followed.
export const changeOf = (rel, before, after) => ({
  before,
  after,
  was: before === null ? null : parseNote(before, rel),
  now: after === null ? null : parseNote(after, rel),
});

// What the user agrees to when a rule is kept: its frontmatter and its Do, Not and Because. Lines added elsewhere, as
// Evidence is, change neither. A change that can't be followed counts as a change to a rule.
export function ruleChange(rel, { before, after, was, now }) {
  if (after === null) return was?.type === 'rule' ? 'changed' : before === null && /^wiki\/[^/]+\/rules\/[^/]+\.md$/i.test(rel) ? 'new' : null;
  if (was?.type !== 'rule') return now.type === 'rule' ? 'new' : null;
  const same = frontmatter(before, was) === frontmatter(after, now) && ['do', 'not', 'because'].every(k => was[k] === now[k]);
  return same ? null : 'changed';
}
