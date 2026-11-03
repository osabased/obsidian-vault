# obsidian-vault

A taste vault for Claude Code, based on Andrej Karpathy's LLM wiki pattern: a small wiki of the user's preferences, written as rules the agent gets back in later sessions. `AGENTS.md` describes the layout and the note formats.

## Daily use

1. **Work as usual.** Each new or resumed session starts with one line, such as `vault: roblox · 12 rules (2 always) · 3 pages · proposals: ask`: the domains the folder is in, the rules and pages that can reach the session, and when agents propose rules. `vault: no domain here` means only `global` reaches it.
2. **Correct the agent.** When you say how you want things, the agent keeps it as a rule, in the way `proposals` sets: `ask` offers each rule and keeps it once you agree. The rule reaches later sessions from then on.
3. **Check what reached a session.** `/obsidian-vault:vault status` prints the start line again, then the rules and pages the vault has shown the session since it started or was last compacted.
4. **Read and edit in Obsidian.** Open this folder, not the one above it, as the Obsidian vault, so its ignore filters apply. Edit or delete any note; a saved note applies after a minute without another save.
5. **Go through sources and tidy up here.** Open Claude Code in this folder for `/obsidian-vault:ingest` and `/obsidian-vault:lint`; the session start reminds you when lint is due.

A project whose kind no domain covers gets an offer to start one. For folders where that offer is noise, such as an app's scratch folders, list globs over their absolute paths under `quiet` in `vault.local.json`: sessions there can still keep a rule in `global`, and hear no domain offer.

```json
{ "domains": {}, "quiet": ["C:/Users/me/AppData/Local/SomeApp/**/scratch/**"] }
```

## Plugin

The repo is also a Claude Code plugin with three skills and the hooks:

- `/obsidian-vault:ingest` goes through a source with you, a file or a URL whose text it saves, and turns it and what you say about it into pages and rules. `/obsidian-vault:ingest batch` takes in every file in `raw/refs/` no source page names yet, and asks before adding any rule.
- `/obsidian-vault:lint` checks the whole wiki and proposes fixes.
- `/obsidian-vault:vault` sets when agents propose rules: `corrections` (as soon as you correct them), `ask` (they offer each rule and keep it once you agree; the default) or `off` (only when you ask), for every project or one domain, as `/obsidian-vault:vault off` or `/obsidian-vault:vault corrections <domain>`. Saying it in words works too. `/obsidian-vault:vault status` shows what the vault does in the session.
- The hooks deliver the rules and pages to your sessions. `hooks/hooks.json` starts SessionStart, UserPromptSubmit, PreToolUse (edits), Stop and SubagentStart through `hooks/launch.mjs`, which runs the hook from your vault.

```
claude plugin marketplace add osabased/obsidian-vault
claude plugin install obsidian-vault@obsidian-vault --config "vault=<path to your vault checkout>"
```

The plugin has one option, `vault`, the folder of your vault checkout. To set or change it later, run `claude plugin configure obsidian-vault` to see the option, or save it with `echo '{"vault":"<path>"}' | claude plugin configure obsidian-vault --values-stdin`. An unset option, a relative path, a vault with no `.live/tools/` or a hook that cannot load prints `vault <hook> failed: <why>` as a hook error, and the call goes ahead.

`ingest` and `lint` run this vault's `tools/` in the working folder, so open a checkout of the vault before using them. `vault` works in any session the hooks reach. If `settings.json` still holds the vault's hooks from before the plugin, remove them, or each hook runs twice.

## Hooks

Sessions run the hooks from `.live/tools/`, a copy of `tools/` as of the last commit, so a half-made change to `tools/` never runs in a session. In a checkout of the vault, turn on the git hooks and make the first copy:

```
git config core.hooksPath .githooks
.githooks/post-commit
```

`pre-commit` runs the tests, rebuilds the generated files and lints. `post-commit` refreshes `.live/tools/` after each commit, and the other hooks run it after a checkout, merge or rebase. A domain reaches projects by the `markers` in `vault.config.json`, or by this machine's folders, which go in the untracked `vault.local.json` as `{ "domains": { "<domain>": { "paths": ["<absolute folder>"] } } }`. A session in a project no domain reaches can keep a preference in `global`, or suggest a domain to you; once you agree, `tools/domain.mjs` adds it to `vault.config.json`, and for a folder alone to `vault.local.json` too. Both files stay yours to edit.

## Codex

The same hooks run in Codex through `tools/adapters/codex/`. Codex is opt-in: add it to `agents` in `vault.config.json`, as `"agents": ["claude-code", "codex"]`, so lint checks `editTools` and `tools` names against what Codex's hooks see and scripts run from a Codex shell find their session. Then print the hooks and merge them into `~/.codex/hooks.json` yourself:

```
node tools/agents.mjs codex
```

The command writes nothing. Open `/hooks` in Codex and trust the five vault hooks; Codex skips a hook until you do, and again after its command changes. The commands run the vault's `.live/tools/`, so trust holds across vault commits. Codex reads the vault's `AGENTS.md` natively, and its skills from `.agents/skills/`, which holds copies of `.claude/skills/` that `node tools/lint.mjs --fix` keeps.

What Codex doesn't give the vault, and the vault doesn't work around:

- **Edits** arrive as `apply_patch` patches, one refusal naming every covered file in the patch. Shell writes, a patch run through the shell included, are checked at the end of the turn, in git projects only.
- **Tools.** Codex's PreToolUse sees `apply_patch`, `Bash` and MCP tools, so a `tools` rule can name only an MCP tool. Answers to Codex's question tool are left out of your typed words.
- **The end-of-turn check** reaches the model as a new prompt, not as context. The vault keeps that prompt out of your typed words.
- **Failures.** A hook that fails is marked failed and the call goes on. The vault logs it in `.state/errors.log` and names it at the next session start.
- **Context size.** `additionalContextLimit` counts tokens by Codex's own estimate, and Codex saves longer context to a file with a preview.
- **Untrusted hooks** don't run, and the vault can't tell.
- **The status line** isn't shown, since the vault doesn't know whether Codex shows a hook's `systemMessage`. `node tools/status.mjs` prints it.

### Projects without the hooks

For a project where the vault's hooks don't run, such as a machine without them or a repo other people's agents read, add `"compile": ["codex"]` to its domain in `vault.config.json` and run:

```
node tools/compile.mjs <project>
```

It writes the domain's `always`, file-glob and keyword rules, and global's, into a marked section of the project's `AGENTS.md`, and keeps the rest of the file byte for byte. Run it again when the rules change: `node tools/lint.mjs` warns on a section that is missing or stale in a folder the domain lists under `paths`. Compile refuses a section edited by hand, so change the rules in the vault, not the section. Opt in only where the hooks don't run, since a session with trusted Codex hooks would get the rules twice. A compiled section has no refusal and retry, `triggers`, once-per-session delivery, proposing, pages, namespace globs or `tools` rules.
