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

   It installs the plugin from the repository you cloned, with this folder as its vault, and turns on the vault's git hooks. It is safe to run again, and to move the vault, run it from the new folder. Each session then starts with a line such as `vault: no domain here · 0 global rules · proposals: ask`. A hook error that starts `vault <hook> failed:` says what is wrong and how to fix it.

## Updating

In the vault folder, run this, then restart Claude Code:

```
node setup.mjs --update
```

It pulls the vault, then updates the plugin, so its hooks and the tools they run stay in step.

## Daily use

1. **Work as usual.** Each session starts with a status line, such as `vault: roblox · 12 rules (2 always) · 3 pages · proposals: ask`: the domains the folder is in, the rules and pages that can reach the session, and when agents propose rules.
2. **Correct the agent.** By default it offers each correction as a rule at Claude Code's permission prompt for the vault's `keep` tool: Allow once keeps it, Deny drops it. `/obsidian-vault:vault` changes when it proposes.
3. **Read and edit in Obsidian.** Open this folder, not the one above it, as the Obsidian vault. Edit or delete any note; a saved note applies after a minute. Nothing commits your notes: the vault reads them from this folder.
4. **Ingest and lint here.** Open Claude Code in this folder for `/ingest` and `/lint`; the session start reminds you when lint is due.

A project whose kind no domain covers gets an offer to start one.

## More

- [reference/advanced.md](reference/advanced.md): the status line in full, domains and quiet folders, the plugin's skills, hooks and tools, the git hooks, the limits of consent, Codex, and projects without the hooks.
- [reference/delivery.md](reference/delivery.md): how rules and pages reach each session.
- [reference/notes.md](reference/notes.md): the note formats.
