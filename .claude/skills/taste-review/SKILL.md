---
name: taste-review
description: "Check up on the agent-taste vault: rules changed since they were confirmed, provisional rules waiting for a confirm or drop, repeats of confirmed rules, lint and hook errors."
disable-model-invocation: true
---

# Taste review

Work in the vault root. AGENTS.md has the note format.

1. Run `node tools/review.mjs status`, and tell the user its lint tally, any hook errors, and any repeats of confirmed rules, saying which never reached the agent.
2. For each rule it lists as changed since confirmed, show the confirmed wording next to the current one and ask whether to keep the change. The hooks deliver the confirmed wording until the user confirms the rule again.
3. Run `node tools/build.mjs` and `node tools/lint.mjs`, and fix any errors.
4. End with the exact lines the user can type, one per line:
   - for each provisional rule, its Do line, then `confirm: <domain>/<slug>` and `drop: <domain>/<slug>`;
   - `confirm: <domain>/<slug>` for each changed rule whose change they keep;
   - `retire: <domain>/<slug>` for each confirmed rule they asked to drop.
