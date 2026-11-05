# Code and data split: design draft

Status: dropped, 2026-11-05. The user picked A on 2026-11-03, with the answers in §9, then decided the split isn't worth it, since the vault is personal (`design-self-maintaining.md` §11.27). Nothing is built.

Scope: where the vault's upstream code and the user's own data live, and how a vault updates. Mechanism only: this design adds no domain knowledge. It builds on G1 to G3 of branch `beginner-setup`, which the main session is building: the launcher checks the folder before it gives advice (G1), the plugin id is `obsidian-vault@obsidian-vault` (G2), and the launchers build `.live/tools` from HEAD themselves through `hooks/live.mjs` (G3). Nothing here assumes `core.hooksPath` is on.

Inputs:
- Reads of `README.md`, `AGENTS.md`, `.gitignore`, `.githooks/`, `.claude-plugin/plugin.json`, `hooks/launch.mjs`, `mcp/launch.mjs`, the work-in-progress `hooks/live.mjs`, `tools/lib/vault.mjs`, `tools/mcp/server.mjs`, `tools/adapters/codex/`, `tools/agents.mjs`, `test/fixture.mjs`, and §3 of `docs/design-all-rounder.md`.
- Scratch repositories built with git 2.49.0.windows.1 (§1 lists each case).
- The Claude Code plugin docs, fetched 2026-11-03: `plugins/loading`, `skills`, `plugins/manifest-reference`, `plugins/components` under https://code.claude.com/docs/en/.

Claims are verified unless marked *(unverified)* or *(inferred)*. A bare file name means the one file of that name in `tools/`, `tools/lib/` or `hooks/`.

## 1. Problem

A user's vault is a clone of https://github.com/osabased/obsidian-vault. The tools write files that git tracks as they run, and the user writes notes beside the code. Once upstream changes one of those files, `git pull` stops:

```
Please commit your changes or stash them before you merge.
Updating fd13ba3..ef27c88
Aborting
```

**Root cause.** The user's notes and the upstream code share one repository and one history. Two update channels, `git pull` and `claude plugin update`, have to move together.

**The overlap set.** These paths are tracked upstream and written in a user's vault:

| Path | Written by |
|---|---|
| `log.md` | the `propose`, `keep` and `log` tools, and `review.mjs status` |
| `index.md`, `active.md`, `decisions.md` | `build.mjs`, which each session start and each pick run |
| `vault.config.json` | the `domain` and `proposals` tools, and the user |
| `wiki/.gitkeep`, `raw/inbox/.gitkeep`, `raw/refs/.gitkeep` | nothing; but an upstream file added under `wiki/` or `raw/` aborts against a user note at the same path (case 5) |
| `.obsidian/app.json`, `appearance.json`, `core-plugins.json` | Obsidian, when the user changes a setting *(inferred from Obsidian's behaviour; not run here)* |

`AGENTS.md` and `CLAUDE.md` are upstream instructions that a user may also edit.

**Failure shapes,** each run in a scratch upstream and clone:

1. *A changed tracked file, and upstream changes it.* `git pull` aborts, as above.
2. *The user commits, and upstream commits.* Git for Windows merges, since its system config sets `pull.rebase=false` (`C:/Program Files/Git/etc/gitconfig`). In a terminal the merge opens an editor for its message *(inferred: git's default for an interactive merge)*. Elsewhere, git 2.33 or later with no pull setting stops with `fatal: Need to specify how to reconcile divergent branches.` *(unverified here)*.
3. *Upstream stops tracking a file the user changed.* `git pull` aborts.
4. *Upstream stops tracking a file the user left alone.* `git pull` deletes it, silently.
5. *Upstream adds a file at the path of an untracked user note.* `git pull` aborts: `Please move or remove them before you merge.`

Case 4 makes the naive fix a trap: a commit that untracks the overlap set aborts each clone that changed a file, and deletes the file from each clone that didn't.

**The invariant.** Cases 1, 3 and 5 need a change in the working tree at a path that an upstream commit touches. So every option must hold one rule: **upstream never again commits a change to a path that the vault, Obsidian or the user writes.** §8 check 1 tests it.

**The author's side.** The author's vault is the upstream checkout. Commit 4fe83bc, "Clear the vault for a fresh start: no domains, no log history", deleted the author's notes so that a beginner's clone starts empty. That is the same root cause from the other direction.

**The author's vault today** (`C:\Users\Lowle\vaults\agent-taste`): `wiki/global/rules/` is empty, `vault.config.json` has `"domains": {}`, `log.md` holds only its header, `.state/` holds 201 KB of session records and 3 offers, and `vault.local.json` holds one `quiet` glob. The migration (§6) is still designed for a vault that holds rules and domains, since this one may hold some by the time it moves.

## 2. What stays

- **Snapshots.** Hooks and the tool server run a snapshot of the tools, so a half-made change never runs in a session.
- **G3's builder.** `hooks/live.mjs` builds `.live/tools` beside the old copy and swaps it in, under a lock, with the tree it holds in `.live/tools/.tree`.
- **Finding the vault.** `findRoot()` (`vault.mjs:9-16`) walks up from the code to the nearest `vault.config.json`. `test/fixture.mjs:9,31` copies `tools/` into a scratch vault and relies on that walk.
- **Codex trust.** It holds while the hook command strings stay the same (`tools/adapters/codex/adapter.mjs:134`).
- **Layers.** The layer table in §3 of `design-all-rounder.md` is unchanged. This design moves where the Core, Extensions and Adapters layers are installed, not what they hold. Config and Notes stay the user's.

## 3. Options

Each option gives its design, then updating, the developer workflow, `ingest` and `lint`, Codex, generated files, migration and cost.

### A. The plugin carries the code; the vault folder holds only data

*Design.*
- The vault folder holds the user's data and nothing upstream tracks:
  - `wiki/`, `raw/`, `derived/`, `log.md`, `vault.config.json` and `vault.local.json`;
  - the generated `active.md`, `index.md` and `decisions.md`;
  - `.state/`, `.sources/` and `.obsidian/`.

  A new vault is a git repository of its own, with no upstream, so nothing ever pulls into it (First run, below).
- The plugin is the code: `tools/`, `hooks/`, `mcp/`, the skills and `reference/`. It also ships a `seed/` folder with the files a new vault starts with. The folder names are provisional.
- `hooks/live.mjs` keeps building `<vault>/.live/tools/`, but from the plugin instead of the vault:
  - **A cached plugin** (installed from GitHub): it copies `${CLAUDE_PLUGIN_ROOT}/tools`. Its stamp is the plugin root, whose path holds the version: Claude Code "copies the plugin into `cache/<marketplace>/<plugin>/<version>/`" (`plugins/loading`).
  - **A plugin loaded in place from a git checkout** (§3A Developer workflow): it builds from `HEAD:tools`, as G3 does now, stamped with the tree.
  - It also writes the files other agents need at fixed paths. Each one says it is generated:
    - `.live/mcp/launch.mjs`, for Codex;
    - `.live/reference/`;
    - the vault part of `AGENTS.md`, at the vault root;
    - `.agents/skills/`, copied from `.claude/skills/`.

    A generated file that someone edited by hand is kept and reported, not overwritten, as `compile.mjs` treats its section.
  - The copy is refreshed only on events that start a new process: SessionStart with `source: startup`, and the tool server starting. Each new process loads the plugin version installed now. A `/clear` or `/resume` in a process started before an update keeps the copy, so two processes on two versions don't swap it back and forth.
- **The data root.** The launchers set `VAULT_ROOT`, and `findRoot()` takes it first and walks up only when it is unset. Tests and `.live` copies keep the walk. A vault whose `vault.config.json` was deleted (case 4) still finds its root.
- **First run.** If the folder the option names is missing or empty, the launcher writes `seed/` into it:
  - `vault.config.json`, `log.md`;
  - `CLAUDE.md`, holding `@AGENTS.md`;
  - `.gitignore`, and `.gitattributes` with `raw/** -text`;
  - the `.obsidian/` defaults;
  - `wiki/`, `raw/inbox/` and `raw/refs/`.

  It then runs `git init` in the folder and makes no commit: the first commit is the user's, so it carries their git identity. Without git on `PATH` the folder stays a plain folder, and the start line says the notes have no history.

  A non-empty folder with no `vault.config.json` is refused with a hook error, and nothing is written. Claude Code has no install or update event. The docs say to check on first use from SessionStart instead (`plugins/components`, "Install dependencies into the data directory"), and Setup "doesn't fire on normal startup" (`hooks`).

*Updating.*
- The user runs `claude plugin marketplace update obsidian-vault`, then `claude plugin update obsidian-vault@obsidian-vault`, and restarts. No git is involved.
- A failed update leaves the old cached version in place. The previous version's folder is removed "in a background cleanup 14 days later, so a session that already loaded the old version keeps running" (`plugins/loading`).
- An update writes only the generated files: `.live/`, `AGENTS.md` and `.agents/skills/`. It never writes data.

*Developer workflow.*
- The author's checkout holds code only. The author installs the plugin from it: `claude plugin marketplace add <checkout>`, which replaces the GitHub marketplace of the same name.
- A relative-path plugin in a marketplace added from a local path "loads in place from its path inside the marketplace folder" (`plugins/loading`). The builder copies `HEAD:tools`, so a commit reaches the next process that starts: a new session, or the tool server. Today `.githooks/post-commit` also swaps the copy under sessions already running (`AGENTS.md:18`). Under A those keep their copy until they restart, since the checkout's hooks don't know the data folder.
- Unlike today, `hooks.json`, `plugin.json`, the launchers and the skills load from the working tree at session start. This is a declared limit of the in-place install.
- **Trying a change before its commit.** Today `tools/mcp/server.mjs:102` runs the working `tools/` for a session whose folder is inside the vault (`inVaultFolder`, `vault.mjs:200`). Under A the data folder has no `tools/`, so the check moves to the checkout:
  - `mcp/launch.mjs` passes the in-place plugin root to the server. A cached plugin passes none.
  - A session whose folder is inside that root runs `<checkout>/tools` against the data folder. Every other session runs `toolsPath()`, the copy in `.live`.

  The author's loop stays: edit `tools/` in the checkout, call a vault tool from a session there, and commit when it works.
- **The checkout is a project.** The other uses of `inVaultFolder` stay on the data folder. There a session may write a rule note by hand (`handlers/pre-tool.mjs:37`), reaches every domain (`sessions.mjs:95`), and `propose` and `status` treat it as the vault. A session in the checkout gets the handling of any other project. §9 item 7 asks whether to keep that.
- Tests copy `tools/` into a scratch vault (`test/fixture.mjs:31`), which is the old layout. The fixture gains a second layout: a data folder with no `tools/`, and `VAULT_ROOT` set to it. The tests in §8 that check A use it.
- `test/neutral-core.test.mjs:9,20` reads the configured domains from the checkout's `vault.config.json`, which moves out. It reads them from `VAULT_ROOT` instead, and skips when that is unset.
- The author's notes can no longer reach upstream by mistake.

*`ingest` and `lint`.* The skills run `node .live/tools/<script>.mjs` from the vault folder, in place of `node tools/<script>.mjs`, at 10 places. The same text works for Codex's copies.
- Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` in plugin skills (`skills`, "Available string substitutions"). But Codex's copies would not get the substitution, and the cached path changes with each version.
- The edit hook already refuses edits to `.live/`, so an agent can't change the copy it runs.

*Codex.*
- Its hook commands stay `node "<vault>/.live/tools/adapters/codex/launch.mjs" <hook> 10`, so the user's trust holds.
- The `[mcp_servers.vault]` block changes from `<vault>/mcp/launch.mjs` to `<vault>/.live/mcp/launch.mjs` (`adapter.mjs:143`). The user merges it once.
- `.live/mcp/launch.mjs` is not a copy of the plugin's `mcp/launch.mjs`, which imports `hooks/live.mjs` and builds the copy from the plugin root. Codex has no plugin root. So it is a short launcher of its own, shipped in `tools/adapters/codex/` and copied with the rest: it starts `.live/tools/mcp/server.mjs` for the data folder it sits in, and builds nothing.
- Codex runs the version that the last Claude Code session copied in.
- **A user with Codex and no Claude Code** is a declared gap: only a Claude Code session updates the vault's copy. The README says so.

*Generated files.*
- `active.md`, `index.md` and `decisions.md` are built in the vault as today, and upstream never tracks them.
- The checkout's `pre-commit` drops `node tools/build.mjs && git add active.md index.md decisions.md` and the notes lint (`.githooks/pre-commit:15`). It keeps the tests and the code checks.
- Lint's check of the `.agents/skills/` copies (`lint.mjs:915-926`) moves to the builder, which writes the copies.
- Commit-time append-only checking of `raw/` goes away with the vault's pre-commit, since the seed installs no git hooks. The edit hook still refuses changes to `raw/`. This is a declared limit.

*Migration.* See §6.

*Cost.* This is the largest change: launchers, `findRoot()`, `server.mjs`, skills, `AGENTS.md`, `README.md`, the Codex adapter, `pre-commit`, tests, `seed/` and a move script (§7). The author keeps two folders.

### B. Template clone: data stays in the clone, untracked

*Design.*
- Upstream untracks the overlap set and ignores it in `.gitignore`.
- The tools make what is missing: `build.mjs` the generated files, the first append `log.md`, and `DEFAULTS` (`vault.mjs:21`) a missing config.
- `findRoot()` needs `VAULT_ROOT` too, since `vault.config.json` may be missing.

*Updating.*
- `git pull`, then the plugin update. The pull never touches ignored paths.
- It still aborts on a tracked code file changed locally. `AGENTS.md` lets a session in the vault folder change `tools/`.
- Both update channels stay, and a beginner still needs git.

*Developer workflow.* Unchanged. Notes are ignored, so they can't be committed. They have no history, and none reaches upstream by mistake.

*`ingest` and `lint`.* Unchanged.

*Codex.* Unchanged.

*Generated files.* `pre-commit`'s `git add active.md index.md decisions.md` fails on ignored paths, so it goes.

*Migration.* The pull that brings the untracking commit is the trap.
- A clone with a changed file aborts (case 3).
- A clone with an unchanged file loses it (case 4). That is harmless here, since the tools make it again.
- Two orders were run in scratch clones, and both pull cleanly with the user's text kept:
  - untrack locally and commit first (`git rm --cached <files>`, then commit);
  - or copy the files aside, `git checkout -- <files>`, pull, and copy them back.
- A beginner's clone holds the old README, which says only `git pull`. To automate the step, the launcher would have to commit in the user's repository.

*Cost.* The smallest code change. Notes lose git history.

### C. Data in a subfolder with its own history

*Design.*
- Upstream ignores `/vault/` (the name is provisional), and the data moves under it.
- That folder can be its own git repository, nested in the ignored folder.
- The data root is `<clone>/vault/` and the code root is the clone. Obsidian opens `vault/`.

*Updating.* As B: `git pull` and the plugin update, neither of which touches `vault/`.

*Developer workflow.* Unchanged, and notes keep history in their own repository.

*`ingest` and `lint`.* Sessions run from the clone root, where `AGENTS.md` and `tools/` are. So every vault path in `AGENTS.md`, the skills and `reference/` gains the `vault/` prefix. The alternative is that sessions run in `vault/` and call `../tools`. Either way, what agents read changes.

*Codex.* The registration's root is the clone, and the hooks are given the data root.

*Generated files.* As B.

*Migration.* The data moves into `vault/`. The pull that untracks the root files then has B's trap.

*Cost.* Middle. It has two roots like A, and keeps B's git update channel.

### Not taken

- **Data on an orphan branch in a git worktree.** One repository keeps separate histories, but a beginner meets worktrees and orphan branches, and `git push --all` publishes the notes.
- **`git pull --autostash`.** The stash pop conflicts in generated files.
- **`skip-worktree` or `assume-unchanged`.** They are set per clone, and the pull still aborts when upstream changes the file.
- **A `merge=ours` driver.** It is per-clone config, and it helps only with committed changes.
- **Submodule or subtree.** Native to git, but not to a beginner.
- **Running the hooks straight from `${CLAUDE_PLUGIN_ROOT}`, without `.live`.**
  - Codex needs a path that survives updates, and cached folders go 14 days after one.
  - An in-place plugin would run the working tree.
  - There would be two code paths.
- **Ordering copies by `plugin.json` `version`.** A set version "keeps every user on the cached copy until its author changes the string" (`plugins/loading`), so each release would need a bump.
- **The vault inside `${CLAUDE_PLUGIN_DATA}`.** Claude Code deletes that folder on uninstall by default (`plugins/manifest-reference`). G3 refuses the plugins folder for the same reason.

## 4. Comparison

| | A. Plugin carries code | B. Template clone | C. Data subfolder |
|---|---|---|---|
| An update can't touch data | Yes: no git in the update | Yes, while the invariant holds | Yes, while the invariant holds |
| An update can still abort | No | On a changed code file | On a changed code file |
| Notes keep history | Yes: a new vault is its own repository | No | Yes, in a nested repository |
| A beginner needs git | No | Yes | Yes |
| Update channels | 1 (plugin) | 2 | 2 |
| Change to the developer's loop | Install in place; launchers and skills load from the working tree; a commit reaches only new processes | None | None |
| Change to `ingest` and `lint` | `node .live/tools/…` | None | Every vault path, or `../tools` |
| Change for Codex | One MCP block to merge; Codex alone can't update | None | The data root is passed in |
| Migration risk | None from git: the old clone is copied, never pulled | The transition pull aborts or deletes | As B |
| Size | Large | Small | Middle |

## 5. Recommendation

**A.**
- It is the only option where an update can't reach the user's data by construction. It doesn't rest on upstream keeping a rule.
- It replaces two update channels with Claude Code's own, which is the feature built for shipping code to users (bar: Native).
- Notes can have history in a repository of the user's own.
- It extends G3 rather than replacing it: same builder, another source.

Its costs are named, not worked around:
- the in-place install runs the working tree's launchers and skills;
- a commit reaches a new session or tool server, not the sessions already running;
- a session in the code checkout becomes a project session (§9 item 7);
- a Codex-only user can't update;
- it is the largest change.

If the user wants the smallest change now, B stops the abort, but notes lose history, and every existing clone meets the transition trap.

## 6. Migration path (A)

1. **Build A** (§7), with support for an old layout:
   - When the option names an old clone (it holds `.git` and a tracked `tools/`), the launcher still builds `.live/tools` from the plugin. The start line says the folder is an old clone and names the move command. That wording is copy, so the user agrees to it first.
   - The old clone's `.githooks/post-commit` overwrites `.live/tools` after a commit. Its stamp then no longer names the plugin, so the next startup builds again.
   - The clone's own `.claude/skills/` still run the clone's `tools/` as project skills. That is the reason to move rather than stay.
2. **Move.** From the old vault, run `node .live/tools/move.mjs <new folder>` (the name is provisional). It:
   - copies every file in the working tree except the upstream code paths (what `git ls-files` lists at the clone's HEAD, outside the overlap set) and `.git/` and `.live/`. Copying by exclusion brings uncommitted notes, untracked notes and files the design doesn't know about;
   - refuses a target that exists and isn't empty;
   - checks each copy by SHA-256, and prints the count and the bytes;
   - writes the `seed/` files the target lacks, and runs `git init` there as First run does;
   - changes nothing in the old folder;
   - prints the `claude plugin configure` line, and the `node .live/tools/agents.mjs codex` line when `agents` lists `codex`.

   The user sets the option and restarts. The old folder stays as an archive until the user deletes it.
3. **Upstream transition commit.** It untracks the root data files and adds `seed/`. It lands only after the author's data is copied out. A clone that still pulls aborts on a changed file and loses nothing. An unchanged file is deleted (case 4) and loses nothing, since it held the template and `VAULT_ROOT` keeps the root. Untracked notes stay.
4. **README.** Set up becomes: install the plugin and choose a folder. Updating becomes the plugin update alone. A new section covers moving from a clone. All of this is copy, so the user agrees to it first.

**The author's vault.**
- `C:\Users\Lowle\vaults\agent-taste` stays the code checkout.
- Step 2 copies the data to a new folder that the user names: `vault.config.json`, `vault.local.json`, `log.md`, `.state/`, `.obsidian/` and the empty `wiki/` and `raw/`.
- The user then:
  1. adds the checkout as a local marketplace;
  2. sets the option to the new folder;
  3. merges the new MCP block into Codex, if Codex is in use.
- Check: the SHA-256 list of the copied files matches the source's, and a new session prints the same start line as before the move.

## 7. Files that change (A)

| File | Change |
|---|---|
| `hooks/live.mjs` (G3) | Its source becomes the plugin root: a cached copy is copied as files, an in-place checkout as `HEAD:tools`. It also writes `.live/mcp/`, `.live/reference/`, `AGENTS.md` and `.agents/skills/`, refreshes only on startup and server start, and seeds an empty folder. It no longer requires `tools/` or `.git` in the vault. |
| `hooks/launch.mjs`, `mcp/launch.mjs` | They set `VAULT_ROOT`, and give the old-clone notice and the seed refusal. `mcp/launch.mjs` also passes the in-place plugin root to the server. |
| `.claude-plugin/plugin.json` | The `vault` option's description: copy. |
| `tools/lib/vault.mjs:9-16` | `findRoot()` takes `VAULT_ROOT` first. |
| `tools/CODING_STANDARDS.md:8` | How scripts find the vault. |
| `tools/mcp/server.mjs:102` | Runs `<checkout>/tools` for a session inside the in-place plugin root it is given; otherwise `toolsPath()`. |
| `tools/adapters/codex/adapter.mjs:143`, `launch.mjs`, `tools/agents.mjs` | The MCP path becomes `.live/mcp/launch.mjs`; the data root is passed when the code isn't inside the vault. |
| `tools/adapters/codex/mcp-launch.mjs` (new; the builder copies it to `.live/mcp/launch.mjs`) | Starts `.live/tools/mcp/server.mjs` for the data folder it sits in. It builds nothing. |
| `test/fixture.mjs` | A second layout: a data folder with no `tools/`, with `VAULT_ROOT` set. |
| `tools/move.mjs` (new) | The move in §6 step 2, with its writes through `lib/vault.mjs`. |
| `.claude/skills/ingest/SKILL.md`, `lint/SKILL.md` | `node tools/` becomes `node .live/tools/`. |
| `AGENTS.md` | Split: the vault part ships for the builder to write into each vault, and the code part stays in the checkout for agents changing the tools. |
| `reference/notes.md`, `reference/delivery.md` | Read from `.live/reference/` in a vault; the paths change where they name `tools/`. |
| `README.md` | Set up, Updating, Plugin, Hooks and Codex: copy. |
| `.githooks/pre-commit` | Drops the build, the `git add` and the notes lint. |
| `.githooks/post-commit`, `post-checkout`, `post-merge`, `post-rewrite` | Removed: the builder makes `.live` from HEAD. |
| `.gitignore`, and the tracked overlap set | The overlap set leaves tracking and moves into `seed/`. |
| `seed/` (new) | The files a new vault starts with (§3A First run). |
| `test/neutral-core.test.mjs:9,20` | Reads the config from `VAULT_ROOT`. |
| `test/live.test.mjs`, `test/plugin.test.mjs`, `test/codex.test.mjs` | See §8. |

## 8. Checks

Run each by name, as `node --test test/<name>.test.mjs`. Each goes red on the problem before its fix.

1. **`test/layout.test.mjs`** (new; guards every option).
   - What it checks: `git ls-files` in the checkout lists no path in the overlap set.
   - Red today: it lists 11 paths: the 4 generated or logged files, `vault.config.json`, 3 `.gitkeep` files and 3 `.obsidian/` files.
2. **`test/update.test.mjs`** (new).
   - Setup: a scratch upstream and vault. The tools that write run first: `propose` in `corrections`, `domain`, `build` and `log`. Then upstream makes a commit that changes `tools/`.
   - What it checks: the update path finishes, every data file is byte for byte the same, and `.live/tools` changed. For A, the path is a new plugin source and a startup hook. For B and C, it is `git pull`.
   - Red today: the pull aborts, as in case 1.
3. **`test/plugin.test.mjs` and `test/live.test.mjs`.**
   - The builder copies a cached plugin folder.
   - An in-place checkout builds from HEAD, not from the working tree.
   - A `clear` start in an older process keeps a newer copy.
   - A vault with no `vault.config.json` roots at the option's folder.
   - An empty folder is seeded.
   - A non-empty folder that isn't a vault is refused and left as it was.
   - A generated `AGENTS.md` edited by hand is kept and reported.
   - The tool server runs the checkout's working `tools/` for a session inside the in-place plugin root, and `.live/tools` for any other.
   - The `post-commit` test goes.

   These use the fixture's data-folder layout (§7).
4. **`test/move.test.mjs`** (new).
   - Committed, uncommitted and untracked notes are copied, and so is an unknown file at the root.
   - Code paths are not copied.
   - A non-empty target is refused.
   - The source tree's hash list is the same before and after.
5. **`test/codex.test.mjs`.** The MCP block names `.live/mcp/launch.mjs`, and the hook command strings are unchanged.
6. **Lint.** No `node tools/` is left in the skills or in the vault part of `AGENTS.md`.

## 9. Open for the user

Answered 2026-11-03:
1. **The option:** A.
2. **Existing vaults:** copy to a new folder (§6). The old clone stays as an archive.
3. **New vaults:** a git repository.
4. **Codex-only installs:** a declared gap.

Still open:
5. **Copy:** the start-line wording for an old clone and for a vault without git, and the README's new Set up and Updating sections.
6. **The author's data folder:** its name and where it goes.
7. **Sessions in the code checkout (A):** treat them as any project, so rules reach them (the draft's default), or as the vault folder, as today.

## 10. Not doing

- No commits, and no deletions, in a user's folder. The move copies; the user deletes the old folder.
- No change to the note format.
- G1 to G3 stay as the main session builds them. A changes G3's source, not its mechanism.
