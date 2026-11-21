# obsidian-vault

An Obsidian vault that an agent keeps, after Andrej Karpathy's [LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern. You collect sources and say what you think of them; the agent writes and maintains the wiki; you read and edit it in Obsidian. The agent also learns from you as it works: when you correct it, it keeps the correction as a rule, and hooks bring the rule back in later sessions.

## What's in it

- `raw/`: the sources, append-only. References you collect and web pages `/ingest` saved go in `raw/refs/`; the rules, picks and review-queue entries agents record go in `raw/inbox/`, `raw/picks/` and `raw/queue/`.
- `wiki/`: what the agent writes, one note each, by domain. Pages hold knowledge: topics, concepts, entities, syntheses and sources. Rules are one-line Do/Not taste and practice, and facts training gets wrong.
- `index.md`: every page and rule by topic, where an agent starts. `log.md`: what changed, newest last.
- `AGENTS.md`: the schema, how the agent writes and keeps the wiki. `reference/notes.md`: the note formats.

## How it works

- **Ingest.** `/ingest` a file or URL. It becomes a source page, every page it touches is updated, and what you say about it becomes rules.
- **Query.** Agents read `index.md` or search the vault before deciding something it settles, and file a useful answer back as a page.
- **Lint.** `/lint` checks the whole wiki: contradictions, stale pages, sources that changed since they were saved, and gaps worth a search.
- **Rules.** Hooks deliver rules to Claude Code and Codex sessions: `global`'s everywhere, a domain's in the projects it covers. Correct the agent and it proposes a new one.

Each session's start tells the agent to look things up in the vault and to keep your corrections there, so nothing needs adding to your own `CLAUDE.md`.

## Set up

You need git, Node.js 22.12 or later and Claude Code 2.1.295 or later. Obsidian is optional, for reading and editing the notes.

1. **Clone the vault** to a folder of your own, and go into it. Your rules are written as notes in this folder.

   ```
   git clone https://github.com/osabased/obsidian-vault my-vault
   cd my-vault
   ```

2. **Run setup**, then restart Claude Code:

   ```
   node setup.mjs
   ```

   It checks your Node.js and Claude Code versions, installs the plugin from this folder with the folder as its `vault` option (or points an installed plugin at it), turns on the vault's git hooks and makes `.live/tools/`, the copy of the vault's tools that sessions run. It is safe to run again. Each session then starts with a line such as `vault: no domain here · 0 global rules · proposals: ask`. A hook error that starts `vault <hook> failed:` says what is wrong and how to fix it.

## Updating

In the vault folder, run this, then restart Claude Code:

```
node setup.mjs --update
```

It pulls the vault, then updates the plugin, so its hooks and the tools they run stay in step.

## Daily use

1. **Work as usual.** Each new or resumed session starts with one line, such as `vault: roblox · 12 rules (2 always) · 3 pages · proposals: ask`: the domains the folder is in, the rules and pages that can reach the session, and when agents propose rules. Then it names what waits for you, such as `queue 3 (1 unattended)` for review-queue entries that `/lint` walks you through, `2 rules past their version here` for rules whose library this project has moved past, or `no version readers set` when rules name a library but no domain says how to read its version. `vault: no domain here` means only `global` reaches it.
2. **Correct the agent.** When you say how you want things, the agent keeps it as a rule, in the way `proposals` sets: `ask` offers each rule and keeps it once you agree. In Claude Code you agree at its permission prompt for the vault's `keep` tool, which shows the rule and where it applies: Allow once keeps it, Deny drops the offer. In Codex the offer ends with a short code, and you agree by typing it in your next message. The rule reaches later sessions from then on.
3. **Check what reached a session.** `/obsidian-vault:vault status` prints the start line again, then the rules and pages the vault has shown the session since it started or was last compacted.
4. **Read and edit in Obsidian.** Open this folder, not the one above it, as the Obsidian vault, so its ignore filters apply. Edit or delete any note; a saved note applies after a minute without another save. Nothing commits your notes: the vault reads them from this folder whether you commit them or not.
5. **Go through sources and tidy up here.** Open Claude Code in this folder for `/obsidian-vault:ingest` and `/obsidian-vault:lint`; the session start reminds you when lint is due.

A project whose kind no domain covers gets an offer to start one. For folders where that offer is noise, such as an app's scratch folders, list globs over their absolute paths under `quiet` in `vault.local.json`: sessions there can still keep a rule in `global`, and hear no domain offer.

```json
{ "domains": {}, "quiet": ["C:/Users/me/AppData/Local/SomeApp/**/scratch/**"] }
```

A domain reaches projects by the `markers` in `vault.config.json`, or by this machine's folders, which go in the untracked `vault.local.json` as `{ "domains": { "<domain>": { "paths": ["<absolute folder>"] } } }`. A session in a project no domain reaches can keep a preference in `global`, or suggest a domain to you; once you agree, as to a rule, the `domain` tool adds it to `vault.config.json`, and for a folder alone to `vault.local.json` too. Both files stay yours to edit.

## Plugin

The repo is also a Claude Code plugin with three skills, the hooks and the vault's tools. In a session opened in this folder the same skills also answer to `/ingest`, `/lint` and `/vault`, the names the session-start reminder uses:

- `/obsidian-vault:ingest` goes through a source with you, a file or a URL whose text it saves, and turns it and what you say about it into pages and rules. `/obsidian-vault:ingest batch` takes in every file in `raw/refs/` no source page names yet, and asks before adding any rule.
- `/obsidian-vault:lint` checks the whole wiki and proposes fixes.
- `/obsidian-vault:vault` sets when agents propose rules: `corrections` (as soon as you correct them), `ask` (they offer each rule and keep it once you agree; the default) or `off` (only when you ask), for every project or one domain, as `/obsidian-vault:vault off` or `/obsidian-vault:vault corrections <domain>`. Saying it in words works too. `/obsidian-vault:vault status` shows what the vault does in the session.
- The hooks deliver the rules and pages to your sessions. `hooks/hooks.json` starts SessionStart, UserPromptSubmit, PreToolUse (edits, and a record of each vault tool call), Stop and SubagentStart through `hooks/launch.mjs`, which runs the hook from your vault.
- The tools are an MCP server the plugin declares in `.claude-plugin/plugin.json`. `mcp/launch.mjs` runs the server from your vault's `.live/tools/`, and it serves `propose`, `keep`, `proposals`, `domain`, `pick`, `log`, `search` and `status` to your sessions, each running its script in `tools/` with the call's arguments exactly as the agent sent them. Claude Code 2.1.295 or later is needed. A server added with `claude mcp add` instead has no hooks, so each of its calls is refused: install the plugin as Set up says.

The plugin has one option, `vault`, the folder of your vault checkout. To set or change it later, run `claude plugin configure obsidian-vault@obsidian-vault` to see the option, or save it with `echo '{"vault":"<path>"}' | claude plugin configure obsidian-vault@obsidian-vault --values-stdin`. An unset option, a relative path, a folder that isn't a git clone of the vault, one inside Claude Code's plugins folder, which an update replaces, or a hook that cannot load prints `vault <hook> failed: <why>` as a hook error, and the call goes ahead. A vault tool call whose hook failed is refused instead, since the server can't tell which session made it; a server that cannot start prints `vault mcp failed: <why>`.

`ingest` and `lint` run this vault's `tools/` in the working folder, so open a checkout of the vault before using them. `vault` works in any session the hooks reach. If `settings.json` still holds the vault's hooks from before the plugin, remove them, or each hook runs twice.

## Hooks

Sessions run the hooks from `.live/tools/`, a copy of `tools/` as of the last commit, so a half-made change to `tools/` never runs in a session. Session start and the tool server make the copy when it is missing, and again when the last commit changed `tools/`. `node setup.mjs` turns on the vault's git hooks, which refresh it after each commit as well and run the checks below. Without Claude Code, as for Codex alone, turn them on in this folder yourself:

```
git config core.hooksPath .githooks
```

`pre-commit` runs the tests, rebuilds the generated files and lints. It commits the generated files only when the notes they are built from are all in the commit, so a commit never names a rule you kept out of git. `post-commit` refreshes `.live/tools/` after each commit, and the other hooks run it after a checkout, merge or rebase.

## Limits of consent

- Anything that can write `.state/` with a raw shell command can forge the record that ties a tool call to its session, as any raw shell write can; the hooks guard against mistakes, not deliberate workarounds.
- A shell command that drops the agent's session variable can run a vault script for another session, and with a vault-folder session's id it writes a rule at once, as in `corrections`.
- A `propose` that the agent sends while the same text's `keep` prompt is open reads as declined.
- Claude Code's `dontAsk` mode denies `keep`, and `claude -p` can't approve it, so rules can't be kept there. A host built on the Agent SDK can approve `keep` for you in its `canUseTool` callback.
- Whether a PermissionRequest hook's `allow` skips the prompt for `keep` hasn't been checked.

## Codex

The same hooks run in Codex through `tools/adapters/codex/`. Codex is opt-in: add it to `agents` in `vault.config.json`, as `"agents": ["claude-code", "codex"]`, so lint checks `editTools` and `tools` names against what Codex's hooks see and scripts run from a Codex shell find their session. Then print the hooks and the tool server's registration, and merge them into `~/.codex/hooks.json` and `~/.codex/config.toml` yourself:

```
node tools/agents.mjs codex
```

The command writes nothing, and ends with a `[mcp_servers.vault]` block for `config.toml` that starts the same `mcp/launch.mjs` server. Open `/hooks` in Codex and trust the six vault hooks; Codex skips a hook until you do, and again after its command changes. The commands run the vault's `.live/tools/`, so trust holds across vault commits. They don't make the copy, as the plugin's hooks do, so turn on the git hooks as Hooks says, then run `git hook run post-commit` (git 2.36 or later) once to make it. Codex reads the vault's `AGENTS.md` natively, and its skills from `.agents/skills/`, which holds copies of `.claude/skills/` that `node tools/lint.mjs --fix` keeps.

What Codex doesn't give the vault, and the vault doesn't work around:

- **Edits** arrive as `apply_patch` patches, one refusal naming every covered file in the patch. Shell writes, a patch run through the shell included, are checked at the end of the turn, in git projects only.
- **Tools.** Codex's PreToolUse sees `apply_patch`, `Bash` and MCP tools, so a `tools` rule can name only an MCP tool. Answers to Codex's question tool are left out of your typed words.
- **The end-of-turn check** reaches the model as a new prompt, not as context. The vault keeps that prompt out of your typed words.
- **Failures.** A hook that fails is marked failed and the call goes on. The vault logs it in `.state/errors.log` and names it at the next session start. A vault tool call the hook didn't record is refused by the server anyway.
- **Consent.** Codex's own approval prompt for an MCP tool plays no part in whether a rule is kept. An offer ends with a four-character code, and the rule is kept only when your next message, and no other since the offer, holds the code, after a reply of the agent's that showed the offer. Codex fixes its tool list when it connects, so restart it after the vault's tools change.
- **Context size.** `additionalContextLimit` counts tokens by Codex's own estimate, and Codex saves longer context to a file with a preview.
- **Untrusted hooks** don't run, and the vault can't tell.
- **The status line** isn't shown, since the vault doesn't know whether Codex shows a hook's `systemMessage`. Ask the agent for the vault's `status` tool, which prints it.

### Projects without the hooks

For a project where the vault's hooks don't run, such as a machine without them or a repo other people's agents read, add `"compile": ["codex"]` to its domain in `vault.config.json` and run:

```
node tools/compile.mjs <project>
```

It writes the domain's `always`, file-glob and keyword rules, and global's, into a marked section of the project's `AGENTS.md`, and keeps the rest of the file byte for byte. Run it again when the rules change: `node tools/lint.mjs` warns on a section that is missing or stale in a folder the domain lists under `paths`. Compile refuses a section edited by hand, so change the rules in the vault, not the section. Opt in only where the hooks don't run, since a session with trusted Codex hooks would get the rules twice. A compiled section has no refusal and retry, `triggers`, once-per-session delivery, proposing, pages, namespace globs or `tools` rules.
