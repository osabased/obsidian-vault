---
name: taste-review
description: "Check up on the agent-taste vault: lint findings and hook errors, and the fixes for them."
disable-model-invocation: true
---

# Taste review

Work in the vault root. AGENTS.md has the note format. A rule applies as soon as its note is written, so a review changes the notes themselves.

1. Run `node tools/review.mjs status`, and tell the user its lint tally and any hook errors, quoting the newest.
2. Run `node tools/build.mjs`, then `node tools/lint.mjs`. For each error and each warning, say what it means and the fix you propose. Name the rules with an empty **Because:** in one line; only the user can give their reason.
   - A rule that index.md marks `not delivered` reaches no session until its error is fixed.
   - Fix frontmatter, links and generated files yourself. Change a rule's Do, Not or Because, or delete a note, only once the user says yes.
3. Run `node tools/lint.mjs` again. Done when it shows no errors and the user has answered each change you proposed to a rule.
