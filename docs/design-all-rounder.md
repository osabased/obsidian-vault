# All-rounder vault: design draft

Status: draft, 2026-11-01. Phases 0 to 6 are built and merged into main: phase 0 (checks), phase 1 (format), phase 2 (delivery), phase 3 (neutral fixtures), phase 4 (knowledge mechanisms) with its perf pass, phase 5 (media and tool triggers) and phase 6 (second adapter: the identifier test, the move behind the Claude Code adapter, the Codex adapter, compiled files and the provider tests). Phases 3 to 6 were each reviewed and fixed before merging.

Scope: structure, design and architecture only. This design adds no knowledge to the vault. It names no domain, platform, package ecosystem or site as built in. Where it needs an example, it uses a placeholder.

Inputs:
- Two review rounds of seven subagent reports: robustness audit, use-case walkthrough, prior-art research ×2, Claude Code native mechanisms, use-case matrix, agent-neutral boundary map.
- Two independent reviews of the first draft: one against the bar, one of the design itself.

Each claim was re-checked against the code, the docs or a live request. File:line references were re-read with `grep -n`. The files use CRLF, so tools that count `\r\n` as two lines give wrong line numbers.

A bare file name means the one file of that name in `tools/`, `tools/hooks/` or `tools/lib/`. `lint.mjs` means `tools/lib/lint.mjs`.

## 1. Goal and bar

The vault is a general LLM wiki for agents, not only a taste store. It covers three kinds of use:

- current knowledge of fast-moving APIs, libraries and platforms;
- craft taste, such as UI, VFX, GFX, UX and DX;
- any other domain, such as research, reading and the user's own notes.

The bar:

- **Native.** Every use case works through a feature built for it. A use case that needs a workaround (a field used for the wrong job, a fake project folder, the wrong kind of note) means the feature is missing. A component built for one domain counts as a workaround too.
- **Robust.** It stays correct under load and failure, and it never fails silently.
- **Universal.** It works across domains, projects, media, machines and agents. Claude Code comes first. The note format and `tools/` stay agent-neutral, and the Claude Code hooks are one adapter.

## 2. Where it stands

- **Empty wiki.** `wiki/` and `raw/` hold only `.gitkeep` files. The 15 notes ever written were deleted (9d07690, 2c55ccf). `.state/` holds 61 session files. **The note format can change now without migrating anything.**
- **Tests.** 169 tests pass (`node --test test/*.test.mjs`).
- **Use cases.** Nine were tested in a scratch copy:
  - 2 work natively: knowledge about a package library, and nested monorepo domains.
  - 4 need a workaround.
  - 3 are unsupported.
- **Domain names in shared files.** The code holds no domain logic. But one domain's name is used as the example in several places:
  - `propose.mjs:55` and `:334` (help text and an error message);
  - `.claude/skills/ingest/SKILL.md:21`, which names one platform's skills;
  - 7 lines of AGENTS.md: 6 use the domain's key, and 1 is a source URL;
  - the test fixtures. They use a `demo` domain, but with one platform's file types and page names: 86 mentions in 9 files.

  §3 says where that belongs instead.

What already holds up and stays:

- **Quote checks.** `propose.mjs` refuses a quote the user never typed in the session. It also refuses one that a cited text file doesn't hold. Lint re-checks quotes already in notes.
- **Deny-then-retry.** A PreToolUse deny shows a rule at the moment of the edit, and the retry goes through.
- **Delivery measurement.** `.state/` records what each session was shown. `/lint` uses it to report rules corrected again after being shown, and rules no session saw.
- **`.live/tools`.** Sessions run the last committed copy, so half-edited tools never run.
- **The pick chain.** `provisional`, `confirms` and `replaces` record how a decision changed.
- **Append-only `raw/`.** The edit hook and pre-commit enforce it.

## 3. Layers: where each kind of specific lives

Every specific thing has one home. The core holds mechanisms only.

| Layer | Holds | Never holds |
|---|---|---|
| **Core** (`tools/lib`, `tools/*.mjs`) | Note format, delivery, gate, quote checks, cache, refresh, lint, search. Each extension point has one fixed interface. | Any domain, ecosystem, site, agent or tool name. |
| **Extensions** (`tools/ext/<type>/<name>.mjs`) | Code that one interface needs per format, such as a lockfile reader, a media extractor or a target alias. Loaded by the name config gives it. | Notes or domain facts. Each extension is a format handler, usable by any domain whose projects use that format. |
| **Adapters** (`tools/adapters/<agent>/`) | One agent's hook I/O, tool names, session id, typed-text provider and capabilities. | Domain knowledge. |
| **Config** (`vault.config.json`, untracked `vault.local.json`) | Which domains exist, their markers, paths, feeds, sources and extensions, and `editTools`, the map of non-file edit tools (6.3b). | Code. |
| **Notes** (`wiki/`, `raw/`, `derived/`) | All knowledge and taste. | Mechanism. |

Today `tools/hooks/` is the Claude Code adapter, with core logic mixed in. Phase 6 splits it into the core and `tools/adapters/claude-code/` (6.7a).

Two rules keep the layers apart:
- **Neutral core.** A domain-specific fact anywhere outside config or notes is a bug.
  - A test fails when a configured domain's key appears in `tools/`, `.claude/skills/`, `test/` or AGENTS.md, or its title does as a whole phrase of two or more words. It reads both from config, so the test itself names none.
  - A platform named without the domain's key or title passes the test, as the fixtures' file types and AGENTS.md's examples do until phase 3. Review catches those.
- **Neutral fixtures.** The tests use invented domains of different shapes (§8, phase 3). No single real domain shapes the defaults.

## 4. Native to the vault, native to Claude Code

The bar asks for features native to the vault. Where a Claude Code mechanism does the job, the vault uses it rather than rebuilding it. Where the Claude Code mechanism loses behavior the vault needs, the vault keeps its own hook and names what would be lost.

| Need | Use | Why |
|---|---|---|
| Deny an edit and show why | PreToolUse `deny` | Holds in every permission mode, including bypass (hooks-guide). |
| Context for a subagent | `SubagentStart` `additionalContext` | Injected before the subagent's first prompt. Re-injected only when its context lost the earlier copy. Input carries only `agent_id` and `agent_type`, not the task (hooks). |
| Install hooks on any machine | Plugin `hooks/hooks.json`, with a `userConfig` option of type `directory` for the vault path | That option reaches hook processes as `CLAUDE_PLUGIN_OPTION_<KEY>`. `${CLAUDE_PLUGIN_ROOT}` is the installed copy (plugins-reference). The plugin ships the skills and the hooks (`.claude-plugin/plugin.json`, `hooks/hooks.json`). |
| A crashed gate must not pass silently | Exit code 1 with stderr | Shows a `hook error` notice in the transcript. Stderr from a hook that exits 0 is never seen (hooks). |
| Catch files a shell command wrote | A `Stop` hook that checks the working tree once per turn | The hooks guide gives this pattern with `git status --porcelain`. A Stop hook's `additionalContext` keeps Claude working and gives it the text, with no hook-error notice (hooks, 6.3d). |
| Path-scoped rules | The vault's own hook, not `.claude/rules` `paths:` | `paths:` rules load on Read too and survive compaction. But they can't deny, deliver once per session, point to pages, or wait for a note to settle. |
| Preference memory | The vault, not auto memory | Auto memory is written by Claude. The vault holds the user's verified words. |
| See what native loading injected | `InstructionsLoaded` | Observe-only. Useful for debugging, not delivery. |
| A hook served by a running process | Not used: `mcp_tool` was tested and fails open (6.7g) | A PreToolUse `mcp_tool` deny is honored. But a tool error or a dead server lets the edit through, and `onFailure: "block"` has no effect on it. |

## 5. Decisions

1. **A failed hook is loud and doesn't block.**
   - The hook exits 1 with a one-line message, so the user sees a hook-error notice and work continues.
   - An internal deadline (6.6b) turns a hang into the same notice before Claude Code kills the process.
   - Exec form (6.7d) keeps a failure non-blocking on Windows without Git Bash too, where a failed shell-form PreToolUse hook can block the call (hooks).
   - *Alternative not taken:* `onFailure: "block"` (v2.1.295+), which stops every edit while the vault is broken.
2. **Typed text comes from a provider per agent.**
   - Claude Code's provider reads the transcript, which marks each turn's origin (`origin.kind`, `human` or `task-notification`, read by `quotes.mjs:11`).
   - `UserPromptSubmit` input has no origin field. It also fires for `/loop`, scheduled tasks, background subagent reports and cross-session messages (hooks).
   - The transcript format is documented as internal and changing, so a test pins the fields the provider reads.
   - *Alternative not taken:* a hook-written prompt log everywhere, which would count non-human turns as the user's words.
3. **Edits are gated wherever the agent exposes them; shell writes are caught after the fact.**
   - A non-file edit tool, such as an MCP tool that edits objects in a running app, is mapped by config to a target namespace (6.3b). Its edits are then gated like file edits, and no code names the tool.
   - Shell writes are caught by a `Stop` hook once per turn, and Claude is sent the rules for the files they touched (6.3d).
   - `Bash|PowerShell` is out of the PreToolUse matcher (`hooks/hooks.json`). It started a hook for every shell call, which the edit hook returned from at once.
   - *Alternatives not taken:* one adapter per edit tool, written in code; and denying shell writes to rule-covered files through permission rules.
4. **Agents without hooks get compiled rule files, written by a command the user runs.**
   - `node tools/compile.mjs <project>` writes into a project only when `vault.config.json` opts that project in.
   - Neither the hooks nor the agent write them mid-session, and AGENTS.md's "Write outside the vault" gains that one named exception.
   - *Alternative not taken:* never write into projects.
5. **Codex is the second adapter.**
   - *Alternative not taken:* Cursor.
6. **Everything due on an edit arrives in its one refusal.**
   - The first edit to a file is denied once. The refusal shows the matching rules, and pointers with summaries to the matching pages.
   - PreToolUse `additionalContext` is placed next to the tool's result (hooks), so a page pointer sent with an allowed edit (today, `edit.mjs:141-142`) reaches the agent only after the code is written.
   - This changes AGENTS.md's "A page never refuses an edit".
   - *Alternative not taken:* keep page pointers on allowed edits. It costs no retry, but the page arrives too late to shape the edit.
7. **The core holds no domain knowledge (§3).**
   - Per-format code is an extension behind a fixed interface, chosen by config.
   - Per-tool mappings are config data.
   - *Alternative not taken:* built-in support for a first domain, which would shape the defaults around it.

## 6. Design

Each item gives the problem with its evidence, the design, and the check that shows it works.

- Claims are verified unless marked *(inferred)* or *(unverified)*. §11 collects the unverified ones.
- Items marked **build-or-reuse** need code that parses a format or calls an external tool. They need a candidates pass before anything is committed. The design fixes only their interface, and they ship as extensions (§3).
- Items marked **scale** are designed now. They are built only when `latency.mjs` (§9) goes red.

### 6.1 Note format (changes are free now)

Phase 1 settles every field in this section, plus:
- the derived-text and bundle formats (6.4a, 6.4b);
- target namespaces (6.3b);
- `tools` (6.3c).

Phase-3 notes then need no migration, even where the tooling lands later.

**a. Reach not tied to listed folders.**
- *Problem.*
  - A domain reaches only the project folders listed for it (`vault.mjs:54`).
  - A project folder not in the config gets only `global`. The session isn't registered either, so it can't propose.
  - On a second machine with other paths, the hooks go silent with no warning.
- *Design.* A domain declares its reach in `vault.config.json`:
  - `markers`: file names that put a folder in the domain, such as a manifest or project file every project of that kind has.
    - An edit takes its domains from the nearest marker at or above the edited file, as the gate already resolves domains from the file (`edit.mjs:83-84`, `domainsFor(file, cwd)`).
    - Session start and prompts take theirs from markers at or above the session's folder, and from markers below it to a set depth. So a session at a monorepo root hears each package's domains. Session start scans below once and caches the result for the session, so prompts don't walk the tree.
    - VS Code's `workspaceContains:<glob>` activation event detects a project kind the same way (https://code.visualstudio.com/api/references/activation-events).
  - `paths`: folders, as today. Paths differ per machine, so they move to an untracked `vault.local.json` keyed by domain. `vault.config.json` keeps only what every machine shares.
  - `everywhere: true`: the domain's pages and keyword rules reach every session. It is opt-in.
  - `vaultOnly: true`: pages only, as a research domain with `projects: []` is today (AGENTS.md:11). It is explicit, since paths are per machine and missing reach would make it differ by machine. A domain that reaches nothing here and isn't `vaultOnly` gets a lint warning naming `vault.local.json`.
- *Check* (fixture domains):
  - A session in an unlisted folder holding domain A's marker gets A's rules and can propose.
  - In a monorepo, an edit under `packages/a/` (A's marker) gets A's rules, and an edit under `packages/b/` (B's marker) gets B's.
  - An `everywhere` domain's keyword page reaches a prompt in any folder.
  - Lint reports a configured path that doesn't exist on this machine as an error.

**b. Every note on every channel.**
- *Problem.* Knowledge rules take no `keywords` or `always` (`rules.mjs:146`; AGENTS.md:62), so a chat question about an API gets nothing. Pages come up only as a path pointer.
- *Design.*
  - Every note takes the same scope fields: `always`, `applies_to`, `keywords`, `triggers` and the new `tools` (6.3c).
  - On an edit, rules and pages arrive together in the one refusal (decision 6). A page pointer carries its summary as well as its path.
  - Lint warns on `always` for a knowledge rule over a small size, since always-on context is budgeted (6.6e).
- *Check.* A prompt that names an API in a fixture domain's session delivers the knowledge rule with that keyword.

**c. Versions.**
- *Problem.* v2 and v3 rules for one library on the same globs are both delivered, and `review status` ranks v3 first in a project pinned to v2.
- *Design.*
  - **Field.** A knowledge rule or page may take `requires`, a list shaped as OSV's `affected` entries (https://ossf.github.io/osv-schema/):

    ```yaml
    requires:
      - package: { ecosystem: <reader>, name: <package> }
        ranges:
          - type: SEMVER
            events: [{ introduced: '2.0.0' }, { fixed: '3.0.0' }]
    ```

  - **Version readers** are extensions (`tools/ext/readers/`). Each one has the same interface:
    - the ecosystem name it answers to;
    - the lockfile names it reads;
    - `read(projectDir)`, which returns `{ package: version }`;
    - its version scheme: `SEMVER`, or OSV's `ECOSYSTEM` with a `compare(a, b)` it supplies.
  - **Config.** A domain names the readers its projects use, so the core names no ecosystem.
  - **Lockfiles, not manifests.** Manifests hold ranges; lockfiles hold the versions installed.
  - **When.** Versions are resolved once, at session start, and cached per project in `.state/` until a lockfile changes.
  - **No version.** When the version can't be read, or a domain has no reader, the rule is delivered labelled "version unknown".
  - **Ranking.** Between knowledge rules, a version match counts first, then `as_of`.
  - **Platforms with no pin.** A platform that no project file pins, such as a hosted service or a runtime that updates itself, takes no `requires`. Its knowledge stays current through `as_of` and source refresh (6.2a).
  - The readers themselves are **build-or-reuse**, and are added when a domain needs them.
- *Check.* With a fixture reader:
  - a project whose lockfile has `pkg` 2 delivers only the v2 rule, and `review status` ranks it first;
  - with no lockfile, both rules are delivered as "version unknown".

**d. Source fields.**
- *Design.*
  - A saved source in `raw/refs/` starts with `url`, `fetched`, `etag`, `last_modified` and `sha256` (of the body). A git source gives `repo`, `path` and `commit` instead.
  - Refresh (6.2a) uses these fields.
  - A re-fetched file with the same URL but a new hash counts as a new version, not an already-named source. `review.mjs:124-162` already matches a saved copy by URL and hash (`sources.mjs:153-165`).

**e. Locators.**
- *Problem.* Lint warns on footnotes such as `real.pdf#page=3` and `talk.mp4 @ 00:12:31` (`lint.mjs:208`).
- *Design.*
  - Footnotes take standard fragments:
    - `#page=N` for PDF (RFC 8118);
    - `#t=hh:mm:ss` for audio and video (W3C Media Fragments);
    - `#L10-L20` and a commit for code.
  - Lint checks that the anchor exists in the source's derived text (6.4a).

**f. The user's own notes.**
- *Problem.*
  - Pages are "in the agent's words" (AGENTS.md:78), and `raw/` is append-only, so the vault has no place for a note the user writes and keeps editing.
  - `noteGuard` (`edit.mjs:52-70`) protects only `## You said` and `## Evidence` (`rules.mjs:462`). So `/ingest` or `/lint` may rewrite the body of a page the user wrote.
  - Lint asks such a page for a topic, summary and source like any other.
- *Design.*
  - A page with `author: user` is the user's own writing, in any page kind. The default is `author: agent`.
  - The agent may only add lines under `## Agent notes`, and `noteGuard` denies any other change to the file.
  - Lint doesn't require `summary` or `topic` on it. `/ingest` and `lint --fix` leave it unchanged.
  - Its text counts as the user's words. A rule may quote it as `basis: stated`, citing the note's path, and the quote is checked against the file.
- *Check.*
  - An Edit that changes a user note's body is denied; one that adds a line under `## Agent notes` passes.
  - A rule quoting a sentence the note doesn't hold is refused.

**g. Small format fixes.**
- **Negated globs.** `applies_to` accepts `!` exclusions with gitignore meaning. Today `glob.mjs` reads `!` as a literal character, so `'!src/**/*.test.ts'` still matches test files and lint says nothing.
- **Pick domain.** Pick rows take a `domain`, checked against the session's co-located domains. Today a pick goes to the first one (`pick.mjs:53`), and `propose` then refuses to cite it for another domain.
- **One file per session.** `raw/inbox` and `raw/picks` rows go to one file per session (`<date>-<session8>.jsonl`), so two clones writing on the same day don't conflict in git.
- **Rule length.** Knowledge rules get a longer cap than taste rules. The 300-character cap (`propose.mjs:347-348`) is tight for API facts.
- **Unicode slugs.** Slugs accept lowercase Unicode letters. `KEBAB` (`rules.mjs:21`) forces ASCII today.

### 6.2 Knowledge: freshness, doc sets, scale

**a. Freshness.**
- *Problem.*
  - Staleness is only an age warning in lint (`lint.mjs:97-100`), and the hook keeps delivering a 303-day-old rule.
  - Nothing reads `fetched`.
- *Design.* `node tools/refresh.mjs` checks every source by its kind:
  - **URL sources.**
    - Refresh re-fetches with `fetch`, sending `If-None-Match` and `If-Modified-Since` (built in).
    - A 304 is recorded as a check.
    - A new hash saves the new body as a new file in `raw/refs/`, so append-only holds.
  - **Git sources.**
    - A source repo is cloned to an untracked `.sources/<name>/`.
    - A note cites a file in it by path and commit. Refresh saves a changed file as a new copy with `git show <commit>:<path>`, and quotes are checked against the saved copy.
    - Refresh runs `git fetch` and `git log <cited>..FETCH_HEAD -- <path>` to find cited files that changed.
    - A commit is a version, so no ETag or feed logic is needed, and nothing in `raw/` is rewritten.
  - **Feeds.**
    - A domain may list `feeds` (RSS or Atom).
    - Refresh uses a conditional GET where the feed sends an ETag, and otherwise compares the feed's last-updated date.
    - New items are listed as unnamed sources for `/ingest`.
    - Feed parsing is **build-or-reuse**.
  - **Unverified state.**
    - A note is unverified when a source it cites has changed since the version it cites.
    - Refresh and build write this derived state to `.state/derived.json`, and hooks read it rather than working it out.
    - Delivery labels an unverified rule "source changed on <date>", or "source changed" when no newer copy has a valid fetched day. The shown-marker includes that state, so a rule shown earlier in the session is shown again once it turns unverified.
  - **Reporting.** `/lint` lists unverified notes and runs refresh. A session-start line counts sources not checked within the domain's `checkAfterDays`. `staleAfterDays` and `checkAfterDays` are set per domain.
  - **Newer sources.** `newerSources` (`review.mjs:106-119`) compares a rule only with sources in its own domain and topic. It now checks every source the rule cites, in any domain.
- *Check* (fixture sources served locally):
  - A cited URL source re-fetched with a changed body turns its rule unverified, in delivery and in `/lint`. An unchanged body (304) changes nothing.
  - A cited file in a fixture git repo changed upstream turns its rule unverified after refresh.

**b. Doc sets.**
- *Problem.* Saving every page of a large doc site as a source does not scale. On a measured site of 2,323 pages this would give:
  - a 359 KB `index.md`;
  - a 7 KB topic sentence at session start;
  - 2.4 s session starts;
  - about 700 ms per prompt and per edit.
- *Design.*
  - **One source.** A doc set is one source: the site's saved manifest.
    - The manifest is `llms.txt` (https://llmstxt.org) where the site has one. A `sitemap.xml` manifest waits for the XML seam (§8 item 4).
    - Refresh fetches it conditionally like any URL source.
  - **Cited pages only.** A page from the set is saved to `raw/refs/<set>/` only when a note cites it, which the quote check needs anyway. Refresh diffs the manifest and the cited pages.
  - **Live reads.** The agent reads uncited pages live, through the manifest's links or whatever fetch tool it has.
  - The vault holds what training gets wrong and where to look, not a mirror.
- *Check.* A fixture domain with a 2,000-link manifest and 50 cited pages starts a session in under 500 ms when nothing changed, and in under 1,000 ms when a cited page has just landed and the start builds.

**c. Scale.**
- *Problem.* Every hook call starts a new `node` process and re-reads the vault. On Windows, Claude Code runs a command hook through Git Bash unless it uses exec form (6.7d). Inside Claude Code 2.1.296, a trivial node hook takes 148–165 ms through Git Bash and 100–114 ms in exec form, which skips the shell (phase 2 trial). Node's own start is 23–29 ms of that (6.7g trial). Exec form leaves about 190 ms of the 300 ms target below for the vault's own work. `loadNotes` (`rules.mjs:157`) reads every note in `wiki/**`:
  - a gated edit takes 808 ms at 1,000 notes and 2.4 s at 3,000;
  - 16 parallel edits at 3,000 notes take 8.3 s each;
  - at 3,000 notes, a stat-only pass takes 175 ms and reading and hashing every note 1,678 ms.

  Each session start also runs a full `build()` (`session-start.mjs:83`).
- *Design.*
  - **One cache.** Parsed notes are cached in `.state/cache/<folder>.json`, one file per folder of `wiki/` (`cache.mjs`), keyed on path, mtime and size, with each note's body hash. A note is read and hashed only when its stat changes. Settling (6.6d) uses the same cache.
    - Folders are matched to config domains by their NFC names, since the config names domains in NFC and a file system may store a folder NFD.
    - The cache's stamp hashes `frontmatter.mjs`, `cache.mjs` and the source of the `parsed` reader in `rules.mjs`, so a change to any of them reads every note again.
    - The cache only saves reading time, so its writes are best effort: a failed write is logged once, and the call goes on with what it read.
    - A note that fails to read keeps its old entry. A note with no entry rethrows, so it is never dropped silently.
    - A walk stopped at the deadline saves what it read, and drops none of the notes it didn't reach, so the next call goes further.
    - An entry is trusted once its read time and mtime are 2 s apart in either direction, so a file dated in the future isn't read again on every call.
    - On Windows a stat opens the file, so the hooks start every note's stat at once and read the cache files while they run (`noteStats`); at 3,000 notes that takes about 30 ms against about 90 ms one at a time.
    - The deadline is checked between files, not while those stats run, so a hook past it stops at the first check after them.
    - A cache hit opens no file, so a note changed within one mtime and size, read more than 2 s after it was saved (`cp -p`, an archive extract, a swap by rename), keeps its old text until its size or mtime changes. The copies in `raw/refs/` are cached on the same terms (`cachedFiles`): lint, and the chains refresh builds, keep such a copy's old frontmatter. A copy whose lstat fails, or whose entry is of the wrong shape, is read again instead.
    - Refresh reads the latest copy of each source itself, once, for the frontmatter and the text its check goes by, and stops with `can't read` for one it can't open, as it did before the copies were cached.
  - **Scoped walk.** Hooks walk only `wiki/<the session's domains>/` and `wiki/global/`. The `/lint` reminder still counts notes vault-wide: the walked notes reuse their stats, and the other folders are stat'ed only, never parsed (`noteTimes`).
  - **Derived state** (unverified, settled) is precomputed by refresh and build (6.2a), and hooks read it.
  - **Build on change.** Session start builds only when a fingerprint changed or `derived.json` is missing or corrupt. The fingerprints, in `.state/cache/.built.json`, hash each folder's notes, the config except each domain's `paths`, which differ per machine and shape no generated file, and a stat walk of `raw/refs/` (each file's path, size and mtime), since a copy pulled from another machine changes no note, and a hash of the files derive runs from (`sources.mjs`, `rules.mjs` and `frontmatter.mjs`), so a commit that changes how derive reads them is not skipped. Derive keeps each copy's frontmatter in `.state/cache/.refs.json`, keyed on its lstat, and reads only the copies whose size or mtime changed, but it still stats every copy, so a build skips it while neither the notes, `raw/refs/` nor that code changed since the last build; the build refresh runs always derives. Every build that writes records them (`build.mjs`), so propose, pick, lint and pre-commit keep them current. A dot name keeps the file apart from the folders' cache files.
  - **scale:**
    - `index.md` lists domains and their topics, and each domain's notes go in `index/<domain>.md`.
    - Session start names a set number of topics per domain, ranked by note count, then "and N more in index/<domain>.md".
- *Check.* `latency.mjs`: the fastest of 5 gated edits stays under 1,000 ms at 1,000 notes (781 ms before the cache). The target with the cache is under 300 ms at 3,000 notes.

### 6.3 Reach: subagents, edit surfaces, tools, shell writes

**a. Subagents.**
- *Problem.*
  - There is no `SubagentStart` hook.
  - The gate id (`edit.mjs:103`) has no agent, while page markers do (`sessions.mjs:71`). So a subagent editing a file its parent was gated on gets no rule.
  - A read-only reviewer never edits, so it gets nothing.
  - `pick show` drops knowledge rules and other co-located domains (`pick.mjs:217`).
- *Design.*
  - A `SubagentStart` hook injects the domains' always rules and topics. Its input has only `agent_id` and `agent_type`, not the task, so the builder still pastes `pick show` output into a reviewer's prompt, as AGENTS.md says under Picks.
  - The gate id adds `agent_id`.
  - `pick show` lists taste and knowledge rules for every co-located domain.
- *Check.*
  - A subagent editing a file its parent was gated on is refused once more.
  - A subagent's first context holds the always rules.

**b. Edit surfaces.**
- *Problem.*
  - `edit.mjs:126` returns unless the tool is Edit, Write, MultiEdit or NotebookEdit (`vault.mjs:257`).
  - An MCP tool that edits objects inside a running app passes an object path in its input, not a file path. No glob matches it, and the object may have no file at all.
- *Design.*
  - **Target namespaces.**
    - A rule's `applies_to` takes globs over a namespace, written `'<namespace>:<glob>'`. A bare glob is the `file` namespace, as today.
    - Each namespace is declared in config, with its separator and how names escape it. So the core knows how to match, not what any namespace means.
  - **Tool map.**
    - Config's `editTools` maps each non-file edit tool to its namespace and to the input fields holding the path and the new text, for example:

      ```json
      "editTools": { "<tool name>": { "namespace": "<ns>", "path": "tool_input.<field>", "after": "tool_input.<field>" } }
      ```

    - The adapter reads the map, so `triggers` work on the new text, and adding a tool needs no code.
  - **Aliases.**
    - An alias extension (`tools/ext/aliases/`) maps a path in one namespace to another, such as an object path to the file a build tool syncs it from.
    - An edit then also matches the other namespace's globs, so one rule can cover both.
    - The alias is optional, and works only where the project has the file it reads.
  - **Gap.** A tool that runs arbitrary code, like a shell, has no target to map, and stays a declared gap (§7).
- *Check* (fixture namespace and tool):
  - A mapped tool call on `<ns>:A.B.C` is denied once by a rule on `'<ns>:A.**'`, then goes through.
  - With a fixture alias, the same call is also denied by a rule on the mapped file's glob.

**c. Tool triggers (UX and DX).**
- *Problem.* Taste reaches the agent only through file globs and prompt keywords. A flow decision made before any edit, or one made through a design tool, gets nothing.
- *Design.*
  - A `tools` field holds exact tool names, such as `AskUserQuestion` or an MCP tool's full name.
  - The first matching call in a session is denied with the rule, and the retry goes through, as for edits. A deny is used because PreToolUse `additionalContext` arrives after the call.
  - **Matcher.** The PreToolUse matcher in `hooks.json` is fixed when the plugin ships. It names no user's tools, and anchors itself, since Claude Code tests a matcher holding regex characters unanchored: `^(?:Edit|Write|MultiEdit|NotebookEdit|AskUserQuestion|mcp__.*)$`.
    - An MCP call that maps to nothing costs what an edit outside every glob costs: the hook's process start, about 100 ms in exec form, 150 ms through Git Bash (6.2c), then the notes from the cache and one pass over `liveRules` (8.5, Latency).
    - Read, Grep, Glob and shell calls stay out of the matcher, as decision 3 has it.
  - **Lint** tests each note's `tools` names and each `editTools` key in config against the matcher. It reports one the matcher misses as an error, since that tool would never be gated.
  - A denied `AskUserQuestion` never reaches the user, so the cost is one agent retry, not a user turn *(inferred)*.
- *Check.* The first `AskUserQuestion` in a session with a UX rule on it is denied with the rule; the second goes through.

**d. Shell writes.**
- *Problem.* No event gives the file and its new text before a shell command writes. `FileChanged` runs after the write, can't block, watches literal absolute paths only, and its `systemMessage` reaches the user's terminal, never Claude.
- *Design.*
  - A `Stop` hook runs `git status --porcelain` in the project once per turn, as the hooks guide suggests, through the one module allowed to run git (6.6d).
  - The prompt hook records when the turn started. Stop considers only changed files saved after that, so files the user changed earlier in their own editor don't count.
  - An Edit or Write call that a rule covers writes a turn-scoped file marker (`gatedFile`, `scope.mjs`), so the changed files left unmarked are the ones a shell command wrote. A file the user saves in their own editor during the turn is counted too, which costs at most one extra continuation. A later turn checks the file again.
    - The same-turn gap is accepted: an Edit that passes with no rule due, because a trigger missed its text, followed by a shell write to that file in the same turn, goes unchecked.
  - The vault's own files are skipped through one `vaultOwn(rel)` predicate (`vault.mjs`), which the edit guard shares.
  - For each changed file whose matching rules this session (and agent) hasn't been gated on, the hook returns those rules as Stop `additionalContext`. The turn continues, and Claude re-reads its change against them before stopping.
    - The lead line is "Taste rules apply to a file this turn wrote. Re-read the change against them before you stop.", or with several files "Taste rules apply to files this turn wrote. Re-read the changes against them before you stop."
    - Triggers are tested on the whole file text as `plainText` gives it (LF line ends, BOM stripped), the text the edit hook tests. The text is read only when a due rule has triggers, and triggers aren't tested on a file over 1 MiB.
    - Every due rule is gated on its file; only those the output budget kept count as shown.
  - Not `decision: "block"`. It continues the turn too, but tells the user "Stop hook error occurred", so routine rules would look like the vault failing (phase 2 trial). Both work in bypass mode.
  - The gate markers keep it to one continuation per file, and Claude Code ends the turn after 8 stop-hook continuations in a row (hooks). `stop_hook_active` is ignored: honouring it would skip the files a continuation writes.
  - A project that isn't a git repo gets no detection, which the adapter declares.
- *Check.* A turn that writes a rule-covered file with a shell command and stops is sent that rule once and continues. The next stop passes.

### 6.4 Sources and evidence

**a. Media.**
- *Problem.*
  - `sourceTexts` returns null for a file that isn't UTF-8 (`quotes.mjs:91`), so a fabricated quote against a PDF or mp4 was written as a rule.
  - Pick sheets must be png, jpg or webp (`pick.mjs:78`).
- *Design.*
  - **Where derived text lives.** A binary source's extracted text goes in `derived/<sha256>.md` at the vault root, keyed by the binary's hash.
    - It is tracked in git, so clones agree.
    - It sits outside `raw/`, so a better extraction can replace it.
    - `review.mjs sources` doesn't list it as a source to ingest.
  - **What it holds.** The binary's kind (pdf, video, audio or image), the extractor and its version, and the text with anchors (`[p. 3]`, `[t=00:12:31]`). Lint checks that the hash still matches the binary, and re-checks quotes when the text is replaced.
  - **Quotes.** Quotes are checked against the derived text. A quote against a binary with none is refused with "add derived text".
  - **Images.** An image's caption is the agent's reading, so it backs `basis: reading` only.
  - **Extractors** are extensions (`tools/ext/extractors/`) with one interface: `kinds`, then `extract(file)` returning text with anchors. PDF text, transcription and OCR are **build-or-reuse**. The vault stores only the result.
  - **Sheets.** Any media with derived text can be a pick sheet.
- *Check.* A fabricated quote against a fixture PDF with derived text is refused; a real one passes.

**b. Bundles.**
- *Problem.* A folder can't be a source (`lint.mjs:290`), so a 500-file repo needs 500 source pages.
- *Design.* A folder under `raw/refs/` with a `source.md` manifest is one source. The manifest gives a `url` and a commit, or a `sha256` per file. Footnotes locate inside it by path and line. A public repo can be a git source (6.2a) instead.

**c. Unverifiable evidence says so.**
- Lint warns, naming the reason, on a quote it can't check: a binary with no derived text, a URL source, or a session no longer registered. Today `checkTyped` (`lint.mjs:216`) passes silently when the transcript is gone.
- When a transcript has been pruned, lint checks the quote against the `raw/inbox` or `raw/picks` row that recorded it, which was verified when written.
- `pick.mjs` checks `notes` and comment `text` against what the user typed. Today it imports no quote check, yet `propose.mjs:139-145` cites a row's `notes` as the user's words.

**d. Unicode.** No change. Search tokens (`search.mjs:31`) and quote boundaries (`quotes.mjs:44`) split on runs of Unicode letters and digits, and search folds diacritics, so every language written with spaces works today. Word segmentation for languages written without spaces is not done (§12).

**e. Privacy (small, optional).** `/ingest` refuses to save a source holding something shaped like a key or token, and lists the matches for the user to remove.

### 6.5 One refusal per file

- *Problem.* At 3 rules per refusal (`maxRulesPerEdit`, `edit.mjs:111`), 20 rules on one glob refused the first edit of each file 7 times, though AGENTS.md says "The retry goes through".
- *Design.*
  - The first refusal shows the top rules in full, the rest as one-line pointers, and the due pages as pointers with summaries (decision 6), all within the budget (6.6e).
  - It gates every due rule and page on the file, so the retry passes. It counts as shown only what `fitContext` kept, rule pointers included.
  - Rules the budget cut stay gated after the refusal. This is a trade-off the user chose: gating only the kept rules would bring back repeat refusals. The overflow line says how many it left out and points to `index.md`, which lists them.
  - Pages are gated per file, and told of once per agent. A page the budget cut is gated on that file but not marked as told of, so it comes up on the next file it covers.
  - The other hooks follow the same rule: each counts as shown, and marks delivered, only what survived `fitContext`.
    - The exception is the always rules that session start's block cut for its own cap. They are marked, since the block points to `active.md` for them.
    - A session-start always block that the budget drops whole marks nothing, so the next prompt delivers it.
- *Check.* 20 rules and 2 pages on one glob refuse the first edit once, and the retry passes.

### 6.6 Hooks that never fail silently

**a. Loud failure.** `runHook` (`vault.mjs:261-269`) catches every error, logs it and exits 0, so neither Claude nor the user sees it. It now writes one line to stderr ("vault <hook> failed: <message>; see .state/errors.log") and exits 1.
- Claude Code records that line as a hook error for SessionStart, UserPromptSubmit, PreToolUse, Stop and SubagentStart, and the action goes ahead. A Stop failure also raises a "Stop hook error occurred" notice (phase 2 trial).
- A failure inside a subagent is recorded in the subagent's transcript only (§7). SubagentStart is not inside: its failure shows in the main session's stream (phase 2 plugin trial, headless).

**b. Internal deadline.**
- A hook killed at its timeout prints nothing and logs nothing.
- Hook input carries no timeout field, and a command hook has no per-hook env field. So `hooks/hooks.json` passes the timeout as an exec-form arg, `hooks/launch.mjs <hook> <seconds>`, next to `timeout`, and the launcher sets `VAULT_HOOK_TIMEOUT` from it.
- `runHook` arms the deadline, so scripts and lint, which have no timeout, never hit it. Each hook checks the deadline (that timeout minus a margin of 1 s, or a fifth of a shorter timeout) between notes. Past it, the hook stops, writes the notice and exits 1.
- `guarded()` rethrows a deadline error (`code: 'EDEADLINE'`) rather than logging it and going on, so a missed deadline fails loudly instead of running into the silent kill.
- git, which can't call the check, gets a timeout capped at the time left before the deadline (`remaining()`, `deadline.mjs`).
- A JS timer can't fire during a long synchronous regex, so the check runs in the loop, and 6.6c keeps each test short.

**c. Regex cost.**
- *Problem.* `tryRegex` (`rules.mjs:60-62`) only checks that a trigger compiles. A trigger of the form `X\(.*,.*,.*,.*\)` took 17.5 s on an 820-character line.
- *Design.*
  - Triggers compile with no flags, so V8's linear engine is a drop-in: `new RegExp(p, 'l')` ran a hostile 411-character input in 1 ms, against 1,211 ms when backtracking.
  - `rules.mjs` calls `v8.setFlagsFromString('--enable-experimental-regexp-engine')` at module load. This works in-process; the flag is not allowed in `NODE_OPTIONS`.
  - The engine refuses backreferences, lookaheads (`(?=`, `(?!`), the `i` and `u` flags, and large counted repeats like `a{1000}`. It accepts lookbehind. Lint and propose refuse a trigger it refuses, with that reason.
  - Keyword matching (`rules.mjs:65`) builds its own pattern around an escaped word, with a lookahead and `i`. It stays on the default engine, since it can't backtrack badly.
  - Without the flag, `new RegExp(p, 'l')` throws "Invalid flags". Then `tryRegex` returns null, and every rule with triggers is reported as a bad regex (`rules.mjs:151`). A test pins that the flag works on the installed Node.
- *Check.* The slow trigger above finishes in under 10 ms on the 820-character line. A trigger with `(?=` is refused by propose with the linear-engine reason.

**d. Settle by content.**
- *Problem.*
  - Settling compares mtimes (`rules.mjs:241-244`).
  - A git checkout or sync gives every note a fresh mtime. For 60 s, session start then delivers no always rules and the edit gate is off.
  - A note with a future mtime never settles and is never reported.
- *Design.* Settling uses the cache from 6.2c. A note is settled when any of these holds:
  - git reports it unchanged from HEAD, since committed content isn't half-typed;
  - its mtime is older than `settleSeconds` and not in the future;
  - its hash has been seen unchanged for `settleSeconds`.

  How the first test runs, and the other paths in:
  - It costs one `git status --porcelain -- wiki/`, run only when the cache sees a stat change. It needs no installed git hooks; `.githooks/` only runs after `git config core.hooksPath .githooks` (README.md:24), which a fresh clone lacks.
  - That call, and the Stop hook's `git status --porcelain` (6.3d), are the one exception to "no child processes" in hooks (`tools/CODING_STANDARDS.md:14`, `:40`) and to lint's ban on `node:child_process` (`lint.mjs:467`):
    - One `lib/` module runs `git status --porcelain` with a timeout, and nothing else imports `node:child_process`.
    - When git is missing, fails or times out, settling uses the other two tests and the Stop hook does nothing.
    - Phase 2 changes the standard and the lint check to allow that module only.
  - `propose.mjs` records its own note as settled.
  - A vault that isn't a git repo uses the other two tests.
  - A future mtime falls back to the hash test, and lint warns on it.
- *Check.*
  - After a checkout that touches every note, session start still delivers always rules and the gate still refuses.
  - On a fresh clone with an empty `.state/`, every committed note applies at once.
  - A note with a future mtime is delivered once its hash has held for 60 s.

**e. Output budget.**
- *Problem.*
  - Claude Code caps `additionalContext` and stdout at 10,000 characters. Over that, Claude gets a file path and a 2,000-character preview, and isn't told to read the file (hooks).
  - The always block is capped as a whole at 60 lines and 4,096 bytes (`rules.mjs:325-342`). But `late()` (`prompt.mjs:7`) skips that cap, the topic list is unbounded, and nothing budgets the whole output.
- *Design.* Every hook's output fits `delivery.maxContextChars`, 8,000 by default. It is filled in rank order (errors, always rules, matched rules, pages, topics), with an overflow line naming the index.
- *Check.* Session start in the vault folder with 10 fixture domains stays under 8,000 characters and names what it left out.

**f. Lock.**
- *Problem.* `withLock` (`vault.mjs:288-295`) has three faults:
  - it gives up after 3 s, while a propose holds the lock for 5.6 s at 3,000 notes;
  - it treats a lock as stale after 10 s;
  - it releases without checking its owner.
- *Design.*
  - The lock file holds an owner token, `<pid>:<random>`, and release removes only its own. A waiter waits up to 60 s.
  - A dead owner's lock is stale at once. A live owner's lock goes stale at 30 s, since Windows reuses pids and a dead owner can look alive; 30 s passes well before a waiter gives up and well after the longest real hold. A lock file with no token yet goes stale at 10 s.
  - `withLock` gives up with an error whose `code` is `'ELOCKED'`, so a caller can tell a lock timeout from a real failure.
  - Builds run one at a time. `build()` takes `build.lock` and loads the notes inside it, so a build that read the notes before another's note landed can't write last without it. This covers propose, pick, session start, `build.mjs` and `lint --fix`.
  - Session start waits for `build.lock` at most `min(2 s, time left)`. When another build holds it, session start skips its own build, since that build writes what changed.
- *Check.* Three parallel proposes at 3,000 notes all succeed.

**g. Bounded housekeeping.** `tidy` (`sessions.mjs:181-194`) runs in session start (`session-start.mjs:74`) and took 5.3 s at 20,000 markers. Session start now removes at most `delivery.tidyMaxMarkers` (2,000) marker files per run, and `/lint` runs a full tidy. An unregistered session's age is read from its marker folders' mtimes, so a partial prune restores the folder's mtime, and the rest isn't kept another 30 days.

**h. Small fixes.**
- A folded YAML `summary: >-` read as `">-"`. Block scalars now parse to their text: `>` folds lines with spaces, and `|` keeps them, with their indentation relative to the first line. Lines starting with `#` inside a block are dropped, where YAML would keep them (a known limit of `frontmatter.mjs`).
- Paths with the `\\?\` prefix match no domain.

### 6.7 Adapter boundary

**a. Core events.** The core takes plain events and returns `{ context?, deny? }` (§8 item 6, Events):
- `start { session, cwd, transcript, reason }`, where `reason` is `new`, `resume`, `compact` or `clear`;
- `prompt { session, agent?, cwd, transcript, text }`;
- `preTool { session, agent?, cwd, tool, args, target?, added?, after? }`, where `target` is `{ namespace, path }` and `after` is a function from the file's text to its text after the call;
- `subagentStart { session, agent, cwd }`;
- `stop { session, agent?, cwd }`.

An `answer` event and `block` and `notice` results wait for an agent that needs them. Claude Code and Codex both reach the typed-text provider through their transcripts, and neither needs the others.

The result has no `allow`. A PreToolUse `allow` skips the permission prompt the user's mode would show (6.7g trial: "Hook approved tool use for Edit, bypassing permission prompt"). So an adapter maps "no objection" to no output, never to `allow`.

The Claude Code adapter maps hook I/O (`hookSpecificOutput`, `permissionDecision`, `additionalContext`, which on Stop continues the turn), tool names and `CLAUDE_CODE_SESSION_ID` to these. §8 item 6 (Inventory) lists where the coupling sits today, by line.

**b. Capabilities.**
- Each adapter declares what it can do: deliver at start, deliver per prompt, deny, block a stop, the subagent event, its session-id variable and its typed-text provider.
- Where one is missing, the core falls back. Keyword rules move into the start block.
- An agent with no typed-text provider can propose with `reading`, `source`, `failure` and `pick` only, as `propose.mjs:118-121` already does.
- Claude Code and Codex have every event, so phase 6 declares the capabilities and builds no fallback (§8 item 6).

**c. Typed-text provider.**
- The provider takes a session and returns what the user typed.
- Claude Code's provider reads the transcript and keeps turns whose `origin.kind` is `human` (`quotes.mjs:11`).
- A test pins the transcript fields it reads, so a format change fails a test instead of silently passing or refusing quotes. *(unverified: the `origin` field is observed in transcripts, not documented.)*
- The test has two halves (§8 item 6, Tests). A fixture half pins each adapter's provider in the default run. A live half checks the same fields in this machine's newest transcript.

**d. Packaging.**
- The plugin ships `hooks/hooks.json` and a `userConfig` option `vault` of type `directory`.
- Each hook is a command hook in exec form, which runs with no shell: `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/launch.mjs", "<hook>", "<seconds>"]` (hooks). This skips the Git Bash start on Windows (6.2c). The seconds repeat the hook's `timeout` for the deadline (6.6b).
- The launcher reads `CLAUDE_PLUGIN_OPTION_VAULT` and imports the hook from that vault's `.live/tools/`. So the installed plugin copy never goes stale against the vault.
- On Windows the launcher reads a Git Bash spelling, `/c/...`, as `C:/...`. It refuses a relative path with a hook error, since one would name a different folder in each session.
- The plugin reference confirms each part: `userConfig` takes type `directory`, hook processes get `CLAUDE_PLUGIN_OPTION_VAULT`, and `${CLAUDE_PLUGIN_ROOT}` resolves in exec-form `args`. On Windows, exec form needs `command` to resolve to a real executable, which `node.exe` is.

**e. Codex.** Codex CLI 0.153.4, from its docs (https://learn.chatgpt.com/docs/hooks) and source (https://github.com/openai/codex, tag `rust-v0.153.4`); §8 item 6 lists what each fact rests on.
- Its hook config has Claude Code's shape and event names, and the same PreToolUse deny.
- SessionStart, UserPromptSubmit and SubagentStart take `additionalContext`. Stop doesn't: `decision: "block"` with a `reason` continues the turn, and the reason arrives as a new prompt.
- A hook runs only once the user trusts it in `/hooks`, and Codex plugins have no `userConfig`. So the user merges the hooks into `~/.codex/hooks.json` from what `node tools/agents.mjs codex` prints.
- An exit code other than 0 or 2 marks the hook failed and doesn't block, as decision 1 needs.
- Its edits arrive as `apply_patch` text in `tool_input.command`, so its adapter parses the patch into `preTool` events, one per file.
- It loads `AGENTS.md` from the git root down, with no globs.
- Its docs call the format behind `transcript_path` "not a stable interface". So its provider returns null on a field it doesn't find, and quotes are refused rather than counted wrongly.

**f. Agents without hooks.**
- `node tools/compile.mjs <project>` (decision 4) compiles rules for the agents that the project's domains list under `domains.<d>.compile` in `vault.config.json`.
- Each format is an adapter's `compile.mjs`, so the core names no format (§8 item 6, Compiled files). Phase 6 ships one, a marked section of the project's `AGENTS.md`. Others would each be one more adapter folder:
  - Cursor `.mdc` files: `alwaysApply` from `always`, `globs` from `applies_to`, and keywords as `description`;
  - Copilot `.instructions.md` files, with `applyTo`.
- It writes only into projects that `vault.config.json` opts in. The user decides whether the project commits them.
- It runs only when the user runs it. Lint warns on a section that is missing, edited by hand or stale.
- Only `file` namespace globs compile, since those formats know only files.
- These agents lose deny-then-retry, `triggers`, once-per-session delivery and proposing, and the copy is stale until compiled again.

**g. A persistent vault server (tested, not adopted).**
- *Idea.* The core runs as an MCP server, and the hooks call it through the `mcp_tool` hook type. That would remove the per-call process start and keep notes in memory.
- *Trial* (phase 0; Claude Code 2.1.296, headless, Windows):
  - **The deny works.** A PreToolUse `mcp_tool` deny stopped Edit and Write, even in `acceptEdits` mode. The reason reached Claude as an error tool result, and the server could allow the retry.
  - **It fails open.** On a tool error (`isError`) or a crashed server, the edit went through. Claude saw nothing, and only the debug log recorded it. `onFailure: "block"` on an `mcp_tool` hook was accepted and had no effect.
  - **It is fast.** A round trip took 1–5 ms, against 118–134 ms for a command hook.
  - A crashed server is started again on the next hook call, in about 70 ms.
- *Decision.*
  - The edit gate and Stop stay command hooks. A gate that fails open breaks decision 1, and so does a hook that fails silently.
  - Prompt delivery stays a command hook too. A silent failure there is missing context that no one is told about (6.6a).
  - **scale:** if `latency.mjs` stays red after the cache, a thin command hook can query a long-lived vault process. It keeps the command hook's loud failure and its process start, and drops the vault read.
- *Revisit* if Claude Code documents fail-closed behavior for `mcp_tool` hooks.

## 7. Declared gaps

These are limits of the agent, not features the vault is missing. The adapter declares each one, and the README names it, rather than working around it.

- **Shell writes, before they happen.** Claude Code gives no event with the file and its new text before a shell command writes.
  - The vault catches them after the write, at the end of the turn (6.3d), and only in git projects.
  - Parsing shell commands for writes would be a workaround.
- **Code-execution tools.** An MCP tool that runs arbitrary code inside an app has no target to map, and a Stop-time check can't see what it changed.
- **Hookless agents** get advice, not enforcement (6.7f).
- **Failures inside a subagent.** Claude Code records them in the subagent's transcript, not the parent's (6.6a). A SubagentStart failure is the exception and reaches the parent's stream.
- **Codex** (6.7e, §8 item 6):
  - **Hooks it hasn't been told to trust.** Codex skips a hook the user hasn't trusted in `/hooks`, and one whose command changed, and the vault can't tell. A project can opt in to the compiled section as advice (6.7f), which then shows twice in a session whose hooks do run.
  - **How loud a failure is.** A hook that exits 1 is marked failed and the call goes on (decision 1). Where the user sees that isn't verified (§11). What the vault itself shows is `.state/errors.log` and the error line at the next session start.
  - **The Stop continuation** reaches the model as a new prompt, not as context. The adapter keeps it out of the user's typed words.
  - **Shell writes.** As for Claude Code, they are caught at Stop, in git projects only. A patch the agent runs through the shell is a shell write.
  - **Tools beyond the three PreToolUse sees.** The hooks docs name `apply_patch`, `Bash` and MCP tools. A phase 5 `tools` rule can name nothing else in Codex, and answers to Codex's question tool are left out of typed text.
  - **Context size.** `additionalContextLimit` counts tokens by Codex's own estimate, and longer context is saved to a file with a preview.

## 8. Phases

The phases build mechanism only. Adding real knowledge and taste is the user's call once the mechanism holds, and no phase here does it. Scale items are built when `latency.mjs` goes red, in whatever phase that happens.

0. **Checks first.**
   - Move `probes.mjs` and `latency.mjs` into `test/` as `node --test` tests marked `todo`. Add the neutral-core test (§3) the same way.
   - The pre-commit hook runs the tests on any change to `tools/`, `test/` or `.githooks/` (`.githooks/pre-commit:13`). Plain failing tests would refuse every fix, and `.live/tools` would never update.
   - A failing `todo` test exits 0. Each `todo` mark comes off as its test goes green.
   - Try out the vault server (6.7g) in the scratchpad.
1. **Format.**
   - Every field in 6.1, plus the derived-text and bundle formats (6.4a, 6.4b), target namespaces (6.3b) and `tools` (6.3c).
   - Free while the wiki is empty.
   - Update AGENTS.md with it (§10).
2. **Delivery that can be trusted.** Built, reviewed at max effort with the findings fixed, and merged into main.
   - loud failure, deadline and linear regex (6.6a–c);
   - the cache and content settling (6.2c, 6.6d), with the one git module and the standard and lint check changed to allow it:
     - the cache here is the one cache, the scoped walk and build on change;
     - derived state waits for refresh (phase 4);
     - the scale items wait until `latency.mjs` is still red with the cache;
   - one refusal per file (6.5), within the output budget (6.6e);
   - the lock, bounded housekeeping and the small fixes (6.6f–h);
   - subagents and edit surfaces (6.3a, 6.3b);
   - the shell-write Stop hook (6.3d);
   - plugin hooks (6.7d).
3. **Neutral fixtures.** Built and reviewed at max effort with the findings fixed. The review also found the frontmatter parser's multi-line values misread, and the fix gives it one continuation rule, YAML's: a value runs on only onto lines indented past its parent. The tests use invented domains and invented names, not a real ecosystem, so no real domain's file types or words shape what the tests pin. `propose.mjs` and the ingest skill already use `example-ui`; the platform words left are in `test/` and AGENTS.md's examples.
   - **Presets.** The five shapes become fixture presets in `test/fixture.mjs`, five and no more. `makeVault(t, { presets: [...] })` adds each named preset's config, project folder and notes. A marker- or path-reached preset gets its own project folder, `v.projects.<key>`, and `glim`'s is `v.project`. The preset writes its `derived/` and `raw/` files directly, and dates `as_of` 30 days before the run, so lint's 180-day warning never fires.
     - **`glim`, code taste.** Reached by its marker, `glim.project`. Files are `src/**/*.zq`, and `.zq` with `.zqx` is the prefix-extension pair the glob tests need. It holds an always rule, a rule on `src/**/*.zq` with a trigger, a keyword rule, a page with `applies_to`, a rule with `tools: [AskUserQuestion]`, and one live pick row in `raw/picks/`. It declares the namespace `glim-tree`, maps the tool `mcp__fixture__set_property` to it in `editTools`, and writes the alias `tools/ext/aliases/fixture.mjs`, which the domain names in `aliases`.
     - **`almanac`, knowledge.** Reached by its marker, `almanac.project`. Its project holds `almanac.lock`, naming `pkg` at 2.4.0, which nothing reads until phase 4's fixture reader does. It holds two knowledge rules on `src/**`, one `requires` `{ ecosystem: fixture, name: pkg }` from 2.0.0 before 3.0.0 and one from 3.0.0, both with `as_of` and the keyword `openLedger`. It also holds a source in `raw/refs/` with `url`, `fetched`, `etag`, `last_modified` and the body's real `sha256`, one with `repo`, `path` and `commit`, and a source page for each.
     - **`archive`, research.** `vaultOnly: true`. It holds `raw/refs/paper.pdf`, a few bytes that start `%PDF-` and aren't UTF-8, with `derived/<its sha256>.md` written by hand: kind `pdf`, extractor `fixture`, an `extractor_version`, `source: raw/refs/paper.pdf`, and anchors `[p. 1]` and `[p. 2]`. It also holds `raw/refs/talk.mp4` with no derived text, and a source page whose footnote cites `raw/refs/paper.pdf#page=2`.
     - **`journal`, personal.** Reached by `paths` in `vault.local.json`, so one preset keeps the path reach in use. It holds an `author: user` page with an `## Agent notes` section.
     - **`commons`, everywhere.** `everywhere: true`, with no markers or paths. It holds a keyword page and a keyword rule.
   - **The default.** `makeVault(t)` with no presets is `glim`'s domain entry and its project folder, holding `glim.project`, with no notes, no namespace and no alias, so the 300-odd tests that write their own notes keep an empty wiki. It is reached by the marker and no path, so every test exercises markers, and `reach.test.mjs` and `rows.test.mjs` cover paths alongside `journal`. A folder reached both ways would be harmless, since `domainsFor` keeps one hit per domain (`vault.mjs:121`). `ruleNote` and `pageNote` default to `glim`, and `editFile`'s default text becomes `set x to 1`.
   - **The checks.** Of the 17 *Check*s in §6, 12 run on what is built, each against the preset of its shape:
     - `glim`: 6.3a, 6.3b, 6.3d, 6.5 (the test adds its 20 rules and 2 pages), 6.6c and 6.6d. 6.3d's test still makes the project a git repo.
     - `glim` and `almanac` together: 6.1a's monorepo, with their markers in `packages/a/` and `packages/b/`, and its unlisted folder; `commons` for its `everywhere` page; and a `local` path that doesn't exist for its lint error.
     - `almanac`: 6.1b. `journal`: 6.1f.
     - All five presets plus five vault-only domains of the test's own: 6.6e, which needs ten.
     - The perf group's generated vault (`test/perf/notes.mjs`): 6.2c and 6.6f. It needs thousands of notes, so it keeps its own generator, whose domains (`ui`, `backend`, `infra`, `data`) and file types name no platform.
   - **The `todo` checks.** The other five need phase 4 or 5 code. Phase 3 seeds what the format already expresses and writes each as a `todo` test that fails for the reason its section names:
     - 6.1c on `almanac`: only the v2 rule is delivered, and `review status` ranks it first. It fails because nothing reads versions, so both are.
     - 6.2a on `almanac`: it runs `node tools/refresh.mjs` and expects the rule labelled unverified. It fails because there is no refresh. Its url source points at `pkg.invalid`, a host that never resolves, so no run can pass it by fetching the internet; phase 4 swaps in the locally served URL source and adds the fixture git repo to this test.
     - 6.2b on `almanac`: the test generates a manifest of 2,000 links and 50 cited pages under `raw/refs/<set>/`, then expects the fastest of three session starts that each build over a newly landed cited page under 1,000 ms, the fastest of three with nothing changed under 500 ms, and `review.mjs sources` to list the set as one source. The second part fails until doc sets are built. The builder confirms it is red for that reason before marking it.
     - 6.3c on `glim`: the first `AskUserQuestion` is denied with the `tools` rule. It fails because the edit hook doesn't match on `tools`.
     - 6.4a on `archive`: a fabricated quote against `paper.pdf` is refused, and a real one passes. It fails because quotes never read `derived/`. `quotes.test.mjs:178`, which asserts that a binary source is not checked, stays until phase 5 inverts it.

     The locally served URL source, the fixture git source, the feed and the fixture version reader come with phase 4, since building them now would fix interfaces phase 4 hasn't designed. The extractor fixtures come with phase 5.
   - **The other tests** keep their own setup but lose `demo` and every platform word: about 56 test blocks in 13 files name a file type, page name or code of one platform, and `demo` appears about 900 times. They take `glim`'s words: `.zq` files, invented page names, and invented code in trigger payloads and quotes. `glob.test.mjs`'s `.lua`/`.luau` cases become `.zq`/`.zqx`, which keeps the prefix pair.
   - **AGENTS.md.** Its examples move to a widely known stack (§10).
   - **Neutral core.** The neutral-core test loses its `todo` mark (`test/neutral-core.test.mjs:20`).
   - **Done** when the phase 3 check in §9 passes: the suite passes with 5 `todo` tests, each red for its reason, and the grep for platform words finds nothing.
4. **Knowledge mechanisms.** Built, reviewed and fixed on `phase-4-integration`. Phase 4 builds refresh, git sources, doc sets and unverified state (6.1d, 6.2a, 6.2b), and the version reader interface with one fixture reader (6.1c). Feed parsing, `sitemap.xml` and every real reader stay build-or-reuse until a domain needs them. Two §6 lines are settled here: `review.mjs` already matches a saved copy by URL and hash (6.1d), and quotes are checked against the saved copy, not `git show` (6.2a).
   - **Fixtures.** `test/fixture.mjs` gains two helpers, and the `almanac` preset gains a reader and source overrides. No phase 4 check needs a feed or a `sitemap.xml`, so there is no fixture for either.
     - `serve(t, routes)`, async, starts a `node:http` server on `127.0.0.1`, port 0, and closes it in `t.after`. `routes` maps a path to `{ body, etag, lastModified, status, location }`. A GET whose `If-None-Match` equals the route's `etag`, or whose `If-Modified-Since` equals its `lastModified`, gets 304 and no body. It returns `{ url(path), set(path, route), hits(path) }`.
     - `gitRepo(t, files)`, sync, runs `git init` in a temp folder, writes `files` (such as `{ 'docs/ledger.md': text }`) and commits them, with the env and `-c` flags `checkout()` uses (`fixture.mjs:99-104`). It removes the folder in `t.after`. It returns `{ dir, commit, change(files) }`: `dir` has forward slashes, and `change` commits and returns the new commit.
     - `makeVault` takes `sources: { url, repo, commit }`. The `almanac` preset writes them into `raw/refs/ledger-guide.md` and `raw/refs/ledger-repo.md` in place of `https://pkg.invalid/ledger`, `https://example.com/pkg.git` and `a1b2c3d4e5f6` (`fixture.mjs:259-288`). Left out, the defaults stay, so no test reaches the network unless it serves one.
     - The `almanac` preset writes `tools/ext/readers/fixture.mjs`, as `glim` writes its alias, and its domain entry gains `readers: ['fixture']`:

       ```js
       import fs from 'node:fs';
       import path from 'node:path';
       export const ecosystem = 'fixture';
       export const lockfiles = ['almanac.lock'];
       export const scheme = 'SEMVER';
       export function read(dir) {
         const out = {};
         for (const line of fs.readFileSync(path.join(dir, 'almanac.lock'), 'utf8').split(/\r?\n/)) {
           const m = line.match(/^(\S+) (\S+)$/);
           if (m) out[m[1]] = m[2];
         }
         return out;
       }
       ```

     - A test that runs refresh against `serve` awaits `v.runAsync('refresh.mjs')`. `v.run` uses `spawnSync`, which blocks the test's own event loop, so the server never answers and the child times out.
   - **`tools/refresh.mjs`.** `node tools/refresh.mjs`, with no arguments. It is a top-level tool, so it may call `fetch` (`CODING_STANDARDS.md:40`). Every git call goes through `lib/git.mjs`.
     - **What it checks.** Each source in `raw/refs/` with a `url`, or a `repo` and `path`. A source's id is `normUrl(url)` (`rules.mjs:737`), `<repo> <path>`, or a doc set's folder. Refresh checks the latest copy in the source's chain (see New copies). A source with neither field can't be checked and isn't listed.
     - **Output.** One line per source, in id order, then a tally:

       ```
       unchanged https://…/ledger (304)
       changed https://…/ledger: raw/refs/ledger-guide.3f9c01ab.md
       baseline https://…/notes: raw/refs/notes.77e0d2c1.md
       failed <repo> docs/ledger.md: git fetch exited 128: fatal: …
       4 sources: 1 unchanged, 1 changed, 1 baseline, 1 failed. 2 notes unverified.
       ```

     - **Exit code.** 0 when every source has a check on record, failed ones included. 1 when refresh can't run: another refresh holds the lock past its wait, a write fails, or a file in `raw/refs/` can't be read. The reason goes to stderr. 2 on any argument. Offline, every source is a failed check, which is what `/lint` reports.
     - **URL sources.** Refresh calls `fetch` with `redirect: 'manual'`, `AbortSignal.timeout(refresh.timeoutSeconds * 1000)`, and `If-None-Match` and `If-Modified-Since` from the latest copy's `etag` and `last_modified`, or from the last 200 that `derived.json` stored. It reads the body as a stream and stops past `refresh.maxBytes`. It decodes the body with `TextDecoder('utf-8', { fatal: true })`, turns each run of `\r` before a `\n` into the `\n` alone, so the text has the line ends `parse()` reads, and hashes it. A 304, or a 200 with the latest copy's `sha256`, is `unchanged`. The new `etag` and `Last-Modified` go to `derived.json`, never to `raw/`. A new hash writes a new copy.
     - **Git sources.** The repo is cloned to `.sources/<name>/`. `<name>` is the repo's last path segment, without a trailing `/` or `.git`, then `-` and the first 8 hex digits of the repo string's sha256, so two repos named alike don't share a folder. `lib/git.mjs` gains these, each run with `execFileSync`, no shell, arguments as an array and a `refresh.timeoutSeconds` timeout:
       - `clone(repo, dir)`: `git clone --quiet --no-checkout -- <repo> <dir>`, when `.sources/<name>/` holds no clone whose `origin` git can read; whatever the folder holds is removed first. With no work tree, no line-ending conversion or long path applies;
       - `fetchOrigin(dir)`: `git fetch --quiet --prune origin`, then `git remote set-head --auto origin`, once a run per clone;
       - `hasCommit(dir, commit)`: `git cat-file -e <commit>^{commit}`, exit 0;
       - `lastChange(dir, commit, path)`: `git log -n 1 --format=%H%x09%cs <commit>..origin/HEAD -- <path>`, the newest only;
       - `sizeAt(dir, commit, path)`: `git cat-file -s <commit>:<path>`; `showAt(dir, commit, path)`: `git show <commit>:<path>`, as bytes. Each call puts `--end-of-options` before its operands, except `remoteHead`, whose one operand is the fixed name `origin/HEAD^{commit}`, and runs with `protocol.ext.allow=never`. `--end-of-options` arrived in git 2.24 for the commands `lib/git.mjs` runs; `rev-parse` took it only in 2.30, which is why `remoteHead` goes without. Git 2.24 is the oldest that works.

       No `lastChange`, or a newest file whose text is the latest copy's, is `unchanged`. Otherwise refresh writes a copy of the newest commit's file.
     - **Failures.** Each one is a `failed` check with its reason in `derived.json`, and refresh writes nothing under `raw/`:
       - no network or no such host: `fetch failed: <err.cause.code>`, such as `ENOTFOUND`;
       - timeout: `no answer in 20 s`;
       - a status other than 2xx and 304: `HTTP 404`;
       - a 3xx: `redirected to <Location>`. Refresh doesn't follow it, so the user saves the source again under its new URL;
       - a body over the cap, fetched or at a commit: `body over 5000000 bytes`;
       - a body that isn't UTF-8: `body isn't UTF-8 text`;
       - git missing: `git not found`. A clone or fetch that exits non-zero gives its exit code and the first line of git's stderr;
       - a commit the repo doesn't hold: `commit <c> isn't in <repo>`;
       - a cited path gone upstream: `<path> is gone at <commit8>`.
       - a clone whose `origin/HEAD` doesn't resolve: `remote has no default branch`;
       - a git source `sourceProblems` faults: `<file>: <problems>`.
     - **New copies.** A changed source gets a new file next to its latest copy, and the old file stays:
       - **Name.** The stem is the previous copy's name without its extension and any `.<8 hex>` suffix. A URL copy is `<stem>.<first 8 of sha256>.md`, a git copy `<stem>.<first 8 of commit>.md`, and a manifest copy `<stem>.<first 8 of sha256>.txt`. A name already taken, when a body comes back to an earlier version, takes `-2`, then `-3`.
       - **Frontmatter.** A URL copy has `url`, `fetched` (today), `etag` and `last_modified` when the server sent them, and `sha256`. A git copy has `repo`, `path`, `commit` (all 40 hex digits) and `fetched`. Both have `replaces`, the previous copy's path from the vault root. The body is the decoded text, as fetched.
       - **`replaces`.** It orders the chain, since `fetched` can't order two copies from one day and mtimes don't survive a clone. `sourceProblems` (`sources.mjs:118-137`) checks that it names a file in `raw/refs/` with the same source id, and that no two files replace one.
       - **Baseline.** A URL source whose latest copy has no `sha256`, such as a page `/ingest` saved as text, can't be compared to a fetch. Refresh saves the first fetched body as a copy with `baseline: true`. That copy marks nothing unverified, and later checks compare against it. Lint checks that `baseline` is `true` when present.
       - Refresh writes every file with `writeText` and `writeJson` (`vault.mjs:223`, `:238`).
   - **Unverified notes (6.1d).**
     - A note keeps citing the copy it cites. That copy stays its evidence, and its quotes are still checked against it, as in phase 1. Only refresh runs `git show`.
     - A note is unverified while a source it cites has a copy, not a baseline, later in the chain than the latest copy the note cites. Citations are the Evidence lines (`evidenceSources`, `rules.mjs:609`) and the footnotes (`citedSources`, `rules.mjs:750`). `since` is the `fetched` day of the earliest such copy.
     - A note clears once it cites the newer copy: propose again with `repeats` and a quote from the new copy, which adds the Evidence line and moves `as_of` up. A note that no longer holds is retired with `superseded_by`.
     - `review.mjs sources` already lists a new copy no source page names, since it has a new hash (`review.mjs:124-162`, `sources.mjs:153-165`). So `/ingest` takes it in.
     - `newerSources` (`review.mjs:106-119`) also takes the source pages, in any domain and on any topic, whose `source` is a later copy in a chain the rule cites.
   - **`.state/derived.json`.**

     ```json
     { "version": 1,
       "sources": { "<id>": { "chain": ["raw/refs/ledger-guide.md", "raw/refs/ledger-guide.3f9c01ab.md"],
         "checked": "2026-11-01", "result": "changed", "why": null, "etag": "\"ledger-2\"", "lastModified": "…" } },
       "unverified": { "almanac/ledger-v2": { "contentHash": "…", "since": "2026-11-01", "sources": ["<id>"] } },
       "domains": { "almanac": ["<id>"] } }
     ```

     - `checked` is the day of the last check that didn't fail. A failed check sets `result: "failed"` and `why`, and keeps `checked`.
     - Build writes `chain`, `unverified` and `domains` from `raw/refs/` and the notes. `domains` holds, per domain, the ids its delivered notes cite. Build fills `checked` from the latest copy's `fetched` for a source never checked, and keeps what refresh wrote. Refresh writes the check fields, then runs build. Both write under `build.lock` (`withLock`, `vault.mjs:470`).
     - The chain lives in `raw/`, so a fresh clone's first build labels its notes before any refresh.
     - A hook reads the file once, through `readDerived` (`rules.mjs`), and only when a note asks. A missing file means nothing is unverified. A corrupt one reads as missing and is logged once to `.state/errors.log` by name, and the next session start or build rewrites it, losing only the checks refresh recorded.
     - An `unverified` entry applies only while the note's content hash matches the one it holds, so a note edited to cite the new copy loses its label at once, before the next build, and a save that leaves the text as it was keeps it. Delivery and `review.mjs status` test it the same way (`unverifiedNow`).
   - **Version readers (6.1c).**
     - **Interface.** `tools/ext/readers/<name>.mjs` exports:
       - `ecosystem`, the name a `requires` entry's `package.ecosystem` gives;
       - `lockfiles`, the file names it reads;
       - `scheme`, `'SEMVER'` or `'ECOSYSTEM'`;
       - `read(dir)`, which returns `{ <package>: <version> }` for the folder holding the lockfile;
       - with `ECOSYSTEM`, `compare(a, b)`, which returns a negative number, 0 or a positive number.

       It is loaded with `extension('readers', name, ['read'])` (`ext.mjs:15-20`). Lint checks the rest as it checks aliases (`lint.mjs:223-232`): an unknown reader, a missing export, a `scheme` that is neither, `ECOSYSTEM` without `compare`, and two readers in one domain with one `ecosystem`. Lint warns on a `requires` ecosystem no reader of the note's domain answers to.
     - **Config.** `domains.<d>.readers` lists reader names; global's read at each project root the session reaches.
     - **Lockfile.** For each reader, the nearest folder at or above the project root that holds one of its `lockfiles`. The search stops after a folder holding `.git`, or at the filesystem root. So one lockfile at a monorepo root serves its packages.
     - **Cache.** `.state/versions.json` maps `<root>|<reader>` to `{ lockfile, mtimeMs, size, versions }`, and `reader <name>` to the error a reader that won't load last gave. A hook re-reads the lockfile when its stat differs, or when its mtime is within `RACY_MS` of the cached read (`cache.mjs:14`). It writes through `writeJson`.
     - **Comparison.** `lib/versions.mjs` holds `compareSemver(a, b)`, SemVer 2.0.0 precedence, prereleases included and build metadata ignored, built on the `SEMVER` pattern `rules.mjs:198-224` already validates with. It also holds OSV range evaluation: events sorted by version, `'0'` first: `introduced` opens, `fixed` closes before its version and `last_affected` after it; `limit` is a cap apart from them, so a version must come before one of the limits. No version comparison exists today.
     - **Fit.** A note with `requires` is a match, a mismatch or unknown for a project:
       - an entry matches when the lockfile's version of its package is in one of its ranges, and mismatches when it isn't, or when the lockfile doesn't list the package;
       - an entry is unknown when the domain has no reader for its ecosystem, no lockfile is found, or the reader throws or won't load. A throw is logged once per lockfile stat, and a reader that won't load once until its error changes, to `.state/errors.log`;
       - a note with several entries matches when any entry matches, mismatches when all mismatch, and is otherwise unknown.
     - **Delivery.** `deliverable(items, { versions, derived })` in `rules.mjs` runs after each hook's match step, and in `pick.mjs show`, on rules and pages alike:
       - it drops mismatches and sorts matches before unknowns within a rank;
       - it adds the labels `version unknown` and `source changed on <since>`, or `source changed` when no newer copy has a valid fetched day. `ruleLine` and `rulePointer` (`rules.mjs:402`, `:405`) put each after the clipped text with ` · ` before it: `… As of 2026-10-02. · version unknown · source changed on 2026-11-01`. The separator keeps a space before each label, which 6.2a's pattern needs;
       - a labelled item's marker hash is `shortHash(text + '\0' + labels)`, and an unlabelled one keeps `hash` (`rules.mjs:334`). So existing markers stand, and a rule that turns unverified is shown again (marker ids, `sessions.mjs:127`, `:164`);
       - `liveRules`, `renderActive`, `active.md` and `index.md` are unchanged, since they aren't per project.
     - **Ranking.** `rankPair(a, b, { fit })` (`rules.mjs:629`) takes a first knowledge test before `as_of` (`rules.mjs:624`): a match over unknown over a mismatch, with a reason that names the loser's fit: `version match (pkg 2.4.0) over mismatch`, or `over version unknown`. Without `fit`, every note ties on it and `as_of` decides, as today. `review.mjs status` (`globPairs`, `review.mjs:88-98`) and `propose.mjs` pass the fit for `sessionReach(cwdOf({}))` (`vault.mjs:181`, `:402`), the project they run in.
   - **Doc sets (6.2b).**
     - A folder under `raw/refs/` that holds a file named in `docSets.manifests` (default `['llms.txt']`) and no `source.md` is one source, a doc set, and its id is the folder. `bundleOf` and `sourceItem` (`rules.mjs:707-725`) return the folder for any file in it, as for a bundle. `refSources` (`sources.mjs:140-148`) lists the folder once, and `sourceVersion` (`sources.mjs:153`) reads the latest manifest copy's `url` and `sha256`. So `review.mjs sources` lists `raw/refs/ledger-docs` once, which is what keeps 6.2b red today.
     - A manifest is saved with frontmatter like any page: `url`, `fetched`, `etag`, `last_modified`, `sha256`. One without, as in 6.2b's test, is a set refresh can't check.
     - A manifest that changes gets a copy, so the set stays append-only. A `source.md` listing its pages would need rewriting.
     - Each cited page in the set has its own `url` and chain, so refresh checks it as a URL source. The set's line reports the manifest and its links: `changed raw/refs/ledger-docs: llms.1c2d3e4f.txt, 12 links added, 3 removed`, plus the cited pages no longer listed.
     - Uncited pages are never saved (6.2b, live reads). The 6.2b test is unchanged.
   - **The XML seam.** `tools/ext/feeds/<name>.mjs` exports `items(text)`, which returns `[{ url, title, updated }]`, and `locs(text)`, which returns a sitemap's `<loc>` URLs. Both throw on a `DOCTYPE`. A domain's `feeds: [{ url, parser }]`, and a `sitemap.xml` in `docSets.manifests` with its parser, are the only callers, both through refresh. Phase 4 ships neither: lint warns on a domain's `feeds` that they do nothing yet. The parser is a small hand-built extractor written when a domain adds a feed, through build-or-reuse.
   - **Settings.**
     - `DEFAULTS` (`vault.mjs:20-28`) gains `knowledge.checkAfterDays: 14`, to match `lint.remindAfterDays`, beside `staleAfterDays: 180`. It also gains `refresh: { timeoutSeconds: 20, maxBytes: 5000000 }` and `docSets: { manifests: ['llms.txt'] }`. `domains.<d>.knowledge` overrides either day count for its domain.
     - Lint's age warning (`lint.mjs:97-100`) counts from the later of `as_of` and the last day every source the note cites was `checked`. A source re-checked unchanged keeps its notes fresh. A check that found the source changed freshens a note only once the note cites the latest copy.
     - **Start line.** A new or resumed session hears one line, after the lint reminder in rank order and skipped on compaction and `/clear` like it: "Taste vault: 3 sources the almanac notes cite haven't been checked in 14 days. Remind the user to run /lint in `<vault>`, which refreshes them." It counts the ids in `domains` for the session's domains whose `checked` is older than the domain's `checkAfterDays`. A failed check doesn't move `checked`, so a source that only fails stays counted. Several domains are named together.
     - **`/lint`.** `.claude/skills/lint/SKILL.md` gains a first step, `node tools/refresh.mjs`, before `review.mjs status`. Offline, every source is a failed check: the step reports how many and `/lint` goes on. Refresh never runs on its own, and no hook runs it.
     - **`review.mjs status`** gains two sections from `derived.json`: "Notes a changed source has left unverified", with each note's key, `since`, source and newer copy, and "Source checks that failed", with each id, day and reason.
   - **Rules that change.**
     - `CODING_STANDARDS.md:14` and `:40`, the message at `lint.mjs:637` and the comment at `git.mjs:16` say that only `lib/git.mjs` runs another program, git, and that hooks call only `changedFiles` from it. The standard check gains that last rule. The `fetch` rule stands: refresh is a top-level tool.
     - Lint's standard check treats `tools/ext/` as it treats `lib/` (`lint.mjs:627`), since readers run inside hooks and must stay off the network.
     - `.gitignore` gains `.sources/`. `VAULT_OWN` (`vault.mjs:74`) and `vaultGuard` (`edit.mjs:12`) gain it too.
   - **Tests.**
     - `later-phases.test.mjs`: 6.1c, 6.2a and 6.2b lose `todo`, and 6.3c and 6.4a keep it. 6.1c and 6.2b are otherwise unchanged.
     - 6.2a becomes two async tests. The URL test serves the preset's guide body and `etag` and passes its URL in `sources`. A first refresh prints `unchanged`, writes nothing under `raw/` and labels nothing. Then the test changes the body and `etag`, and refreshes again. The ledger edit's refusal matches the existing pattern, and `review.mjs status` lists `almanac/ledger-v2` and `almanac/ledger-v3` as unverified. The git test makes a `gitRepo` holding the preset's repo body, passes its `dir` and `commit` in `sources`, and adds a knowledge rule whose Evidence cites `raw/refs/ledger-repo.md`. It changes `docs/ledger.md` upstream, refreshes, and expects that rule labelled `source changed on`.
     - `test/refresh.test.mjs`:
       - each failure mode records a failed check with its reason and leaves `raw/refs/`'s files and bytes unchanged: a closed port, a route that never answers with `timeoutSeconds: 1`, 404, 301, a body over a small `maxBytes`, a body that isn't UTF-8, a commit the repo lacks, a path removed upstream, and a `PATH` without git;
       - the baseline copy;
       - two same-day copies ordered by `replaces`;
       - a body that comes back to an earlier version;
       - a changed manifest;
       - `newerSources` across domains;
       - lint on a bad `replaces`.
     - `test/versions.test.mjs`:
       - `compareSemver`, including prereleases and build metadata;
       - OSV events with `introduced: '0'`, `last_affected` and `limit`;
       - with no lockfile, both rules delivered as `version unknown` (6.1c's second check);
       - a lockfile changed to 3.1.0 delivers v3;
       - a lockfile at a monorepo root;
       - a reader that throws gives unknown and logs one error;
       - lint on a bad reader;
       - a label change shows a rule again.
     - The `almanac` tests that exist hold: `format.test.mjs:80-87` gets the v2 rule, which matches 2.4.0, and `reach.test.mjs:48-68`'s package with no lockfile gets it labelled `version unknown`. The preset's sources were fetched 30 days before the run, past `checkAfterDays`, so `almanac` sessions hear the start line. A test that pins a whole start output adds it.
   - **Windows.** Verified on this machine (§11): `git show` needs forward slashes in `<commit>:<path>`, so refresh joins paths with `/`. A clone from a `C:/…` path works. `git show` returns the committed bytes, CRLF kept, and refresh turns each run of `\r` before a `\n` into the `\n` alone, as it does for a fetched body. Removing a test vault that holds a clone works.
   - **Where the build differs.** Each choice the design left open, or made differently:
     - A note with no `requires` ranks with a match in `rankPair`, ahead of `version unknown`.
     - On a page's line, the labels go after its path, not after the clipped summary.
     - Refresh asks `remoteHead` before fetching a git source, and runs git with `GIT_TERMINAL_PROMPT=0`, so a remote that wants credentials fails the check instead of waiting.
     - The start line counts global's sources with the session's domains, and names the smallest `checkAfterDays` among the domains it counts.
     - A bundle with a `source.md` is not refreshed, since nothing fetches one yet.
   - **Done** when the phase 4 check in §9 passes: the suite passes with 2 `todo` tests (6.3c, 6.4a), each red for its reason, lint reports 0 errors, and the grep finds nothing. The perf group still passes.
5. **Media and tool triggers.** Built, reviewed and fixed on `phase-5-delivery`, with phase 4's fixes merged in. Phase 5 builds the extractor interface with one fixture extractor, quotes checked against derived text, the unverifiable-evidence warnings, a bundle manifest tool, the privacy scan and tool triggers (6.4a–c, 6.4e, 6.3c). 6.4d needs no change. Every real extractor (PDF text, transcription, OCR) is build-or-reuse: the user chooses before one is written, and phase 5 ships none. Phase 4's interfaces are cited by their bullets in item 4. Four §6 lines are settled here: an extractor returns parts and the core writes the anchors (6.4a), the refusal names the tool to run rather than "add derived text" (6.4a), lint tallies URL and gone-session quotes rather than warning on each (6.4c), and lint also refuses a `tools` name that edits a file (6.3c).
   - **What phases 1 to 3 built.**
     - 6.4a: the `derived/<sha256>.md` format and its lint (`lint.mjs:354-378`): name, frontmatter, the binary's hash, and bad anchors. Footnote locators and their anchor check (`lint.mjs:277-306`, `sources.mjs:69`, `:87-103`). `KINDS` (`sources.mjs:7`). The guard on `derived/` (`edit.mjs:12-27`). Missing: an extractor, a tool that writes derived text, quotes against it, and sheets.
     - 6.4b: the bundle format, its lint (`lint.mjs:325-351`), quotes against files in a bundle, and `bundleOf` and `sourceItem` (`rules.mjs:707-725`). Missing: only a tool that writes `source.md`.
     - 6.4c: nothing. `checkTyped` (`lint.mjs:381-384`) and `lintEvidence` (`lint.mjs:412-414`) pass silently, and `pick.mjs` checks no quote.
     - 6.4e: nothing.
     - 6.3c: the `tools` field, its no-spaces check (`rules.mjs:190`) and `hasChannel` (`rules.mjs:195-196`). The plugin's PreToolUse matcher already sends `AskUserQuestion` and `mcp__.*` to the edit hook (`hooks/hooks.json:11`, `EDIT_HOOK_MATCHER`, `vault.mjs:406`), pinned by `plugin.test.mjs:30-33`. The vault registers no hooks in `.claude/settings.json` (README.md:20), so registration doesn't change. Missing: matching on `tools` in the hook, and `tools` in `liveRules` (`rules.mjs:328-340`).
   - **Fixtures.**
     - The `archive` preset's `raw/refs/paper.pdf` holds the text the fixture extractor reads. It still starts `%PDF-` and still isn't UTF-8, so `sourceTexts` (`quotes.mjs:91-98`) still returns null for it:

       ```js
       const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('The glimmer index counts each lit cell.\fA cell lit twice still counts once.\n'), Buffer.from([0xff, 0xfe])]);
       ```

     - The preset writes `tools/ext/extractors/fixture.mjs`, as `glim` writes its alias, and its config gains `extractors: ['fixture']`. The derived text stays written by hand, under the new hash, and is byte for byte what the extractor writes (verified in a scratch script, §11):

       ```js
       import fs from 'node:fs';
       export const kinds = ['pdf'];
       export const extensions = ['.pdf'];
       export const version = '1.0';
       export function extract(file) {
         const bytes = fs.readFileSync(file);
         if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error("doesn't start %PDF-");
         const text = Buffer.from(bytes.subarray(bytes.indexOf(0x0a) + 1).filter(b => b < 0x80)).toString('latin1');
         return { kind: 'pdf', parts: text.split('\f').map((t, i) => ({ page: i + 1, text: t.trim() })) };
       }
       ```

     - `raw/refs/talk.mp4` keeps no derived text, and no extractor reads `.mp4`, so it stays the binary with none.
     - `glim`'s `ask-rule` already has `tools: [AskUserQuestion]` (`fixture.mjs:236`). The everywhere test writes its own `tools` rule into `commons`, so the preset, which 6.1a, 6.6e and `reach.test.mjs:90-103` use, doesn't change.
   - **Extractors (6.4a).**
     - **Interface.** `tools/ext/extractors/<name>.mjs` exports:
       - `kinds`, the `KINDS` it can return;
       - `extensions`, the lowercase file extensions it reads, each with its dot, such as `.pdf`;
       - `version`, a non-empty string, written to `extractor_version`;
       - `extract(file)`, sync or async, given the absolute path. It returns `{ kind, parts }`: `kind` is one of its `kinds`, and `parts` a non-empty list of `{ page, text }` for a paged file, `{ t, text }` for audio or video with `t` in whole seconds, or `{ text }` for one with neither. Pages and times rise from part to part. It throws on a file it can't read.

       It is loaded with `extension('extractors', name, ['extract'])` (`ext.mjs:15-20`), as phase 4 loads readers (item 4, Version readers). `extension()` loads through `createRequire`, so an extractor must not use top-level `await`: `require` of such a module throws `ERR_REQUIRE_ASYNC_MODULE` (§11). An async `extract` is fine.
     - **Rendering.** The core writes the anchors, so no extractor can get them wrong. Each part becomes its anchor on a line of its own, `[p. N]` or `[t=hh:mm:ss]`, then its text and a newline. A part with neither has no anchor. The frontmatter is `kind`, `extractor` (the module's name), `extractor_version` (quoted, so `1.0` stays a string) and `source`, the binary's path under `raw/`.
     - **Config.** A top-level `extractors` list in `vault.config.json`, in order of preference, since sources live in `raw/` for the whole vault, not per domain. A file goes to the first extractor whose `extensions` holds its lowercase extension. `DEFAULTS` (`vault.mjs:20-28`) gains `extractors: []`.
     - **Lint.** As for aliases (`lint.mjs:223-232`) and readers (item 4): an extractor listed with no module, a module that won't load (its error message), a missing export, `kinds` empty or outside `KINDS`, an extension without its dot or with uppercase, and an empty `version`. Each is an error. Lint also warns on derived text whose `extractor` is a listed extractor with another `version` now: `made by fixture 0.9, and fixture is 1.0 now. Run node tools/extract.mjs raw/refs/paper.pdf`. Derived text from an extractor not listed, such as one written by hand, gets no such warning.
     - **Rules that change.** Phase 4 makes lint treat `tools/ext/` as it treats `lib/` (item 4, Rules that change), so an extractor may not run another program or reach the network. A real extractor that wraps an external program needs an exception for `tools/ext/extractors/`, which no hook loads. That exception is decided with the build-or-reuse choice, not in phase 5.
   - **`tools/extract.mjs` (6.4a).** `node tools/extract.mjs <file>... [--force]`, each file under `raw/`. It is a top-level tool. `/ingest` runs it, never a hook.
     - For each file, in the order given, one line. Each line prints as its file finishes, and an error from any step is that file's failed line.

       ```
       wrote raw/refs/paper.pdf: derived/3f9c…e1.md (fixture 1.0, 2 pages)
       unchanged raw/refs/paper.pdf: derived/3f9c…e1.md
       replaced raw/refs/paper.pdf: derived/3f9c…e1.md (fixture 1.0 over fixture 0.9)
       skipped raw/refs/notes.md: it is text, so quotes are checked against it as it is
       failed raw/refs/talk.mp4: no extractor in extractors reads .mp4
       ```

     - `unchanged` when the derived text's `extractor` and `extractor_version` are the chosen extractor's. `replaced` when either differs, which is how a better extraction lands. `--force` extracts again and rewrites even an `unchanged` one. A file `sourceTexts` reads as text is `skipped`.
     - **Failures.** Each is a `failed` line, and nothing is written for that file:
       - no extractor reads the extension: `no extractor in extractors reads .mp4`;
       - the extractor throws: `fixture threw: doesn't start %PDF-`;
       - a bad result: `fixture returned page 0`, or a `kind` outside its `kinds`, no parts, a part with both `page` and `t`, or pages or times that don't rise;
       - the text holds a key- or token-shaped value (Privacy): `its text holds 1 key-shaped value; run node tools/scan.mjs raw/refs/paper.pdf`.
     - **Exit code.** 0 when no line is `failed`, 1 when one is, 2 on no file, an unknown flag, or a path outside `raw/` or not a file, or a run that can't finish. A failure writing `derived/` is such a run: it ends the run after the lines already printed, and no `failed` line is printed for it, since a `failed` line is for what the extractor or its result did.
     - It writes with `writeText` (`vault.mjs:223`). `derived/` is outside `raw/`, so a replaced text breaks no append-only rule. Lint re-checks every quote on every run, so a replaced text that drops a quoted sentence is a warning at once.
   - **Quotes against derived text (6.4a).**
     - **`quoteTexts(rel)`** in `quotes.mjs` takes the place of `sourceTexts` in `propose.mjs:141-142` and lint's `textsOf` (`lint.mjs:53-55`). It returns `{ texts }` or `{ why }`:
       - a file `sourceTexts` reads gives its readings, as today;
       - an image gives `{ why: 'image' }`. An image is a file whose derived text has `kind: image`, or, with none, one with a png, jpg, jpeg, webp, gif, bmp, tif or tiff extension (quoteTexts' own list, wider than the sheets pick.mjs takes);
       - another binary with derived text gives that text's body with its anchor lines dropped, so a quote may run across a page break;
       - one with none gives `{ why: 'no derived text' }`.

       A file is text when its first 8 KiB hold no NUL byte and the whole file decodes as UTF-8; anything else is a binary, a file too large to read whole included. A file another program holds open is an error, not a binary. `quoteTexts`, `lineCount`, `extract.mjs` and `scan.mjs` share that test (`fileText` in `sources.mjs`).
     - **Anchors.** `anchorsIn` (`sources.mjs:87-99`) reads an anchor only on a line of its own, as the rendering writes it. A line that starts like one and isn't one is still a bad anchor. So a `[p. 3]` inside a sentence the source quotes is text, not an anchor. `extract.mjs` fails a part with such a line, naming it, after turning `\r\n` and `\r` into `\n`, and takes only safe integers for page and t.
     - **Locators.** A quote is checked against the whole derived text, and footnote locators keep their phase 1 check. Evidence lines take no locator, so `evidenceSources` (`rules.mjs:609`) and phase 4's chains don't change (open question).
     - **Refusals in `propose.mjs`.** `checkQuote` refuses in place of passing a binary:
       - `{ why: 'image' }`: "raw/refs/shot.png is an image, and what it shows is your reading. Give it as basis reading instead.";
       - no derived text: "raw/refs/spec.pdf has no text propose.mjs can read: it isn't UTF-8 and has no derived text. Run node tools/extract.mjs raw/refs/spec.pdf, or save it as UTF-8, then propose again.";
       - a quote the text doesn't hold: "the quote isn't in raw/refs/paper.pdf. Quote the file's own words." The 6.4a test matches `quote isn't in`.

       A file that isn't UTF-8 text, such as a page saved in another encoding, gets the second refusal too, which is why it names both fixes.
     - **Sheets.** `sheetOf` (`pick.mjs:113-124`) also takes a file whose SHA-256 names derived text, such as a PDF saved in `raw/refs/` and extracted. The refusal becomes "sheet must be a .png, .jpg, .jpeg or .webp image, or a file with derived text. Save the file in raw/refs/ and run node tools/extract.mjs on it."
   - **Unverifiable evidence (6.4c).**
     - **A pruned transcript.** `evidenceQuotes` (`rules.mjs:642-651`) also returns the row id, `a-…`, when `ids` holds one with no `;`. When `typedIn(session)` is null, `checkTyped` (`lint.mjs:381-384`) looks the id up in `proposalRows()` (`vault.mjs:335`), whose `text` `propose.mjs` checked when it wrote the row (`propose.mjs:391`). It warns when the row doesn't hold the quote: `"<quote>" isn't in what row a-00000002 recorded`. A line with no id, or an id no row has, can't be checked.
     - **A binary with no derived text.** One warning per quote: `"<quote>" can't be checked: raw/refs/talk.mp4 has no derived text. Run node tools/extract.mjs raw/refs/talk.mp4, or save it as UTF-8`.
     - **An image.** One warning per line: `an Evidence line quotes raw/refs/shot.png, an image, as a source. What an image shows is a reading: give it basis reading`.
     - **A URL, or a session whose transcript is gone with no row to fall back on.** These are common and the user can't fix them, so lint gives one tally warning, `warn wiki: 14 quotes can't be checked: 11 cite a URL, 3 a session whose transcript is gone. node tools/review.mjs status lists them.`, and `review.mjs status` gains a section, "Quotes lint can't check", listing each note, what it cites and the quote clipped to 80 characters (open question). `## You said` lines on a gone session count in the tally too.
     - **`pick.mjs`.** It checks `notes` (on a pick and a confirmation) and a comment's `text` with `saidIn` (`quotes.mjs:42`) against `typedMessages(session.transcript)`, as `checkQuote` does (`propose.mjs:146-152`):
       - not typed: "notes aren't in anything the user typed in this session. Put their exact words in notes, with … where you leave some out, or your own in reason." For a comment: "the comment isn't in anything the user typed in this session. Record their exact words, with … where you leave some out.";
       - no transcript: "the taste vault has no transcript for this session, so it can't check these are the user's words." A pick may still be recorded without `notes`.
     - No delivery label marks a rule whose quote can't be checked (open question): a hook can't afford to read transcripts, and lint and `review.mjs status` are where the user looks.
   - **Bundles (6.4b).** `node tools/bundle.mjs raw/refs/<folder> [--url <u> | --repo <r>] [--commit <c>]` writes the folder's `source.md` (open question).
     - With `--url` or `--repo`, `--commit` is required, and `source.md` holds those fields. Otherwise it holds the `sha256` list: one `'<hash>  <path>'` line per file, as `manifestLine` reads them (`sources.mjs:110`), paths from the folder with `/`, sorted.
     - It prints `wrote raw/refs/<folder>/source.md: 42 files` and exits 0. It refuses, with exit 1 and nothing written, a folder that already holds `source.md` (`raw/` is append-only), one that holds a `source.md` or a doc-set manifest anywhere inside, one inside another bundle, and an empty one. Exit 2 on a path outside `raw/refs/`, a missing folder or a bad flag.
     - It writes with `writeText`. Lint checks the result as it checks any bundle (`lint.mjs:325-351`). Fetching a repo into a folder isn't built: a public repo is a git source (item 4).
   - **Privacy (6.4e).**
     - **Patterns.** `tools/lib/secrets.mjs` exports `secretsIn(text)`, which returns `[{ line, kind, value, masked, allow }]`, one per value per line. The patterns name no vendor's key prefix:

       ```js
       const PEM = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
       const ASSIGN = /(?<![\p{L}\p{N}])[\p{L}\p{N}_.-]{0,40}?(?:key|token|secret|passw(?:or)?d|credential)s?["']?[ \t]*[:=][ \t]*["']?([^\s"'`<>,;]{8,})/giu;
       const PLACEHOLDER = /^(?:\$\{|\{\{|%|<)|^(?:x+|\*+|\.+|your[_-].*|changeme|example.*|placeholder.*|redacted)$/i;
       const RUN = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9+/_=-])/g;
       ```

       - `private key`: a PEM private key block. Its value runs to the matching `-----END` line, or to the end of the text. Another block is passed only when an `-----END` line with its label closes it over base64 and armor-header lines; a block may be indented or follow `- ` or `"`.
       - `assignment`: a name ending in key, token, secret, password or credential, assigned a value of 8 or more characters that holds a letter and a digit and isn't a `PLACEHOLDER`. So `token = getToken()`, `apiKey: process.env.API_KEY`, `API_KEY=<your key>`, `primary_key = 42` and `keyboard=qwerty123` pass.
       - `token`: a `RUN` of 32 or more that holds a digit, an uppercase and a lowercase letter and has a Shannon entropy of at least 4.2 bits a character. A run after `base64,` (a data URI) or starting `sha256-`, `sha384-` or `sha512-` (an integrity hash) is skipped. Hex hashes, commit ids and UUIDs have no uppercase, so they pass. A run whose pieces, split on `/ _ - .`, case changes and digits, are all numbers, words of up to 20 letters with a vowel, or acronyms of up to 6 capitals, with pieces of 1 or 2 letters at most a quarter, is a name or path and passes. A value both `assignment` and `token` match is listed once.

       The patterns are bounded, so they use the default engine. A 1.86 MB line scans in about 25 ms (§11).
     - **Output.** `masked` is the value's first 2 and last 2 characters around `…`, and a private key shows as its kind alone. `allow` is the first 16 hex digits of the value's SHA-256, which identifies it without repeating it.
     - **Override.** `privacy.allow` in `vault.config.json`, a list of `allow` ids, which the user sets. `DEFAULTS` gains `privacy: { allow: [] }`. A listed value is never reported. Lint checks each id is 16 lowercase hex digits.
     - **`tools/scan.mjs`.** `node tools/scan.mjs <file, bundle or doc set folder>...`; a folder that `review.mjs sources` lists is scanned through every file on disk under it, dotfiles included and `.git/` left out, whatever the bundle lists. A file that can't be read, such as one held open, exits 2 with its name and the reason. A file that isn't UTF-8 is scanned through its derived text, under the binary's name, and skipped when it has none. Output, then exit 1 when anything was found, 0 when nothing was, 2 on no file given, a bad flag, a file that can't be read, or a run that can't finish:

       ```
       raw/refs/notes.md:12 assignment api_key=ab…9f · allow 3f9c01ab77e0d2c1
       raw/refs/notes.md:40 private key · allow 77e0d2c1a4b5c6d7
       2 key- or token-shaped values in 1 file. Remove them, or add an allow id to privacy.allow in vault.config.json if it isn't a secret.
       ```

     - **Where it runs.**
       - `/ingest` step 2 runs `node tools/scan.mjs <file>` after saving or copying a source, and on exit 1 shows the user the lines and stops until they remove the values or allow them, and on any other exit but 0 stops too. This is 6.4e's refusal.
       - `extract.mjs` scans the text before writing it (above).
       - The edit hook and the pre-commit hook don't scan, so a source saved outside `/ingest` isn't checked. §6.4e keeps privacy small: a deny in the edit hook on writes under `raw/`, and a pre-commit scan of added sources, would catch those too, and are left for the user to choose (open question).
     - Rows in `raw/inbox/` and `raw/picks/` are the user's words, written by the tools, and aren't scanned.
     - Findings on derived text's frontmatter, which the core writes, aren't reported.
   - **Tool triggers (6.3c).**
     - **Hook and matcher.** The edit hook on PreToolUse, through the matcher it already has (`hooks.json:11`). No registration changes.
     - **The match.** `liveRules` gains `tools: n.tools`. For a call whose `tool_name` isn't in `FILE_TOOLS` (`vault.mjs:404`), the hook takes the rules whose `tools` holds the name exactly, in the domains a prompt's keywords reach: `readableDomains` (`vault.mjs:196`) of the session's domains (`sessionHits`), so global and every everywhere domain's rules count, and in the vault folder every domain's. Each becomes `{ key, note, rel: <tool>, place: 'tool:<tool>', spec: [0, 0] }`, no more specific than `**`, since `bySpecificity` (`glob.mjs:214`) reads both numbers, and goes through `dueRules` (`scope.mjs:31-43`) unchanged.
     - **Triggers.** A rule with `tools` and `triggers` fires only when a trigger matches `plainText(asText(tool_input))` (`edit.mjs:151`), the call's input as JSON text. A rule with both `tools` and `applies_to` is reached by either.
     - **The marker.** The gate id is `agentKey(input, '<key>|<hash>|tool:<tool>')`, which `dueRules` already builds from `place`. So a rule is refused once per session per agent per tool, again after a reword, and again when phase 4 changes its label (item 4, Delivery: the labelled hash). Hits go through phase 4's `deliverable()` like the edit hook's other hits.
     - **A mapped MCP tool.** A call `editTools` maps gets its name's rules from `nameScope` and its tool's rules here. They join in one list, keeping the first per key, so a rule both reach refuses once.
     - **Unmapped and unknown tools.** A call with no rule on its name returns null after the match step, as an edit outside every glob does. `tools` holds no pages, since `livePages` (`rules.mjs:357-363`) has no `tools`.
     - **Copy.** `refusal()` (`edit.mjs:220-241`) gains the noun. For a tool call the head is "Taste rules apply to AskUserQuestion:" and the foot "Revise this call to follow them, then retry. The retry is allowed." (open question; `CODING_STANDARDS.md:15`). A tool call writes no turn marker for the Stop hook.
     - **Lint.** Lint's `toolErrors` (`lint.mjs`), not `noteErrors`, adds these errors, so a rule's delivery never depends on `agents`: a name the matcher never sends, `tools names Bash, which the edit hook's matcher, ^(?:Edit|Write|…)$, never sends to the hook, so it would never bring the rule up`, and a name in `FILE_TOOLS`, `tools names Edit, which edits a file; give the rule applies_to instead`. When `agents` lists none it says so instead: `tools names TodoWrite, but agents in vault.config.json lists no agent, so lint can't tell whether an edit hook is sent it`, and the same for an `editTools` key. A name the matcher sends but no tool has, such as a misspelt MCP tool, can't be caught: `/lint`'s rules no session was shown lists it. `hasChannel`'s comment loses "nothing delivers on it yet".
     - **Latency.** A tool call with no rule on it costs what an edit outside every glob costs: the notes load from the cache (`cache.mjs`) and the scan is one pass over `liveRules`. The perf group gains `an AskUserQuestion call takes under 300 ms at 3,000 notes`, fastest of 3, with one `tools` rule among the generated notes. That is well inside the 10 s deadline (6.6b). An index of rules by tool is a scale item, left until the perf test says so.
   - **Rules that change.**
     - `.claude/skills/ingest/SKILL.md` step 2: after saving a binary source, run `node tools/extract.mjs <file>`, and stop and tell the user when it fails; then run `node tools/scan.mjs <file>` on every source and handle exit 1 as Privacy says, and on any other exit but 0 stop too. A file no extractor reads isn't a stop, whatever its type: scan skips it, the user hears its text wasn't scanned, and an image backs basis `reading` only while any other binary backs nothing; `/ingest batch` takes it in. A `failed` line for an extractor that threw, a bad result or a found secret still stops. Step 5 quotes a binary source from its derived text. `/ingest batch` does the same, and leaves a source that fails either for the user.
     - `.claude/skills/lint/SKILL.md`: the lint skill skips the quotes lint tallies as uncheckable (a URL quote, and a quote of a gone session whose line's id has no inbox row), and relays `review.mjs status`'s section "Quotes lint can't check" as a count.
     - AGENTS.md changes as §10 says.
   - **Tests.** Each new test is written before its code and seen red for its reason.
     - `later-phases.test.mjs`: 6.3c and 6.4a lose `todo` and are otherwise unchanged.
     - `quotes.test.mjs:178` is inverted into "a binary source is checked against its derived text": `shot.png` is refused with the image refusal, `spec.pdf` with no derived text is refused naming `node tools/extract.mjs raw/refs/spec.pdf`, and with derived text written a fabricated quote is refused and a real one passes, as does one across a page break. A file that isn't UTF-8 gets the no-text refusal.
     - `test/extract.test.mjs`:
       - with `archive`'s derived text removed, `extract.mjs raw/refs/paper.pdf` writes the preset's text byte for byte, and prints `wrote`;
       - with it present, `unchanged`; with `--force`, identical bytes;
       - a version bump in the module gives `replaced`, and lint's drift warning before it;
       - each failure: `.mp4` with no extractor, a file not starting `%PDF-`, an extractor returning page 0, both `page` and `t`, a kind outside its `kinds` and no parts, and a text holding a key-shaped value. Each exits 1 and writes nothing;
       - a text file is `skipped`, a path outside `raw/` exits 2, and an async `extract` works;
       - lint on an unknown extractor, a missing `extract`, a module with top-level `await`, bad `kinds`, `extensions` and `version`.
     - `test/privacy.test.mjs`:
       - `secretsIn` catches the cases under Patterns and passes the cases listed as passing, plus a PEM public key, data URIs, integrity hashes, sha256 hex, commit ids, UUIDs, slugs, file names, paths and long camelCase words;
       - `scan.mjs`'s output, exit codes, a binary scanned through its derived text, and `privacy.allow`.
     - `test/tool-triggers.test.mjs`:
       - an everywhere domain's `tools` rule reaches a session outside its projects, and a session in the vault folder gets every domain's;
       - a second agent of the session is refused once too, and a reworded rule is refused again;
       - a rule with `tools` and `triggers` fires only when the input's text matches;
       - a mapped MCP tool reached by a glob and by `tools` refuses once;
       - a call with no rule on its name passes;
       - lint errors on `tools: [Bash]` and `tools: [Edit]`.
     - `quotes.test.mjs` also gains the lint tests: a pruned transcript checked against its row, a binary with no derived text, an image, and the tally. `review.mjs status` lists the quotes the tally counts.
     - `rows.test.mjs`: notes and a comment the user didn't type are refused, as is a comment with no transcript. The file's setup (`rows.test.mjs:23-28`) starts each session with a transcript of one user turn holding the words its comments and notes use, so the 26 existing `pick` and `comment` calls change in one place, and `reach.test.mjs:195`'s `pickFor` likewise. A PDF sheet with derived text is taken, and one without is refused.
     - `source-formats.test.mjs`: an anchor inside a line isn't an anchor, so a footnote's `#page=` needing it is warned.
     - The perf group gains the AskUserQuestion test.
   - **Done** when the phase 5 check in §9 passes: the suite passes with 0 `todo` tests, lint reports 0 errors, the grep finds nothing, and the perf group passes, AskUserQuestion test included.
6. **Second adapter.** Built on `phase-6-delivery`, not yet reviewed. Phase 6 splits `tools/hooks/` into the neutral core and `tools/adapters/claude-code/` (6.7a–c). It adds `tools/adapters/codex/` (6.7e) and compiled files (6.7f), and builds the transcript provider test (6.7c). The split is mechanical: the Claude Code adapter turns today's hook input into core events and the core's results back into today's output, so the existing suite pins the behavior through `v.hook` unchanged. Phases 4 and 5 land first and are cited by their item bullets. The line numbers below are this branch's, from before phases 4 and 5, so the builder runs the inventory grep (Neutral core) again before the move.
   - **What this settles in §6.**
     - `preTool` carries `after` as a function and no `before` (6.7a);
     - Codex's Stop continues the turn through `decision: "block"`, not `additionalContext` (6.7e);
     - Codex's exit 1 doesn't block, so decision 1 holds there (6.7e);
     - compiled formats live in adapter folders, and phase 6 ships only the AGENTS.md section (6.7f);
     - the transcript provider test has a fixture half and a live half (6.7c);
     - 6.7a's `answer` event and `block` and `notice` results, and 6.7b's fallbacks, aren't built: neither adapter needs them;
     - Codex has no `userConfig` (6.7d), so its launcher finds the vault from its own folder.
   - **What Codex supports.** These facts come from three places:
     - Codex CLI 0.153.4, installed: `codex --version` and `codex features list`;
     - its source at tag `rust-v0.153.4` (https://github.com/openai/codex). The `.rs` files cited below are under `codex-rs/hooks/src/` and `codex-rs/apply-patch/src/`;
     - the docs that https://developers.openai.com/codex redirects to: https://learn.chatgpt.com/docs/hooks, `/docs/plugins`, `/docs/agent-configuration/agents-md`, `/docs/config-file/config-reference` and `/docs/build-skills`.

     No Codex model run was made.
     - **Hooks** are on by default (`features list`: `hooks stable true`).
       - They are read from `~/.codex/hooks.json`, `[hooks]` in `~/.codex/config.toml`, and a repo's `.codex/hooks.json` and `.codex/config.toml`. The repo's two load only in a trusted project. Every source runs.
       - The JSON has Claude Code's shape: `{ "hooks": { "<Event>": [{ "matcher", "hooks": [{ "type": "command", "command", "timeout" }] }] } }`.
       - A hook runs only once the user trusts it in `/hooks`. Trust is keyed to the hook's definition, so a changed command is skipped until it is trusted again.
     - **Events the vault uses.** The schemas are `codex-rs/hooks/schema/generated/<event>.command.input.schema.json`, with `<event>.command.output.schema.json` beside each.
       - Every input has `session_id`, `transcript_path` (nullable), `cwd`, `hook_event_name`, `model` and `permission_mode`. Every event but SessionStart also has `turn_id`.
       - SessionStart has `source`: `startup`, `resume`, `clear` or `compact`.
       - UserPromptSubmit has `prompt`.
       - PreToolUse has `tool_name`, `tool_input`, `tool_use_id`, and `agent_id` inside a subagent.
       - SubagentStart has `agent_id` and `agent_type`.
       - Stop has `stop_hook_active` and `last_assistant_message`, and no `agent_id`.
     - **Tools.**
       - A file edit is `tool_name: "apply_patch"`, with the patch text in `tool_input.command`.
       - A shell call is `Bash`, with `tool_input.command`.
       - An MCP tool is `mcp__<server>__<tool>`, with its arguments as `tool_input`.
       - Matchers on UserPromptSubmit and Stop are ignored (hooks docs).
     - **Output.**
       - SessionStart, UserPromptSubmit and SubagentStart take `hookSpecificOutput.additionalContext`, or plain stdout, as model context.
       - A PreToolUse deny has Claude Code's shape: `permissionDecision: "deny"` with a non-empty `permissionDecisionReason`. An `ask` fails the hook, and the call goes on.
       - Stop has no `hookSpecificOutput`. `{ "decision": "block", "reason": "…" }` continues the turn, with the reason as a new prompt. Other JSON fails the hook (`stop.rs:282-329`).
       - Context longer than `additionalContextLimit` (2,500 tokens by default, `output_spill.rs:12`) is saved to a file, and the model gets a preview.
     - **Failure.**
       - An exit code other than 0 or 2 marks the hook failed, with the entry "hook exited with code 1", and doesn't block the call (`pre_tool_use.rs:278-284`, `stop.rs:370-375`, `session_start.rs:312-317`).
       - Exit 2 blocks the call.
     - **Commands.**
       - Every command runs through a shell: `%COMSPEC% /C`, which is `cmd.exe`, on Windows, and `$SHELL -lc` elsewhere. There is no exec form (`command_runner.rs:428-433`).
       - `commandWindows` replaces `command` on Windows (`discovery.rs:514`).
       - The timeout defaults to 600 s.
     - **Plugins.**
       - A plugin has no `userConfig`.
       - Plugin hooks are "supported only for manually installed Codex desktop plugins" (plugins docs).
     - **AGENTS.md** is read from the git root down to the cwd, one file per folder, joined, up to `project_doc_max_bytes` (32 KiB). The chain is built once per session, and it has no globs.
     - **Skills** are read from `.agents/skills` in the cwd and each parent up to the repo root, and from `~/.agents/skills`. Codex doesn't read `.claude/skills`.
     - **Session files** are `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`. The docs say only that the format behind `transcript_path` "is not a stable interface".
     - **Session id.** The shell tool's environment has `CODEX_THREAD_ID`. This comes from the binary's strings and openai/codex issues 19937 and 22124, not from the docs.
   - **Inventory.** This is what is Claude Code's today, and where each piece goes.
     - **Hook output** moves to each adapter's `output()`:
       - the deny (`edit.mjs:243`);
       - the context returns (`session-start.mjs:117`, `prompt.mjs:63`, `subagent-start.mjs:20`);
       - Stop's `additionalContext` (`stop.mjs:61`), with the comment on `stop_hook_active` (`stop.mjs:30-33`).
     - **Hook input fields** (`session_id`, `cwd`, `agent_id`, `transcript_path`, `source`, `prompt`, `tool_name`, `tool_input`) become event fields. They are read in:
       - `cwdOf` (`vault.mjs:402`), `touchSession` (`sessions.mjs:22-36`), `agentKey` (`sessions.mjs:145`), and `markPages` and `duePages` (`sessions.mjs:148`, `:165`);
       - `dueRules` (`scope.mjs:31-43`);
       - `session-start.mjs:68-115`, `prompt.mjs:41-49`, `stop.mjs:23-35` and `subagent-start.mjs:9-15`;
       - `edit.mjs:118`, `:137`, `:155-176`, `:198`, `:222` and `:245-271`.
     - **`runHook`** (`vault.mjs:410-422`) stays in the core. Its `CLAUDE_CODE_SAFE_MODE` check (`vault.mjs:411`) moves to the adapter's `disabled()`.
     - **Tool names and edit semantics** move to the adapter:
       - `FILE_TOOLS`, `EDIT_HOOK_MATCHER` and `toolFile` (`vault.mjs:404-407`);
       - `matchIn`, `replaced` and `textAfter` (`edit.mjs:29-54`);
       - the file-tool branches of `target` and `newText` (`edit.mjs:158-161`, `:172-175`).

       Lint's `editTools` checks (`lint.mjs:238-243`) ask the adapters instead.
     - **The session id variable** goes through `currentSession()`, or `sessionIds()` in `ownEntry` (`sessions.mjs:13-17`). It is read in `ownEntry`, `lint.mjs:24` and `log.mjs:55`, and named in the refusal at `propose.mjs:85`.
     - **The transcript reader** (`quotes.mjs:5-28`) becomes `tools/adapters/claude-code/transcript.mjs`. Its callers are `propose.mjs:146` and lint's `typedIn` (`lint.mjs:48-51`).
     - **Registration** stays at the repo root, where the plugin layout needs it: `hooks/hooks.json`, `hooks/launch.mjs` and `.claude-plugin/`. Only the launcher's import path changes (`launch.mjs:33`).
     - **Copy that names Claude Code's tools:** the shell line in `proposeNote` (`session-start.mjs:19`) and `.claude/skills/ingest/SKILL.md:23`.
     - **Comments that name Claude Code** are reworded, or move with their code: `deadline.mjs:1`, `rules.mjs:407`, `quotes.mjs:5-7`, `edit.mjs:39`, `:119` and `stop.mjs:30-33`.
     - **What stays core:** the `tool_input.<field>` syntax of `editTools` (`edit.mjs:149`, `lint.mjs:237`, `:251-252`). It is config's own syntax, and both agents call an MCP tool's arguments `tool_input`.
   - **Layout after the move.**

     ```
     tools/lib/agents.mjs                    the adapter registry and currentSession()
     tools/lib/handlers/start.mjs            session-start.mjs's body
     tools/lib/handlers/prompt.mjs           prompt.mjs's body
     tools/lib/handlers/pre-tool.mjs         edit.mjs's body, less the Claude Code parts
     tools/lib/handlers/subagent-start.mjs
     tools/lib/handlers/stop.mjs
     tools/adapters/claude-code/adapter.mjs
     tools/adapters/claude-code/transcript.mjs
     tools/adapters/claude-code/hooks/{session-start,prompt,edit,stop,subagent-start}.mjs
     tools/adapters/codex/adapter.mjs
     tools/adapters/codex/patch.mjs
     tools/adapters/codex/transcript.mjs
     tools/adapters/codex/compile.mjs
     tools/adapters/codex/launch.mjs
     tools/adapters/codex/hooks/{the same five}.mjs
     tools/agents.mjs                        prints an adapter's registration
     tools/compile.mjs
     ```

     Each hook entry holds three lines, for example `tools/adapters/codex/hooks/edit.mjs`:

     ```js
     import { runHook } from '../../../lib/vault.mjs';
     import * as agent from '../adapter.mjs';
     import { preTool } from '../../../lib/handlers/pre-tool.mjs';
     runHook('edit', agent, preTool);
     ```

   - **Events (6.7a).** These are plain objects, and the core never sees an agent's input.
     - `start { session, cwd, transcript, reason }`, where `reason` is `new`, `resume`, `compact` or `clear`.
     - `prompt { session, agent?, cwd, transcript, text }`.
     - `preTool { session, agent?, cwd, tool, args, target?, added?, after? }`:
       - `target` is `{ namespace: 'file', path }`, set only for the adapter's own file tools. The path is absolute or from `cwd`.
       - `added` is the text the call adds, which triggers are tested on.
       - `after` is a function. The core calls it only for a wiki note, with the file's text (`''` for a new file). It returns the whole text after the call, or null when the adapter can't follow the call. `noteGuard` already handles null (`edit.mjs:119-120`). A call with no `after`, such as one `editTools` maps to the `file` namespace, is read as null: denied on a user's page, let through on any other.
       - The core reads the file itself (`edit.mjs:114-116`), so `before` isn't passed.
       - A call with no `target` is a tool call. The core maps it through `editTools` (`edit.mjs:143-167`) and checks phase 5's `tools` rules on `tool` and `args` (item 5, Tool triggers). `asText(args)` stands where phase 5 has `asText(tool_input)`.
     - `subagentStart { session, agent, cwd }` and `stop { session, agent?, cwd }`.
     - A handler returns `{ context? }` or `{ deny? }`. Neither adapter needs 6.7a's `block` or `notice`, or the `answer` event, so they aren't built. Each agent's answers reach the typed-text provider through its transcript.
   - **`runHook(name, agent, handler)`** replaces `runHook(name, fn)`:
     1. It returns at once when `agent.disabled(process.env)`.
     2. It arms the deadline and parses stdin, as today.
     3. `agent.events(name, input)` returns a list of events. Every hook gives one event, except a Codex patch, which gives one per file.
     4. The handler runs on each event, and `agent.output(name, results)` turns the results into what the hook writes to stdout.
     5. The catch is unchanged: it logs, writes one stderr line, and sets exit 1. Both agents treat exit 1 as a failure that doesn't block.
   - **Adapter interface.** `tools/adapters/<agent>/adapter.mjs` exports:
     - `name`, the folder's name;
     - `capabilities` (6.7b): `{ start, prompt, deny, stopContext, subagentStart, typedText }`, each true or false. Both adapters declare every one. The 6.7b fallbacks, such as keyword rules moving into the start block, wait for an agent that lacks an event, so phase 6 doesn't build them;
     - `sessionVar`: the variable a script reads the session id from;
     - `shortName(sid)`: the session's short name, which tells it from every other session in practice. Claude Code's is the first 8 characters of the id, so older Evidence lines and `raw/inbox/` and `raw/picks/` file names still resolve. Codex's is the last 8, the random tail of its UUIDv7 id, whose first 8 are a timestamp threads started in the same minute share;
     - `disabled(env)`;
     - `events(hook, input)` and `output(hook, results)`. A result list with no `context` and no `deny` gives no output, never an `allow` (6.7a);
     - `fileTools` and `sends(tool)`, which lint reads for `editTools` and for phase 5's `tools` names;
     - `typedMessages(transcript)`, from its `transcript.mjs`, which returns null when the file can't be read;
     - `transcriptCheck(file)` and `newestTranscript(home)`, for the live provider test;
     - `identifiers`: the names only this agent uses, for the neutral-core test;
     - `registration(vaultRoot)`: `{ where, text }`, which `tools/agents.mjs` prints.
   - **Registry** (`tools/lib/agents.mjs`).
     - `agent(name)` loads `tools/adapters/<name>/adapter.mjs` through `byName` in `ext.mjs`, the one name check and `createRequire` loader that extensions and compile formats share too. Each caller keeps its own error text. It throws on an unknown name.
     - `config().agents` lists the adapters that lint checks tool names against, and orders `currentSession()`. Neither delivery nor session ownership reads it. `config()` sets `agents` to `['claude-code']` when it is not a list; `DEFAULTS` doesn't hold it, since `DEFAULTS` merges objects. Lint errors on a name with no adapter folder.
     - `currentSession(env)` returns `{ agent, id }` for the first adapter, in the order of `agents`, whose `sessionVar` is set, or null.
     - `touchSession(event, hits, agentName)` writes `agent` into the registry entry. An entry with no `agent`, which is every entry today, reads as `claude-code`.
     - `shortName(sid, agentName)` gives the adapter's short name, the first agent's when the agent isn't known. Everything that names or matches a session by short name goes through it: the Evidence and `## You said` citations, the `raw/inbox/` and `raw/picks/` file names, the `log.md` lines, `transcriptFor`, lint's row fallback and `review.mjs`'s count of sessions a rule missed. `sessionName(sid, agentName)` in `sessions.mjs` takes the agent from the registry entry when the caller has none. Inbox and pick rows record `agent`, so a row names its session the same way after the registry drops it. Matching compares short names for equality, or the full id; never a prefix.
     - `typedFor(entry)` calls that adapter's `typedMessages(entry.transcript)`. It replaces the call at `propose.mjs:146`. `transcriptFor` (`sessions.mjs:196-200`) returns the entry, so lint's `typedIn` (`lint.mjs:48-51`) calls `typedFor` too.
     - `ownEntry` compares with `sessionIds(env)`, the ids set in the `sessionVar` of every adapter in `tools/adapters/`, whatever `agents` lists. It refuses an id that none of them is, and accepts any id when none is set. `lint.mjs:24` and `log.mjs:55` take the id from `currentSession()`.
     - `propose.mjs` and `pick.mjs` make the session id argument optional. With none, they use `currentSession()`, and with neither they refuse. They check the session before they read stdin, so a missing or unknown session is refused whatever the input. `pick.mjs show` still takes the session id. The refusal at `propose.mjs:85` becomes: "Pass the session id from the taste vault's note at session start, or run this from the agent's own shell, which sets its session id." (open question).
   - **The Claude Code adapter.** Code moves here, and none of it is rewritten.
     - `events`:
       - `session_id`, `agent_id`, `cwd` and `transcript_path` become `session`, `agent`, `cwd` and `transcript`. Events carry the raw `cwd`; handlers apply `cwdOf` as before;
       - SessionStart's `source: startup` becomes `reason: 'new'`, and its other values are kept;
       - `prompt` becomes `text`;
       - a `FILE_TOOLS` call gets `target` from `toolFile` and `after` from `textAfter`;
       - any other tool gets `args: tool_input` and no `target`;
       - the adapter sets `added` for every tool from its new-text field, so trigger behavior is byte-identical.
     - `output` writes today's JSON byte for byte, Stop's `additionalContext` included.
     - `sends(tool)` tests `^(?:EDIT_HOOK_MATCHER)$`, and `hooks/hooks.json:11` still equals the matcher (`plugin.test.mjs:30-33`). The adapter exports `matcher`, and `plugin.test.mjs:7` imports it from there.
     - `sessionVar` is `CLAUDE_CODE_SESSION_ID`, and `disabled` checks `CLAUDE_CODE_SAFE_MODE === '1'`.
     - `transcript.mjs` is `quotes.mjs:5-28` as it stands.
     - `identifiers`: `CLAUDE_CODE_`, `CLAUDE_PLUGIN_`, `hookSpecificOutput`, `permissionDecision`, `additionalContext`, `AskUserQuestion`, `MultiEdit`, `NotebookEdit`, `toolUseResult`, `isCompactSummary`, `system-reminder`, `session_id`, `agent_id`, `tool_name`, `transcript_path` and `Claude Code`.
     - `registration` prints the two install commands in README.md:14-15.
     - **Launcher.** `launch.mjs:33` imports `.live/tools/adapters/claude-code/hooks/<hook>.mjs`, or `.live/tools/hooks/<hook>.mjs` when a `.live` copy from before phase 6 has only that, and its messages are unchanged. An installed plugin whose launcher predates phase 6 still looks for `.live/tools/hooks/<hook>.mjs`. So `tools/hooks/<hook>.mjs` stays for one release as a one-line import of the new entry, and a later phase removes it (open question).
   - **The Codex adapter.**
     - **Registration.** `node tools/agents.mjs codex` prints the hooks for `~/.codex/hooks.json`, with the main checkout's path: git's common dir through `mainWorktree` (`git.mjs`), so a worktree anywhere names it, or `mainCheckout` (`vault.mjs:97`) when git can't say. Without the path's real value, it prints:

       ```json
       {
         "hooks": {
           "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"<vault>/.live/tools/adapters/codex/launch.mjs\" session-start 10", "timeout": 10, "additionalContextLimit": 4000 }] }],
           "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"<vault>/.live/tools/adapters/codex/launch.mjs\" prompt 10", "timeout": 10, "additionalContextLimit": 4000 }] }],
           "PreToolUse": [{ "matcher": "apply_patch|mcp__.*", "hooks": [{ "type": "command", "command": "node \"<vault>/.live/tools/adapters/codex/launch.mjs\" edit 10", "timeout": 10 }] }],
           "SubagentStart": [{ "hooks": [{ "type": "command", "command": "node \"<vault>/.live/tools/adapters/codex/launch.mjs\" subagent-start 10", "timeout": 10, "additionalContextLimit": 4000 }] }],
           "Stop": [{ "hooks": [{ "type": "command", "command": "node \"<vault>/.live/tools/adapters/codex/launch.mjs\" stop 10", "timeout": 10 }] }]
         }
       }
       ```

       It then prints one line: "Merge this into ~/.codex/hooks.json, then open /hooks in Codex and trust the five vault hooks. Codex skips them until you do." (open question).
       - It writes nothing, since AGENTS.md:220 keeps the agent from writing outside the vault.
       - The path uses forward slashes, which node reads on Windows. It is quoted, so `cmd.exe` keeps a path with spaces whole.
       - The command names `.live`, whose content changes with each commit while the definition stays the same, so trust holds across vault commits.
       - `additionalContextLimit` leaves room above `delivery.maxContextChars` (8,000 characters). Codex counts tokens by its own estimate (§11).
     - **Launcher** (`tools/adapters/codex/launch.mjs <hook> <seconds>`).
       - It runs from the vault's `.live/tools/`, so the vault is found from its own folder, and no option or environment variable is needed.
       - It sets `VAULT_HOOK_TIMEOUT` and imports `./hooks/<hook>.mjs`.
       - For a name that isn't a hook, it calls `runHook(hook, agent, () => { throw … })`, so the failure line is runHook's and the launcher prints nothing itself.
     - **`events`.**
       - SessionStart: `source: startup` becomes `reason: 'new'`, and `resume`, `clear` and `compact` are kept. Any other value is read as `new`, since the docs already list `fork`.
       - UserPromptSubmit: `prompt` becomes `text`. A prompt that is a Stop continuation the vault sent (below) gives no event, so it neither restamps the turn nor gets excerpts.
       - PreToolUse: `apply_patch` goes through `patch.mjs`. An `mcp__…` call gives `{ tool, args: tool_input }`. Any other tool gives no event.
       - SubagentStart gives `{ session, agent: agent_id, cwd }`, and Stop gives `{ session, cwd }`.
     - **`patch.mjs`.** `parsePatch(text)` returns `[{ op, path, moveTo?, lines?, chunks? }]`.
       - It follows the grammar in `parser.rs:4-22`, with the markers at `parser.rs:37-45`.
       - It allows whitespace around the markers, as Codex does (`parser.rs:24-25`), and skips an `*** Environment ID:` line.
       - A patch wrapped in a `<<EOF` heredoc is read as Codex's lenient mode reads it.
       - Paths are from `cwd`, or absolute (`parser.rs:85-90`). Spaces between a marker and its path stay part of the path, as Codex's `strip_prefix` leaves them.

       Each file becomes one event:
       - **Add File:** `added` is the content, the `+` lines without their `+`, and `after` returns the content.
       - **Update File:** `added` is the `+` lines joined with LF. `after(before)` applies each chunk in order after the one before it, at its `@@` context line when it has one. It looks for the chunk's ` ` and `-` lines exactly, then ignoring trailing whitespace, then ignoring both ends, then with Unicode dashes, quotes and spaces read as ASCII, as `seek_sequence.rs` does. It returns null when a chunk isn't found. Insertions at one line keep the patch's order, as `file_update.rs` applies them.
       - **Move to:** the source path's event is a delete, `added` `''` and `after` returning `''`. A second event on the new path has the update's `added`, and its `after` applies the chunks to the source's text, read from disk, whatever the destination held; null when the source can't be read.
       - Codex applies the hunks in order (`lib.rs:504`), so hunks on one path compose: each event's `after` runs the patch up to its own hunk, from the `before` it is given for its own file and from disk for any other. An Add ignores what was there, a Delete leaves `''`, and a null carries through.
       - **Delete File:** `added` is `''` and `after` returns `''`. So `vaultGuard` refuses deleting what it guards, `noteGuard` refuses a page cut to nothing once, and a user's page is refused (`edit.mjs:97`).
       - A patch that doesn't parse throws. That is a loud hook failure, and Codex's own parser refuses the same patch.
     - **`output`.**
       - Context from start, prompt and subagentStart becomes `{ hookSpecificOutput: { hookEventName, additionalContext } }`.
       - Denies from a patch's events are joined with a blank line into one PreToolUse deny. Every file's markers were written as it was checked, so the same patch sent again passes.
       - Stop's context becomes `{ "decision": "block", "reason": <context> }`.
         - The adapter marks `continued|<shortHash(context.trim())>` under the `turns` marker kind, which `output()` reaches through the session kept from `events()`.
         - The prompt event and the transcript provider drop a text whose hash is marked. So the vault's own text never counts as the user's words.
         - The gate markers keep it to one continuation per file, as for Claude Code (6.3d).
     - **`transcript.mjs`.** `typedMessages(file)` reads the rollout JSONL.
       - It keeps a line with `type: 'response_item'`, `payload.type: 'message'` and `payload.role: 'user'` whose `payload.internal_chat_message_metadata_passthrough.content_item_kinds` holds one `user.text` and otherwise only `user.*` kinds, such as `user.image` for an image the user attached. Its texts are the `text` of each `input_text` item in `payload.content`. A message with several `user.text` items is a tag-wrapped injection and is dropped.
       - It drops a text that starts `<send_user_message_question_reply`, the reply to Codex's question tool. The answer's format isn't known, and the options in it are the agent's (§7).
       - It drops a text whose hash is marked `continued`.
       - It skips a Stop continuation, which Codex records as a user message with no `content_item_kinds` whose every `input_text` is `<hook_prompt hook_run_id="…">…</hook_prompt>`.
       - It returns null when the file can't be read, has no `session_meta`, or holds any other user message with no `content_item_kinds`. So a format change refuses quotes, rather than letting injected text count as the user's.
     - **Other exports.**
       - `fileTools` is `['apply_patch']`, and `sends` tests `^(?:apply_patch|mcp__.*)$`.
       - `sessionVar` is `CODEX_THREAD_ID`.
       - `proposeShell` names no tool: "from a POSIX shell with a quoted heredoc, since PowerShell turns curly quotes and dashes into ?".
       - `disabled` is always false. Codex has no safe-mode variable: the user turns hooks off in `/hooks` or with `features.hooks = false`.
       - `identifiers`: `CODEX_`, `apply_patch`, `*** Begin Patch`, `content_item_kinds`, `send_user_message` and `Codex`.
     - **Skills.** Codex reads `.agents/skills`, and the skills live in `.claude/skills/`. `.agents/skills/` keeps a copy of each file under `.claude/skills/`. Lint errors when a copy differs other than in line endings, and `lint --fix` writes it (open question); a checkout made before the copies existed can hold the skills with CRLF. Lint also errors on a folder in `.agents/skills/` whose skill folder is gone, naming it to delete, and `lint --fix` leaves it. Codex ignores the Claude-only frontmatter key `disable-model-invocation` (§11).
     - **AGENTS.md.** Codex reads the vault's AGENTS.md natively in the vault folder, so the vault's own instructions need nothing compiled.
   - **Compiled files (6.7f, decision 4).**
     - **Opt-in.** `domains.<d>.compile` in `vault.config.json` lists the adapters whose format that domain's projects get, for example `["codex"]`. It is unset by default. Lint errors on a name whose adapter has no `compile.mjs`.
     - **Command.** `node tools/compile.mjs <project>...`.
       - A project's domains are those `sessionReach(project)` finds, as at session start, that have `compile`. Its formats are the union of their lists.
       - It exits 2 for a path that isn't a folder, a folder in the vault, and a project no opted-in domain reaches. It checks every path before it writes any file.
     - **What compiles.** The live, settled rules of global and those domains:
       - always rules;
       - `file` namespace glob rules, grouped by their `applies_to`;
       - keyword rules, grouped by their `keywords`.

       Within each group, rules go in key order (`cmp`), so the bytes are fixed. A rule with `triggers` is listed under its globs, and its triggers are dropped. The section depends only on committed files, the vault's notes and config and the project's own files such as its lockfile, so every machine compiles the same bytes: a label from `.state/`, such as "source changed on", stays out of its lines.

       What doesn't compile:
       - namespace globs, since the formats know only files;
       - `tools` rules;
       - pages, whose paths are this machine's vault.
     - **Interface.** The core builds `{ always: [line], files: [{ globs, lines }], keywords: [{ keywords, lines }] }`, with each line from `ruleLine`. `tools/adapters/<agent>/compile.mjs` exports `compile(sections, root)`, which reads the project's file, writes nothing, and returns `[{ path, text, rules, state, changed }]` (plus `refused`, the reason, when it won't write). `state` is `missing`, `current`, `stale`, `edited` or `refused`; `changed` counts the rules whose line differs from the section's now. `lib/compile.mjs` loads the format by its path, so an agent with no hooks needs no `adapter.mjs`. A Cursor or Copilot format would be one more adapter folder holding only `compile.mjs`, with every capability false.
     - **The Codex format** is a marked section of `<root>/AGENTS.md`:

       ```md
       <!-- taste-vault: begin 3f9c01ab77e0d2c1 · written by node tools/compile.mjs, which refuses to rewrite it once it is edited by hand -->
       ## Taste rules

       From the user's taste vault. Follow them in this project.

       - glim/panel-gap: Do: … Not: …

       ### When editing src/**/*.txt

       - glim/code-header: Do: … Not: …

       ### When the request mentions panel or grid

       - glim/grid-words: Do: … Not: …
       <!-- taste-vault: end -->
       ```

       - The hash is `shortHash` of the text between the two markers.
       - The rest of the file is kept byte for byte. A new file holds the section alone.
       - A new section takes the file's line endings: CRLF when the file already has any. An existing one keeps the line endings and trailing spaces of its own marker lines, so a section that differs from what compile would write only there is `current`.
       - It fits `compile.maxBytes` (16,384 by default, half of Codex's 32 KiB for all AGENTS.md files together) through `fitContext`, whose overflow line counts the rules it left out. The cap counts the bytes of the section as written, its markers and line endings included, so the format cuts again until the section fits. A cap below the heading, intro and overflow line leaves just those. A value that isn't a whole number above 0 is a lint error, and compile uses the default. The line names no file, since other machines and repos read the section without the vault: `(Left out to stay within 16384 bytes: 3 rules.)`.
       - A glob of a domain whose project root sits below the folder compiled into starts with that path. A worktree's folder is read as its main checkout's, as project roots are. A folder below a domain's project root is `refused`, naming the root to compile instead, since its globs would start in the wrong place. A `!` entry reads as "except" in the heading. A rule with globs and keywords is listed under both.
       - Markers it can't pair (a begin with no end, two begins, an end before a begin) and a file that isn't UTF-8 text are `refused`, with nothing written. Lines inside a fence that closes are the file's own text, so markers there don't count.
       - A section edited by hand since it was compiled is `edited` and refused too, so compile never loses the user's words. The begin marker says so.
     - **Output.** One line per file, then exit 0, or 1 when any line is `refused`. A file that can't be written is `refused` too, and the projects after it still compile:

       ```
       wrote <root>/AGENTS.md: 12 rules
       unchanged <root>/AGENTS.md
       refused <root>/AGENTS.md: the taste-vault section was edited by hand since it was compiled. Move those edits out of the section, or delete it, then compile again.
       refused <root>/AGENTS.md: the file can't be written (EPERM). Make it writable, then compile again.
       refused <root>/sub: the glim rules' globs start at <root>, which holds this folder. Run node tools/compile.mjs <root> instead.
       ```

     - **Rebuilds.** A section is rebuilt only when the user runs the command. No hook, build or git hook writes one (decision 4).
     - **Drift.** Lint checks each folder that an opted-in domain lists under `paths` in `vault.local.json`, since a project reached only by a marker has no root to look in. A section whose markers don't pair is also a warning, with the `refused` reason. All three findings are warnings, since the project is another repo and lint runs in the vault's pre-commit hook:
       - no section: `not compiled; run node tools/compile.mjs <root>`;
       - a hash that doesn't match: `edited by hand since it was compiled; move those edits out of the section, or delete it, then run node tools/compile.mjs <root>`;
       - a body that differs from what compiling now would write: `stale: 3 rules changed since it was compiled; run node tools/compile.mjs <root>`.
     - **With Codex hooks.** A project whose domain opts in to `codex` gets its rules twice in a session whose Codex hooks are trusted. The README says to opt in only for a project where the hooks don't run, such as a machine without the vault's hooks, or a repo other people's agents read.
     - **What is lost** (6.7f): deny-then-retry, `triggers`, once-per-session delivery, proposing, pages and namespace globs. The copy is stale until compiled again.
   - **Neutral core.**
     - `test/neutral-core.test.mjs` gains a second test. It loads every adapter's `identifiers`, folder name and `sessionVar`, and fails on each one found in a file under `tools/` outside `tools/adapters/`, naming the file and line. Only three kinds of line are accepted: `FIRST_AGENT` in `tools/lib/agents.mjs`, the `agents` default in `config()` in `tools/lib/vault.mjs`, and the one-line `tools/hooks/<hook>.mjs` shims that import an adapter's hook. It reads the names from the adapters, so the test itself names no agent.
       - It scans `tools/` only. `test/` keeps Claude Code payloads, which the existing tests pin, and the skills and AGENTS.md are copy for every agent, which review checks.
       - The domain-key test keeps its four roots, and `tools/adapters/` falls inside them.
     - The inventory grep, run from the vault folder, prints what the identifier test would find:

       ```sh
       git grep -nE 'CLAUDE_|CODEX_|hookSpecificOutput|permissionDecision|additionalContext|AskUserQuestion|MultiEdit|NotebookEdit|apply_patch|content_item_kinds|toolUseResult|isCompactSummary|system-reminder|\b(session_id|agent_id|tool_name|transcript_path)\b|Claude Code|Codex' -- tools ':!tools/adapters'
       ```

       On this branch it prints the inventory's lines. After the move it prints nothing.
     - Lint's code rules (`lint.mjs:626-651`) follow the move:
       - `inHooks` matches `^adapters/[^/]+/hooks/`, and the `runHook` check (`lint.mjs:642`) applies there;
       - `quiet` covers `adapters/` and `lib/`, so neither prints nor reaches the network;
       - the `tools/hooks/` shims are exempt from the `runHook` check while they last.
     - `CODING_STANDARDS.md:37-38` say `adapters/<agent>/hooks/`. They gain one rule: nothing outside `adapters/` names an agent, its tools or its hook fields, and an adapter holds no delivery logic.
   - **Fixtures.**
     - **`test/fixture.mjs`.**
       - `v.hook(name, input, { agent = 'claude-code', timeout })` runs `adapters/${agent}/hooks/${name}.mjs` (`fixture.mjs:71-81`). Every existing caller keeps the default.
       - `cleanEnv` (`fixture.mjs:142-147`) also deletes `CODEX_THREAD_ID`.
     - **`test/codex.mjs`** holds the Codex helpers:
       - `codexInput(event, fields)` fills each event's required fields from the 0.153.4 schemas. For PreToolUse:

         ```js
         { session_id, transcript_path: null, cwd, hook_event_name: 'PreToolUse', model: 'fixture-model', permission_mode: 'default', turn_id: 'turn-1', tool_name: 'apply_patch', tool_use_id: 'call-1', tool_input: { command: patch } }
         ```

       - `codexPatch(ops)` writes patch text from `{ add | update | delete, path, lines, moveTo }`.
       - `codexRollout(v, sid, messages)` writes a rollout under `.transcripts/`: a `session_meta` line, then one `response_item` per message:

         ```jsonl
         {"timestamp":"2026-11-01T00:00:00.000Z","type":"session_meta","payload":{"id":"<sid>","cwd":"<project>","cli_version":"0.153.4"}}
         {"timestamp":"2026-11-01T00:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<the vault's AGENTS.md>"}],"internal_chat_message_metadata_passthrough":{"content_item_kinds":["agents_md.instructions"]}}}
         {"timestamp":"2026-11-01T00:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Keep the grid gap at eight."}],"internal_chat_message_metadata_passthrough":{"content_item_kinds":["user.text"]}}}
         ```

         The shape was read from local Codex rollouts, field names only (§11).
     - **Schemas.** The five input and five output schemas at `rust-v0.153.4` are copied into `test/fixtures/codex/schema/`. A test checks each `codexInput` payload against its input schema and each output the adapter writes against its output schema. This is a few lines over the keys the schemas use (`type`, `const`, `enum`, `required`, `properties`, `additionalProperties`, `$ref` and `allOf`), not a validator dependency.
   - **Tests.** Each new test is written before its code and seen red for its reason.
     - **Existing tests.** They pass unchanged, except:
       - `plugin.test.mjs:26` reads `tools/adapters/claude-code/hooks`;
       - `plugin.test.mjs:82` and `:90` write the new `.live` path. The message at `plugin.test.mjs:73` doesn't change.
     - **The neutral-core identifier test** comes first. It is red on this branch, naming `sessions.mjs:14` and the other inventory lines, and green once the move is done.
     - **`test/adapters.test.mjs`, the contract.** It loops over `['claude-code', 'codex']`. Each agent has a driver in `test/drivers/<agent>.mjs`, which builds that agent's payloads and reads its outputs: `start`, `prompt`, `editFile`, `toolCall`, `subagent`, `stop`, `context(out)`, `deny(out)` and `continued(out)`. On the `glim` preset, for each agent:
       1. A session start delivers the always rule. A `compact` start after a refusal makes the next edit refuse again.
       2. A prompt with a keyword gets the excerpt once.
       3. The first edit to a covered file is denied with the rule. The same edit again gives no output, never an `allow`.
       4. An edit outside every glob gives no output.
       5. A subagent hears the always rules, and its edit is gated apart from the parent's.
       6. A shell write, then a stop, continues once with the lead line. The next stop gives nothing.
       7. With a broken `vault.config.json`, each hook exits 1 with one `vault <hook> failed:` line and nothing on stdout.
       8. An `editTools` MCP tool is gated in its namespace.
       9. `propose.mjs` with no session argument uses the session from the agent's `sessionVar`.
       10. The typed-text provider returns the typed message from the driver's fixture transcript, and none of the injected text.
     - **`test/codex.test.mjs`.**
       - The parser handles Add, Update with and without `@@` context, Move to, Delete, an Environment ID line, whitespace around the markers, and `*** End of File`.
       - A patch over two covered files gives one deny naming both. The same patch again passes. A malformed patch is a loud failure.
       - A move's source event leaves `''` and its destination gets the source's new text; an update after an add or another update on the same path applies to the earlier result. A move onto a page that drops its `## You said` line, and an add then update that marks a page `author: user`, are refused.
       - `after()` on a wiki note: a patch that removes a `## You said` line is refused; one that adds lines under `## Agent notes` on a user's page passes; a chunk that matches nothing refuses a user's page.
       - Stop's output is `{"decision":"block","reason":…}` byte for byte. A prompt with that text afterwards gives no output and doesn't restamp the turn, and the provider drops it.
       - The provider keeps `user.text` and the text of a text-and-image message, drops `agents_md.*`, `environments.*`, `additional_content.*`, the question reply and a Stop continuation in Codex's `<hook_prompt>` shape, and returns null for any other user message with no `content_item_kinds` and for a missing file.
       - `source` mapping, including an unknown value read as `new`.
       - `node tools/agents.mjs codex` prints the snippet byte for byte, for a vault at a fixed POSIX path and at a fixed Windows path, and it parses as JSON with the five events.
       - Every `codexInput` payload fits the copied schemas.
     - **`test/compile.test.mjs`.**
       - The `glim` project's AGENTS.md section byte for byte, as a literal in the test.
       - An existing AGENTS.md with CRLF keeps its other text and its line endings.
       - A second run prints `unchanged`. A hand edit inside the section is `refused`, with exit 1 and nothing written.
       - Lint warns on not compiled, stale and edited by hand.
       - A project no opted-in domain reaches exits 2. A namespace-glob rule is left out. Over `compile.maxBytes`, the overflow line appears, naming no path on this machine.
       - Lint errors on `compile: ["nope"]` and on `agents: ["nope"]`.
     - **`test/transcript.test.mjs`** (6.7c, the fixture half).
       - Each adapter's provider, given a fixture transcript with one record of each kind it reads or skips, returns exactly the expected list.
       - For Claude Code, the fixture holds a typed prompt, a queued prompt, an `AskUserQuestion` answer with labels and notes, an `isMeta` record, a compaction summary, a tool result, a `task-notification` turn and a `system-reminder` block. A turn with `origin.kind: 'task-notification'` is dropped, which shows the field is read.
       - For Codex, the fixture holds the kinds the `codex.test.mjs` provider case lists.
     - **`test/live/transcripts.live.mjs`** (6.7c, the live half). It runs with `VAULT_LIVE=1 node --test test/live/*.live.mjs`, outside the default run, as the perf group is.
       - For each adapter, `newestTranscript(os.homedir())` finds the newest session file on this machine: `~/.claude/projects/*/*.jsonl`, or `~/.codex/sessions/**/rollout-*.jsonl`.
       - `transcriptCheck(file)` returns `{ ok, missing, records }`, `records` being the file's line count. Claude Code's needs a `type: 'user'` record with an `origin` object. Codex's needs `session_meta` and a user `response_item` with `content_item_kinds`.
       - It prints only counts and field names, never a message's text. With no session file, it skips and says why.
       - Passing means the fields each provider reads exist in a current transcript.
     - The perf group runs again, since every hook now goes through `events` and `output`.
   - **Order of the build.**
     1. The identifier test, seen red.
     2. The move, with the Claude Code adapter. The suite passes, and so does the identifier test.
     3. The Codex adapter and its tests.
     4. Compiled files.
     5. The provider tests.
   - **Rules that change.**
     - `CODING_STANDARDS.md` changes as Neutral core says.
     - The README gains a Codex section: `node tools/agents.mjs codex`, trust in `/hooks`, and what §7 declares.
     - `.claude/skills/ingest/SKILL.md:23` drops `"$CLAUDE_CODE_SESSION_ID"`, since `propose.mjs` reads the session itself. Its shell wording is copy (open question).
     - `proposeNote`'s shell line (`session-start.mjs:19`) comes from the adapter, as `agent.proposeShell`. Claude Code's is today's line. Codex's names no tool (open question).
     - AGENTS.md changes as §10 says.
   - **Open questions.** The recommended choice comes first, and is what this design says.
     - Codex ships opt-in. The user runs `node tools/agents.mjs codex`, merges the hooks and trusts them, and adds `codex` to `agents`. Codex's trust step rules out shipping it on. The alternative is a `--write` flag that merges into `~/.codex/hooks.json`, which needs the "Write outside the vault" exception widened.
     - The hooks go in the user's `~/.codex/hooks.json`. Alternatives: each project's `.codex/hooks.json`, which needs project trust and a copy per project; or a Codex plugin, whose hooks the docs limit to desktop plugins installed by hand.
     - Phase 6 ships only the AGENTS.md section. The alternative is Cursor `.mdc` and Copilot `.instructions.md` too, each pinned from its documented format with no agent to try it on.
     - Skills for Codex are byte copies in `.agents/skills/`. Alternatives: move the skills to `.agents/skills/` and point `plugin.json` there, which makes Claude Code see them only as plugin skills in the vault folder; or no Codex skills in phase 6.
     - A Codex question-tool reply is dropped from typed text. The alternative is reading the user's own words out of it, once its format is documented.
     - `tools/hooks/` keeps one-line shims for one release. The alternative is no shims: a stale plugin then fails every hook loudly until `claude plugin update`.
     - Copy: the snippet's closing line, the compiled section's heading and intro line, the `refused` line, the `propose.mjs:85` refusal, and the skill's and `proposeNote`'s shell lines (`CODING_STANDARDS.md:15`).
   - **Done** when the phase 6 check in §9 passes. The suite passes with no `todo` test, the identifier test included. Lint reports 0 errors. Both greps print nothing, and the perf group passes. The live provider check is run once on a machine that has both agents' session files.

## 9. Checks

| Check | Passing means | Today |
|---|---|---|
| `node --test test/*.test.mjs` | All pass; each `todo` fails for the reason its design section names | 598 tests on `phase-6-delivery`: 597 pass, 1 skipped (making a link needs Developer Mode on Windows), 0 `todo`, about 68 s. Lint: 0 errors. |
| Neutral-core test (§3) | No configured domain's key or title appears in `tools/`, `.claude/skills/`, `test/` or AGENTS.md | Passes on this vault's config, with its `todo` mark removed (phase 3). |
| Phase 4 check: the suite through the TAP reporter, then lint and the grep, below the table | The suite has no failure and exactly 2 `todo` tests, 6.3c and 6.4a, both failing; lint reports 0 errors; the grep prints nothing. Then 6.1c, 6.2a and 6.2b pass, and only phase 5's checks are open. Run the perf group too, since phase 4 adds a read to every hook. | Passes (phase 4, before review): 431 pass, 0 fail, 2 `todo`, 6.3c (the first AskUserQuestion isn't denied) and 6.4a (a quote the PDF's derived text doesn't hold is written); lint 0 errors; the grep prints nothing. The perf group passes. Passes again after the review's fixes: 458 pass, 1 skipped, 0 fail, the same 2 `todo`; lint 0 errors; the grep prints nothing; the perf group passes, its build test included. |
| Phase 5 check: the suite through the TAP reporter, then lint, the grep and the perf group, below the table | The suite has no failure and no `todo` test; lint reports 0 errors; the grep prints nothing; the perf group passes, AskUserQuestion test included. Then every *Check* in §6 runs on built code. | Passes (phase 5, before review): 473 pass, 0 fail, 0 `todo`; lint 0 errors; the grep prints nothing. The perf group passes, the AskUserQuestion call at 212 ms. After the review's fixes: 530 pass, 1 skipped, 0 fail, 0 `todo`; lint 0 errors; the grep prints nothing. The perf group's latency tests pass, the AskUserQuestion call at 260 ms; its build test misses, a session start that builds taking about 5.2 s against 5,000 ms. With phase 4's perf pass merged in: 535 pass, 1 skipped, 0 fail, 0 `todo`; lint 0 errors; the grep prints nothing; the perf group passes, the AskUserQuestion call at 207 ms and a session start that builds at about 1.5 s. |
| Phase 6 check: the phase 5 check, then the agent-name grep, below the table | The phase 5 check passes, with the neutral-core identifier test, the adapter contract test and the Codex and compile tests in the suite; the agent-name grep prints nothing. Then nothing in `tools/` outside `tools/adapters/` names an agent, its tools or its hook fields. | Passes (phase 6, after review fixes): 620 pass, 0 fail, 0 `todo`; lint 0 errors; both greps print nothing. The perf group passes: a gated edit at 3,000 notes 199 ms, an AskUserQuestion call 187 ms, a session start that builds about 1.4 s. The live provider check finds every field it reads in both agents' newest transcripts. |
| Phase 3 check: the suite, then the grep below the table | With the neutral-core `todo` mark removed, the suite passes with 5 `todo` tests (6.1c, 6.2a, 6.2b, 6.3c, 6.4a), each red for its reason, and the grep prints nothing. Then no test, tool, skill or AGENTS.md example leans on one platform, and only the five later-phase checks are open. | Passes (phase 3): the five `todo` tests fail for their reasons, and the grep prints nothing. |
| The probes as `todo` tests (phase 0) | Each passes with its `todo` mark removed: slow trigger, subagent gate, settle after an mtime change, negated glob, one refusal per file, frontmatter | All pass with their marks removed (phase 2): slow trigger, subagent gate (2), settle after an mtime change (2), one refusal per file, frontmatter, long-path prefix. Negated glob passes (phase 1). |
| Perf group: `VAULT_PERF=1 node --test test/perf/*.perf.mjs` (about 50 s, outside the default run) | Fastest of 5 gated edits under 1,000 ms at 1,000 notes; fastest of 3 under 300 ms at 3,000; three parallel proposes of unrelated rules at 3,000 notes all succeed (6.6f); an AskUserQuestion call under 300 ms at 3,000 notes (6.3c); at 3,000 notes and 3,000 files in `raw/refs/`, the fastest of 3 session starts that build, after a note edit and after a new copy, under 5,000 ms, and the fastest of 3 builds with nothing changed under 1,500 ms (`build.perf.mjs`) | About 135–166 ms; about 245–290 ms; all succeed in about 4.3–5.4 s (phase 3). With phase 4's reads, 145 ms; 232 ms; all succeed in about 7.4 s, since builds run one at a time under `build.lock`. A warm session start at 3,000 notes takes about 340 ms, including the vault-wide stat for the lint reminder. After the review's fixes, 191 ms; 298 ms; all succeed in about 6.4 s; a session start that builds about 4.6 s, one with nothing changed about 630 ms, and a build with nothing changed about 830 ms. With the copies in `raw/refs/` cached and the hooks' stats taken at once, 155 ms; 201–218 ms; all succeed in about 5.9 s; a session start that builds about 1.4 s, one with nothing changed about 550 ms, and a build with nothing changed about 810 ms. With phase 5, before phase 4's fixes were merged in, 138 ms; 220 ms; an AskUserQuestion call 212 ms; all succeed in about 7.1 s. After phase 5's fixes, 170 ms; 275 ms; an AskUserQuestion call 260 ms; all succeed in about 5.9 s; a session start that builds about 5.2–5.4 s, one with nothing changed about 640–730 ms, and a build with nothing changed about 830–1,010 ms. With phase 4's perf pass merged into phase 5, 172 ms; 233 ms; an AskUserQuestion call 207 ms; all succeed in about 6.3 s; a session start that builds about 1.5 s, one with nothing changed about 590 ms, and a build with nothing changed about 870 ms. With phase 6, before review, 204 ms; 258 ms; an AskUserQuestion call 250 ms; all succeed in about 7.2 s; a session start that builds about 1.8 s, one with nothing changed about 665 ms, and a build with nothing changed about 1,050 ms. The timings are noisy on this machine. |
| Each *Check* in §6 | As stated there, against the presets. All 17 pass in phase 5 | 17 pass against the presets (6.2c and 6.6f in the perf group), 6.3c and 6.4a with their `todo` marks removed (phase 5, before review) |
| Transcript provider test (6.7c): `test/transcript.test.mjs`, and `VAULT_LIVE=1 node --test test/live/*.live.mjs` outside the default run | Each adapter's provider returns exactly the typed messages in its fixture transcript; the live half finds the fields each provider reads in this machine's newest transcript, printing only field names and counts | Built on `phase-6-delivery`. The fixture half passes for both adapters, and the live half passed on 2026-11-01 with no field missing from either newest transcript. |
| Linear regex test (6.6c) | `new RegExp(p, 'l')` works after `v8.setFlagsFromString` on the installed Node | Works on Node 22.14 |
| Vault server trial (6.7g) | A PreToolUse `mcp_tool` hook's JSON deny stops an Edit, and a gated edit is faster than the cached command hook | Run once in a scratch folder, not kept. Deny honored, but it fails open. |
| Hook trials (6.2c, 6.3d, 6.6a) | In headless runs of the installed Claude Code: Stop `additionalContext` and `decision: "block"` continue the turn in bypass mode; a failing hook is recorded on each event; exec form is faster than Git Bash | Run once in a scratch folder on 2.1.296, not kept. All three hold. Exec form saves about 50 ms a call, less than measured outside Claude Code. |
| Plugin trial (6.7d) | In headless runs with the plugin loaded by `--plugin-dir`, the hooks deliver from the vault the option names | Run once in the scratchpad (phase 2), not kept. 7 of 7 behaviors held: `CLAUDE_PLUGIN_OPTION_VAULT` from the parent env reached the hooks; the SessionStart always rule; one refusal, then the retry; Stop context for a shell write; SubagentStart context and the per-agent gate; 107–209 ms per hook; a loud failure on every hook for a bad vault path. |

The phase 3 check, run from the vault folder:

```sh
node --test test/*.test.mjs && ! git grep -nIiE 'luau|\.lua\b|roblox|--!strict|UIListLayout|task\.wait|local x = 1|\bdemo\b' -- test tools .claude/skills AGENTS.md
```

It exits 0 when both hold: the suite passes and the grep prints nothing. A failure prints the failing tests or the lines the grep found.

The phase 4 check, run from the vault folder:

```sh
out=$(node --test --test-reporter=tap test/*.test.mjs); echo "$out" | grep -E '^# (pass|fail|todo) |^not ok '; echo "$out" | grep -qx '# fail 0' && echo "$out" | grep -qx '# todo 2' && [ "$(echo "$out" | grep -cE '^not ok .* # TODO 6\.(3c|4a), phase 5')" = 2 ] && node tools/lint.mjs && ! git grep -nIiE 'luau|\.lua\b|roblox|--!strict|UIListLayout|task\.wait|local x = 1|\bdemo\b' -- test tools .claude/skills AGENTS.md
```

It prints the tally and every top-level test that failed, `todo` ones included. It exits 0 only when the suite has no failure, its 2 `todo` tests are 6.3c and 6.4a and both fail, lint finds no error, and the grep prints nothing. A passing `todo` test still counts as `todo`, so the `not ok` count is what shows both are red.

The phase 5 check, run from the vault folder:

```sh
out=$(node --test --test-reporter=tap test/*.test.mjs); echo "$out" | grep -E '^# (pass|fail|todo) |^not ok '; echo "$out" | grep -qx '# fail 0' && echo "$out" | grep -qx '# todo 0' && node tools/lint.mjs && ! git grep -nIiE 'luau|\.lua\b|roblox|--!strict|UIListLayout|task\.wait|local x = 1|\bdemo\b' -- test tools .claude/skills AGENTS.md && VAULT_PERF=1 node --test test/perf/*.perf.mjs
```

It prints the tally and every top-level test that failed. It exits 0 only when the suite has no failure and no `todo` test, lint finds no error, the grep prints nothing, and the perf group passes.

The phase 6 check, run from the vault folder:

```sh
out=$(node --test --test-reporter=tap test/*.test.mjs); echo "$out" | grep -E '^# (pass|fail|todo) |^not ok '; echo "$out" | grep -qx '# fail 0' && echo "$out" | grep -qx '# todo 0' && node tools/lint.mjs && ! git grep -nIiE 'luau|\.lua\b|roblox|--!strict|UIListLayout|task\.wait|local x = 1|\bdemo\b' -- test tools .claude/skills AGENTS.md && VAULT_PERF=1 node --test test/perf/*.perf.mjs && ! git grep -nE 'CLAUDE_|CODEX_|hookSpecificOutput|permissionDecision|additionalContext|AskUserQuestion|MultiEdit|NotebookEdit|apply_patch|content_item_kinds|toolUseResult|isCompactSummary|system-reminder|\b(session_id|agent_id|tool_name|transcript_path)\b|Claude Code|Codex' -- tools ':!tools/adapters'
```

It prints what the phase 5 check prints, then every line outside `tools/adapters/` that names an agent. It exits 0 only when the phase 5 check passes and that grep prints nothing. The identifier test in the suite checks the same from the names each adapter exports, its folder name and its `sessionVar`; the grep also catches a name no adapter lists yet. The test accepts three kinds of line: `FIRST_AGENT` in `tools/lib/agents.mjs`, the `agents` default in `config()` in `tools/lib/vault.mjs`, and the one-line `tools/hooks/<hook>.mjs` shims that import an adapter's hook.

## 10. AGENTS.md changes

The design changes these parts of AGENTS.md. Each change lands with the phase that builds it.

- **Examples throughout.** Use placeholder domains, such as `example-ui`, instead of a real one (§3).
- **Lines 50–76 and 154–159 (the rule and footnote examples), phase 3.** They move from one platform's script files and docs to a widely known stack: TypeScript files for the rule's globs, and a CSS layout sentence with an MDN link for the footnote example. The rule example moves as one unit, its globs, keyword, Do, Not and Evidence quote together, so no line keeps the old platform's words.
- **Line 11 (research domains).** `projects: []` becomes `markers`, `paths` and `everywhere`, and vault-only becomes an explicit `vaultOnly: true`.
- **Lines 22–27 (how rules and pages reach the agent).**
  - Line 22: one refusal per file carries every due rule and page (decision 6, 6.5).
  - Line 25: a rule is shown again when it turns unverified.
  - Line 27: "A page never refuses an edit" goes.
- **Line 62 (knowledge rules).** They take `keywords` and `always` like taste rules, with `requires` and a longer cap. This also changes `rules.mjs:146`.
- **Line 66 (`always`).** The rule that the user sets it and `propose.mjs` refuses it stays for taste rules. The text is rechecked once knowledge rules take it.
- **Lines 67–69 (scope fields).** Add namespace globs, `!` exclusions and `tools`.
- **Pages section.** Add `author: user` and `## Agent notes` (6.1f), derived text (6.4a), bundles (6.4b) and locators (6.1e).
- **Line 186 ("Write outside the vault").** Add the one exception for `tools/compile.mjs` in opted-in projects (decision 4).
- **Line 188 (what the hooks refuse).** `vaultGuard` (`edit.mjs:7-14`) adds:
  - `index/<domain>.md`;
  - `vault.local.json`;
  - `derived/`, which extraction writes, not edits by hand;
  - `.sources/`.
- **Phase 4.** The line numbers are AGENTS.md's at the end of phase 3.
  - Line 10 (`raw/refs/`): `tools/refresh.mjs` writes `etag`, `last_modified` and `sha256`, and each new copy, `<stem>.<8 hex>.md` with `replaces`, or `baseline: true` for the first copy of a source saved without a hash. Leave all of them to it. To cite a file from a git repository, save it as `raw/refs/<name>.md` with `repo`, `path` and `commit` (the full hash) and the file's text at that commit below, and quote from that text.
  - Line 15 (`.state/`): it also holds `derived.json`, which refresh and build write, and `versions.json`.
  - Line 38 (shown again): a rule is also shown again when its label changes. "source changed on <date>" means a source the note cites has a newer copy, fetched that day, that the note doesn't cite yet, or "source changed" when no newer copy has a valid fetched day: check the fact against the new copy, then propose again with `repeats` and a quote from it, or retire the note. "version unknown" means the note's `requires` couldn't be checked against the project's lockfile.
  - Line 46 (start lines): the line counting the sources a session's domains cite that haven't been checked within `checkAfterDays`.
  - Line 80 (`as_of`): `staleAfterDays` and `checkAfterDays` are set per domain under `domains.<d>.knowledge`, and the age warning counts from the last day the note's sources were checked.
  - Line 81 (`requires`): "Nothing reads a project's versions yet" goes. A domain's `readers` read the project's lockfile, a note the lockfile rules out isn't delivered, and one it can't check is labelled "version unknown".
  - Line 162 (bundles): a doc set is a folder holding `llms.txt`, one source. Save its manifest and the pages notes cite, not the rest.
  - Line 207 (Lint): `/lint` runs refresh first. Offline, it reports the failed checks and goes on.
  - Line 213 (conflicting evidence): between knowledge rules, prefer the one that matches the project's version, then the newer `as_of`.
  - Line 222 (what the hooks refuse): add `.sources/`.
- **Phase 6.** The line numbers are AGENTS.md's at the end of phase 3; phases 4 and 5 shift them.
  - Line 3: "so Claude Code can apply and look them up" becomes "so an agent can apply and look them up", and the hooks are in `tools/adapters/<agent>/hooks/`.
  - Line 16 (`tools/`): `tools/adapters/<agent>/` holds what is one agent's, its hooks included; the rest of `tools/` is the core and the scripts. A new line after it: `.agents/skills/` holds copies of `.claude/skills/` for Codex, which lint checks and `lint --fix` writes; edit the skill in `.claude/skills/`.
  - Line 44: "since Claude Code turns a longer one into a file path" becomes "since the agent turns a longer one into a file path".
  - The domain keys (after `vaultOnly`): a `compile` bullet. It is a list of adapter names, unset by default; the user runs `node tools/compile.mjs <project>` to write the domain's live `always`, file-glob and keyword rules, and global's, into a marked section of the project's `AGENTS.md`, for an agent with no hooks to deliver them. `compile.maxBytes` caps the section, and lint errors on a name with no `tools/adapters/<name>/compile.mjs`.
  - Line 91 (`tools`): names are each agent's own, and lint checks them against every adapter that `agents` in `vault.config.json` lists.
  - Line 195 (rules): "the project's CLAUDE.md or `.claude/rules/`" becomes "the project's own agent instructions, such as CLAUDE.md, AGENTS.md or `.claude/rules/`". A compiled taste-vault section doesn't count as the project's own.
  - Line 207 (Lint): lint also warns on a compiled section that is missing, stale or edited by hand, and names the `node tools/compile.mjs` command to run.
  - Line 220 ("Write outside the vault", listed above as line 186): the exception names `node tools/compile.mjs`, run by the user, in projects whose domain lists an agent under `compile`. `node tools/agents.mjs` prints hooks for the user to merge and writes nothing.
- **Phase 5.** The line numbers are AGENTS.md's at the end of phase 3; phase 4's changes shift them.
  - Line 11 (`derived/`): `node tools/extract.mjs <file>` writes it, through an extractor in `tools/ext/extractors/` that `extractors` in `vault.config.json` lists.
  - Line 92 (`tools`): "Nothing delivers on `tools` yet" goes. The first call to a listed tool in a session is refused with the rule, once per agent, and the retry goes through. Lint reports a name the edit hook never sees, or one that edits a file, as an error.
  - Line 161 (locators): an anchor is a line of its own in the derived text.
  - Line 162 (bundles): "A later phase's fetch tool makes bundles" becomes: `node tools/bundle.mjs raw/refs/<folder>` writes its `source.md`.
  - Line 163 (derived text): name `tools/extract.mjs` as the tool that writes and replaces it, and say lint warns when a listed extractor's version has moved on, naming the command to run.
  - Line 189 (sheets): a file with derived text can be a sheet too. `pick.mjs` refuses `notes` and comments the user didn't type in the session.
  - Line 204 (Ingest): `/ingest` extracts a binary source's text and scans every source for key- or token-shaped text before going through it, and stops on either until the user decides.
  - Line 212 (quotes): `propose.mjs` also refuses a quote a binary's derived text doesn't hold, a quote against a binary with none, and a source quote against an image, which backs `basis: reading` only. Lint warns on each such quote in a note, checks a quote whose transcript is gone against its `raw/inbox/` row, and counts in one line the quotes it can't check.

## 11. Unverified claims the design leans on

1. Whether `SessionStart` and `UserPromptSubmit` fire inside subagents. Undocumented. Neither fired inside an Explore subagent in the phase 2 trial, and the design doesn't depend on it.
2. The transcript's `origin.kind` field is observed, not documented, and the format is documented as unstable.
3. The V8 linear engine flag is experimental. It works on Node 22.14, in-process.
4. That a denied `AskUserQuestion` costs one agent retry and no user turn (6.3c).
5. For compiled files and skills: whether Claude Code reads `.agents/skills`, which would show the Codex skill copies twice (§8 item 6), and whether the Copilot cloud agent can reach the vault. OpenCode's v2 payloads no longer bear on the design, since Codex is the second adapter (decision 5).
6. Whether Claude Code normalizes a `directory` option's path itself. The launcher doesn't rely on it: it reads a Git Bash `/c/...` path as `C:/...` and refuses a relative one (6.7d). What the phase 2 plugin trial settled: `CLAUDE_PLUGIN_OPTION_VAULT` from the parent env reaches the hooks under `--plugin-dir`, and `pluginConfigs` is read from user settings, `--settings` and managed settings, never project settings (Claude Code's debug log).
7. For refresh (phase 4), with git 2.49.0.windows.1 on Node 22.14:
   - Not verified: that git is on `PATH` on every machine that runs refresh. Without it, each git source is a failed check, `git not found`, and URL sources still run.
   - Not verified: `origin/HEAD` when the remote has none or changes its default branch. A clone sets it and `git fetch` doesn't move it. Refresh treats an `origin/HEAD` that doesn't resolve as a failed check.
   - Not verified: repo paths and cited paths with spaces. Refresh passes arguments as an array with no shell, so none is split, but no run tried one.
   - Not verified: the cost of reading `derived.json` in each hook with thousands of sources. It is expected to be small; the perf group measures it.
   - Not verified: servers that send weak ETags or ignore `If-None-Match`. They answer 200 with the same body, which refresh still records as `unchanged`, at the cost of the download.
   - Settled by scratch scripts against an in-process `node:http` server and a `git init` repo, not kept: `fetch` with `If-None-Match` or `If-Modified-Since` gets a 304 with an empty body; `redirect: 'manual'` returns the 3xx with its `location`; `AbortSignal.timeout` throws a `TimeoutError`; a refused connection and an unknown host throw `fetch failed` with `err.cause.code` set to `ECONNRESET` or `ENOTFOUND`; a streamed body can be stopped at a byte cap. `git clone --no-checkout` from a `C:/…` path takes about 160 ms, `git fetch` about 215 ms. `git show <commit>:<path>` works with forward slashes and fails with a backslash, and returns CRLF as committed. `git log <commit>..origin/HEAD -- <path>` is empty when only another file changed. `git cat-file -e` on an unknown commit, and a clone from a missing path, exit 128. `spawnSync` blocks a test's own server, and `spawn` doesn't.
8. For phase 5, on Claude Code 2.1.296 and Node 22.14:
   - Not verified: that the edit hook's deny reaches the agent for `AskUserQuestion` in an interactive session, with the same deny-then-retry as an edit. A headless trial couldn't test it: `AskUserQuestion` isn't offered in `claude -p`, so the model's tool search found no such tool and the hook never ran. The 6.3c test drives the hook directly, and claim 4 above, no user turn, stays unverified.
   - Not verified: how often the `token` and `assignment` patterns flag text in real sources. The 4.2-bit entropy threshold was set on a few dozen hand-made samples.
   - Settled by scratch scripts, not kept: the fixture extractor reads the new `paper.pdf` bytes and its rendering equals the preset's derived text byte for byte; the file still fails `TextDecoder('utf-8', { fatal: true })`. `createRequire` of an ES module with top-level `await` throws `ERR_REQUIRE_ASYNC_MODULE`, and an async `extract` export loads and runs. The secret patterns catch and pass the cases Privacy lists, including integrity hashes after the `sha384-` fix, and scan a 1.86 MB line in about 25 ms.
9. For phase 6, on Codex CLI 0.153.4, from its docs, its source at `rust-v0.153.4` and local rollout files, with no Codex model run:
   - Not verified: where the user sees a hook that exits 1. The source marks it failed, "hook exited with code 1", and goes on; the TUI and desktop app weren't checked.
   - Not verified: whether the Stop continuation's prompt fires UserPromptSubmit. The adapter drops it either way.
   - Not verified: a cap on Stop continuations in a row, like Claude Code's 8. The gate markers keep it to one per file.
   - Not verified: the rollout fields the provider reads, `content_item_kinds`, `input_text` and the `<send_user_message_question_reply` prefix. They were seen in local Codex Desktop 0.158–0.160 rollouts, field names only, and aren't documented.
   - Not verified: that `CODEX_THREAD_ID` in the shell tool's environment equals the hooks' `session_id`. It comes from the binary's strings and openai/codex issues 19937 and 22124.
   - Not verified: that Codex's question tool reaches PreToolUse, so a phase 5 `tools` rule could name it.
   - Not verified: that a denied `apply_patch` costs one agent retry and no user turn, as claim 4 assumes for Claude Code.
   - Not verified: how Codex estimates tokens for `additionalContextLimit`. 4,000 leaves twice the room 8,000 characters need at 4 characters a token.
   - Not verified: how `/hooks` presents five new hooks for trust, and that a changed vault path asks again. The docs key trust to the definition.
   - Not verified: that hooks in `~/.codex/hooks.json` run in a project the user hasn't trusted. The docs gate only a project's own hooks on trust.
   - Not verified: that Codex ignores `disable-model-invocation` in a skill's frontmatter rather than refusing the skill.
   - Settled from the source: exit codes other than 0 and 2 don't block (`pre_tool_use.rs:278-284`); Stop takes only its schema (`stop.rs:282-329`); commands run through `cmd.exe` on Windows (`command_runner.rs:428-433`); `additionalContextLimit` defaults to 2,500 tokens (`output_spill.rs:12`); the `apply_patch` grammar (`parser.rs:4-45`) and the order chunks are matched in (`seek_sequence.rs:1-6`). The paths are under `codex-rs/hooks/src/` and `codex-rs/apply-patch/src/`.

## 12. Not doing

- **Session-end capture.** Tried and removed in 03ce4d9, because it produced agent-written briefs, not the user's words.
- **0–1 confidence scores with decay.** Taste ranks by basis, evidence count and recency. Knowledge ranks by version match and `as_of`, and freshness comes from re-checking sources.
- **Word segmentation for languages written without spaces.** The user doesn't need Japanese text supported. `Intl.Segmenter` would also cover Chinese and Thai, which nothing has asked for either. Search and quotes split on Unicode letter runs (6.4d).
- **Vector search.** Field-weighted BM25 holds at this size. Revisit once a domain passes a few hundred pages.
- **Auto-ingest on a new source.** The user stays in the loop, as Karpathy has it. `/ingest batch` covers bulk.
- **`.claude/rules` as the main delivery.** See §4.
- **A Cursor-style single `scope` enum.** The vault's scope fields compose: a rule can have globs and keywords at once. An enum would force one channel per rule.
- **Parsing shell commands, or using `FileChanged`, for gating.** See §7.
- **Built-in support for any domain, ecosystem or tool.** See §3 and decision 7.
- **`mcp_tool` hooks.** They fail open. See 6.7g.
- **Adding knowledge or taste as part of this design.** See §8.
