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

The skills run this vault's `tools/` in the working folder, so open a checkout of the vault before using them. The hooks in `tools/hooks/` are not part of the plugin; install them in `settings.json`.
