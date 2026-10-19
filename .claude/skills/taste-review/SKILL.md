---
name: taste-review
description: Review captured preferences in the agent-taste vault, turn them into rule notes, and list the rules ready to confirm.
disable-model-invocation: true
---

# Taste review

Work in the vault root. AGENTS.md has the note format and the evidence rules.

1. Run `node tools/review.mjs status`, `node tools/review.mjs pending` and `node tools/review.mjs picks`.
2. Group the pending captures by the preference they express. Open a capture's transcript only when its quote is unclear without context.
3. Look through the pending picks for leanings: the user choosing the same kind of option across questions. Count the sessions behind each leaning.
4. For each group, propose one of:
   - a new provisional note, with its Do, Not and Because drafted;
   - new evidence for an existing note;
   - dismissing it, when it's a one-off task instruction or noise.

   Propose a note from picks alone only once the same leaning shows up in picks from 3 sessions, with `basis: inferred`. Picks can always add evidence to an existing note. Their evidence lines use kind `choice`, the pick's words and its `q-` id, like `- 2026-10-19 · choice · session 1a2b3c4d · "Dark slate" for "Header color?" (q-1a2b3c4d)`. Leave picks with no leaning yet pending; they count toward a later review.

   Put all the proposals to the user in one batch, with the quotes and picks, and wait for their answers.
5. Apply the answers. Write or update the notes, then record each group with `node tools/review.mjs resolve <id>,<id> --note <domain>/<slug>` or `node tools/review.mjs resolve <id> --dismiss "<reason>"`. Capture ids (`c-`, `p-`) and pick ids (`q-`) work the same way, and resolved ones stop showing.
6. For each note that status lists as changed since confirmed, show the confirmed wording next to the current one and ask whether to keep the change.
7. Run `node tools/build.mjs` and `node tools/lint.mjs`, and fix any errors.
8. End with the exact lines the user can type, one per line: `confirm: <domain>/<slug>` for rules to enforce, and `retire: <domain>/<slug>` for rules they want dropped.
