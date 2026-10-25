---
name: lint
description: "Check the whole agent-taste wiki: lint findings, hook errors, contradictions, repeats, empty topics and stale pages, and the fixes for them."
disable-model-invocation: true
---

# Lint

Work in the vault root. AGENTS.md has the note and page formats. A rule applies as soon as its note is written, so fixing the wiki changes the notes themselves.

1. **Status.** Run `node tools/review.mjs status`, which also records this run, quieting the session-start error line and reminder. Tell the user its lint tally, any hook errors, quoting the newest, and the listed topics no rule has yet: taste not captured, not a fault.
2. **Lint.** Run `node tools/build.mjs`, then `node tools/lint.mjs`. For each error and warning, say what it means and the fix you propose. Name the rules with an empty **Because:** in one line; only the user can give their reason.
   - A rule that index.md marks `not delivered` reaches no session until its error is fixed.
   - A topic page lint calls stale needs rereading against the rule that changed.
3. **Read the wiki.** Read `index.md`, then every rule and page, a domain at a time, and find what lint can't see:
   - rules that contradict each other, in one domain or between a domain and global;
   - rules that say the same thing;
   - topic pages that no longer match their rules, and topics with two topic pages;
   - rules on a topic whose topic page doesn't link them.
4. **Fix.** Fix frontmatter, links, summaries, topic pages and generated files yourself, and log each page you change with `node tools/log.mjs wiki/<domain>/<slug>.md`. For contradictions, show the user both rules and let them decide. Change a rule's Do, Not or Because, or delete a note, only once the user says yes.
5. Run `node tools/lint.mjs` again. Done when it shows no errors, each finding from step 3 is fixed or put to the user, and the user has answered each change you proposed to a rule.
