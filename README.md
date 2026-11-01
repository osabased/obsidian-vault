# obsidian-vault

A taste vault for Claude Code, based on Andrej Karpathy's LLM wiki pattern: a small wiki of the user's preferences, written as rules the agent gets back in later sessions. `AGENTS.md` describes the layout and the note formats.

## Plugin

The repo is also a Claude Code plugin with two skills and the hooks:

- `/obsidian-vault:ingest` goes through a source with you, a file or a URL whose text it saves, and turns it and what you say about it into pages and rules. `/obsidian-vault:ingest batch` takes in every file in `raw/refs/` no source page names yet, and asks before adding any rule.
- `/obsidian-vault:lint` checks the whole wiki and proposes fixes.
- The hooks deliver the rules and pages to your sessions. `hooks/hooks.json` starts SessionStart, UserPromptSubmit, PreToolUse (edits), Stop and SubagentStart through `hooks/launch.mjs`, which runs the hook from your vault.

```
claude plugin marketplace add osabased/obsidian-vault
claude plugin install obsidian-vault@obsidian-vault --config vault=<path to your vault checkout>
```

The plugin has one option, `vault`, the folder of your vault checkout. To set or change it later, run `claude plugin configure obsidian-vault` to see the option, or save it with `echo '{"vault":"<path>"}' | claude plugin configure obsidian-vault --values-stdin`. An unset option, a relative path, a vault with no `.live/tools/` or a hook that cannot load prints `vault <hook> failed: <why>` as a hook error, and the call goes ahead.

The skills run this vault's `tools/` in the working folder, so open a checkout of the vault before using them. If `settings.json` still holds the vault's hooks from before the plugin, remove them, or each hook runs twice.

## Hooks

Sessions run the hooks from `.live/tools/`, a copy of `tools/` as of the last commit, so a half-made change to `tools/` never runs in a session. In a checkout of the vault, turn on the git hooks and make the first copy:

```
git config core.hooksPath .githooks
.githooks/post-commit
```

`pre-commit` runs the tests, rebuilds the generated files and lints. `post-commit` refreshes `.live/tools/` after each commit, and the other hooks run it after a checkout, merge or rebase. A domain reaches projects by the `markers` in `vault.config.json`, or by this machine's folders, which go in the untracked `vault.local.json` as `{ "domains": { "<domain>": { "paths": ["<absolute folder>"] } } }`.
