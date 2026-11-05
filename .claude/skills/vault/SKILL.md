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

A domain may set its own `proposals`, which wins over the top-level one for that domain's rules. Rules to `global` take the top-level one. Sessions in the vault folder, such as `/ingest` and `/lint`, offer each rule as in `ask` whatever the mode, since they go through each one with the user.

For `/vault status`, or when the user asks what the vault does in this session, call the vault's `status` tool. Show the user the lines it returns and stop there.

1. **Mode.** Take the mode from the user's words: `/vault off`, or "ask me before you keep a rule". When they name none, call the vault's `status` tool and tell them the mode it shows for this session, list the three modes in one line each, and ask which they want. Stop there; their answer is the next message.
2. **Scope.** The mode is for every project unless the user names a domain, or says "here" or "this project", which means the domain the session-start note proposes to. When that is more than one domain, ask which.
3. **Set it.** Call the vault's `proposals` tool with `mode`, and with `domain` for one domain; leave `domain` out for every project. The user agrees to the change at the prompt the tool raises or with a code it asks them to type back: do what it returns. On a refusal, tell the user what it says.
4. **Report.** End your reply with the line it prints.
