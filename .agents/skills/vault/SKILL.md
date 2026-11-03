---
name: vault
description: "Set when agents propose rules to the taste vault: corrections, ask or off, for every project or one domain, and show what the vault does in this session. Use when the user runs /vault, asks you to stop, start or ask before keeping rules, or asks what the vault has shown this session."
argument-hint: "[status|corrections|ask|off] [domain]"
---

# Vault

The `proposals` setting in the vault's `vault.config.json` says when agents propose rules:

- `corrections`: an agent writes a rule as soon as the user corrects it or says how they want things.
- `ask`: an agent offers each rule, and writes it once the user agrees. This is the default when `proposals` is unset.
- `off`: an agent proposes a rule only when the user asks it to keep one.

A domain may set its own `proposals`, which wins over the top-level one for that domain's rules. Rules to `global` take the top-level one. Sessions in the vault folder, such as `/ingest` and `/lint`, propose as in `corrections` whatever the mode, since they go through each rule with the user.

For `/vault status`, or when the user asks what the vault does in this session, run `node "<tools>/status.mjs" <session-id>` with the `status.mjs` beside the `proposals.mjs` your session-start note names and the session id it passes; in the vault folder, run `node tools/status.mjs`. Show the user the lines it prints and stop there.

1. **Mode.** Take the mode from the user's words: `/vault off`, or "ask me before you keep a rule". When they name none, tell them the modes now set, read from `vault.config.json` in the vault folder (the folder holding the `.live/` your session-start note's `proposals.mjs` sits in), list the three modes in one line each, and ask which they want. Stop there; their answer is the next message.
2. **Scope.** The mode is for every project unless the user names a domain, or says "here" or "this project", which means the domain the session-start note proposes to. When that is more than one domain, ask which.
3. **Set it.** Pipe `{"mode": "<mode>", "domain": "<domain>", "approved": "<their words>"}` to the `proposals.mjs` your session-start note names, the same way you pipe to `propose.mjs`; in the vault folder, pipe it to `node tools/proposals.mjs`. Leave `domain` out for every project. `approved` is the user's words asking for the change, from their latest message, such as `off` from `/vault off`. On a refusal, tell the user what it says.
4. **Report.** End your reply with the line it prints.
