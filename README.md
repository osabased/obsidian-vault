# obsidian-vault

A taste vault for Claude Code, based on Andrej Karpathy's LLM wiki pattern: a small wiki of the user's preferences, written as rules the agent gets back in later sessions. `AGENTS.md` describes the layout and the note formats.

## Plugin

The repo is also a Claude Code plugin with two skills:

- `/obsidian-vault:ingest` goes through a source with you, a file or a URL whose text it saves, and turns it and what you say about it into pages and rules. `/obsidian-vault:ingest batch` takes in every file in `raw/refs/` no source page names yet, and asks before adding any rule.
- `/obsidian-vault:lint` checks the whole wiki and proposes fixes.

```
claude plugin marketplace add osabased/obsidian-vault
claude plugin install obsidian-vault@obsidian-vault
```

The skills run this vault's `tools/` in the working folder, so open a checkout of the vault before using them.

## Hooks

The hooks are not part of the plugin. Sessions run them from `.live/tools/`, a copy of `tools/` as of the last commit, so a half-made change to `tools/` never runs in a session. In a checkout of the vault, turn on the git hooks and make the first copy:

```
git config core.hooksPath .githooks
.githooks/post-commit
```

`pre-commit` runs the tests, rebuilds the generated files and lints. `post-commit` refreshes `.live/tools/` after each commit, and the other hooks run it after a checkout, merge or rebase. Then add the three hooks to `settings.json`, with the vault's path:

```json
"hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "node <vault>/.live/tools/hooks/session-start.mjs", "timeout": 10 }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node <vault>/.live/tools/hooks/prompt.mjs", "timeout": 10 }] }],
  "PreToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell", "hooks": [{ "type": "command", "command": "node <vault>/.live/tools/hooks/edit.mjs", "timeout": 10 }] }]
}
```
