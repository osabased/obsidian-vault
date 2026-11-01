# All-rounder vault: design draft

Status: draft, 2026-11-01. Phase 0 (checks), phase 1 (format) and phase 2 (delivery) are built and merged into main. Phase 3 (neutral fixtures) is built, reviewed and landed on `phase-3-delivery`, not yet merged into main. Phase 4 (knowledge mechanisms) is built on `phase-4-integration`, not yet reviewed.

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
    - Delivery labels an unverified rule "source changed on <date>". The shown-marker includes that state, so a rule shown earlier in the session is shown again once it turns unverified.
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
- *Check.* A fixture domain with a 2,000-link manifest and 50 cited pages starts a session in under 500 ms.

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
  - **Scoped walk.** Hooks walk only `wiki/<the session's domains>/` and `wiki/global/`. The `/lint` reminder still counts notes vault-wide: the walked notes reuse their stats, and the other folders are stat'ed only, never parsed (`noteTimes`).
  - **Derived state** (unverified, settled) is precomputed by refresh and build (6.2a), and hooks read it.
  - **Build on change.** Session start builds only when a fingerprint changed. The fingerprints, in `.state/cache/.built.json`, hash each folder's notes and the config except each domain's `paths`, which differ per machine and shape no generated file. Every build that writes records them (`build.mjs`), so propose, pick, lint and pre-commit keep them current. A dot name keeps the file apart from the folders' cache files.
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
  - **Matcher.** The PreToolUse matcher in `hooks.json` is fixed when the plugin ships. It names no user's tools: `Edit|Write|MultiEdit|NotebookEdit|AskUserQuestion|mcp__.*`.
    - An MCP call that maps to nothing returns at once. It still pays the hook's process start: about 100 ms in exec form, 150 ms through Git Bash (6.2c).
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

**a. Core events.** The core takes plain events and returns `{ context?, deny?, block?, notice? }`:
- `start { session, cwd, reason }`, where `reason` is `new`, `resume`, `compact` or `clear`;
- `prompt { session, cwd, text }`;
- `preTool { session, agent?, cwd, tool, target?, before?, after?, added? }`, where `target` is `{ namespace, path }`;
- `subagentStart { session, agent, cwd }`;
- `stop { session, agent?, cwd }`;
- `answer { session, question, options, picked, notes }`, optional.

The result has no `allow`. A PreToolUse `allow` skips the permission prompt the user's mode would show (6.7g trial: "Hook approved tool use for Edit, bypassing permission prompt"). So an adapter maps "no objection" to no output, never to `allow`.

The Claude Code adapter maps hook I/O (`hookSpecificOutput`, `permissionDecision`, `additionalContext`, which on Stop continues the turn), tool names and `CLAUDE_CODE_SESSION_ID` to these. The coupling sits today in:
- `vault.mjs:257-269`;
- `edit.mjs:24-42,123-142`;
- `prompt.mjs`, `session-start.mjs` and `sessions.mjs:11`;
- the transcript reader in `quotes.mjs:5-28`.

**b. Capabilities.**
- Each adapter declares what it can do: deliver at start, deliver per prompt, deny, block a stop, the subagent event, its session-id variable and its typed-text provider.
- Where one is missing, the core falls back. Keyword rules move into the start block.
- An agent with no typed-text provider can propose with `reading`, `source`, `failure` and `pick` only, as `propose.mjs:118-121` already does.

**c. Typed-text provider.**
- The provider takes a session and returns what the user typed.
- Claude Code's provider reads the transcript and keeps turns whose `origin.kind` is `human` (`quotes.mjs:11`).
- A test pins the transcript fields it reads, so a format change fails a test instead of silently passing or refusing quotes. *(unverified: the `origin` field is observed in transcripts, not documented.)*

**d. Packaging.**
- The plugin ships `hooks/hooks.json` and a `userConfig` option `vault` of type `directory`.
- Each hook is a command hook in exec form, which runs with no shell: `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/launch.mjs", "<hook>", "<seconds>"]` (hooks). This skips the Git Bash start on Windows (6.2c). The seconds repeat the hook's `timeout` for the deadline (6.6b).
- The launcher reads `CLAUDE_PLUGIN_OPTION_VAULT` and imports the hook from that vault's `.live/tools/`. So the installed plugin copy never goes stale against the vault.
- On Windows the launcher reads a Git Bash spelling, `/c/...`, as `C:/...`. It refuses a relative path with a hook error, since one would name a different folder in each session.
- The plugin reference confirms each part: `userConfig` takes type `directory`, hook processes get `CLAUDE_PLUGIN_OPTION_VAULT`, and `${CLAUDE_PLUGIN_ROOT}` resolves in exec-form `args`. On Windows, exec form needs `command` to resolve to a real executable, which `node.exe` is.

**e. Codex.**
- Codex has the same event names, deny and `additionalContext`.
- Its edits arrive as `apply_patch` text in `tool_input.command`, so its adapter parses the patch into `preTool` events.
- It loads `AGENTS.md` from the root down, with no globs.
- Its transcript format is documented as unstable for hooks.

**f. Agents without hooks.**
- `node tools/compile.mjs <project>` (decision 4) compiles rules for the project's agents:
  - Cursor `.mdc` files: `alwaysApply` from `always`, `globs` from `applies_to`, and keywords as `description`;
  - Copilot `.instructions.md` files, with `applyTo`;
  - or a marked section of `AGENTS.md`.
- It writes only into projects that `vault.config.json` opts in. The user decides whether the project commits them.
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
     - 6.2b on `almanac`: the test generates a manifest of 2,000 links and 50 cited pages under `raw/refs/<set>/`, then expects the first session start after it, and the fastest of three, under 500 ms, and `review.mjs sources` to list the set as one source. The second part fails until doc sets are built. The builder confirms it is red for that reason before marking it.
     - 6.3c on `glim`: the first `AskUserQuestion` is denied with the `tools` rule. It fails because the edit hook doesn't match on `tools`.
     - 6.4a on `archive`: a fabricated quote against `paper.pdf` is refused, and a real one passes. It fails because quotes never read `derived/`. `quotes.test.mjs:178`, which asserts that a binary source is not checked, stays until phase 5 inverts it.

     The locally served URL source, the fixture git source, the feed and the fixture version reader come with phase 4, since building them now would fix interfaces phase 4 hasn't designed. The extractor fixtures come with phase 5.
   - **The other tests** keep their own setup but lose `demo` and every platform word: about 56 test blocks in 13 files name a file type, page name or code of one platform, and `demo` appears about 900 times. They take `glim`'s words: `.zq` files, invented page names, and invented code in trigger payloads and quotes. `glob.test.mjs`'s `.lua`/`.luau` cases become `.zq`/`.zqx`, which keeps the prefix pair.
   - **AGENTS.md.** Its examples move to a widely known stack (§10).
   - **Neutral core.** The neutral-core test loses its `todo` mark (`test/neutral-core.test.mjs:20`).
   - **Done** when the phase 3 check in §9 passes: the suite passes with 5 `todo` tests, each red for its reason, and the grep for platform words finds nothing.
4. **Knowledge mechanisms.** Built, not yet reviewed, on `phase-4-integration`. Phase 4 builds refresh, git sources, doc sets and unverified state (6.1d, 6.2a, 6.2b), and the version reader interface with one fixture reader (6.1c). Feed parsing, `sitemap.xml` and every real reader stay build-or-reuse until a domain needs them. Two §6 lines are settled here: `review.mjs` already matches a saved copy by URL and hash (6.1d), and quotes are checked against the saved copy, not `git show` (6.2a).
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
     - **URL sources.** Refresh calls `fetch` with `redirect: 'manual'`, `AbortSignal.timeout(refresh.timeoutSeconds * 1000)`, and `If-None-Match` and `If-Modified-Since` from the latest copy's `etag` and `last_modified`, or from the last 200 that `derived.json` stored. It reads the body as a stream and stops past `refresh.maxBytes`. It decodes the body with `TextDecoder('utf-8', { fatal: true })`, splits it on `\r?\n` as `frontmatter.mjs:337` does, and hashes it. A 304, or a 200 with the latest copy's `sha256`, is `unchanged`. The new `etag` and `Last-Modified` go to `derived.json`, never to `raw/`. A new hash writes a new copy.
     - **Git sources.** The repo is cloned to `.sources/<name>/`. `<name>` is the repo's last path segment, without a trailing `/` or `.git`, then `-` and the first 8 hex digits of the repo string's sha256, so two repos named alike don't share a folder. `lib/git.mjs` gains these, each run with `execFileSync`, no shell, arguments as an array and a `refresh.timeoutSeconds` timeout:
       - `clone(repo, dir)`: `git clone --quiet --no-checkout <repo> <dir>`, when `.sources/<name>/.git` is missing. With no work tree, no line-ending conversion or long path applies;
       - `fetchOrigin(dir)`: `git fetch --quiet origin`;
       - `hasCommit(dir, commit)`: `git cat-file -e <commit>^{commit}`, exit 0;
       - `changedSince(dir, commit, path)`: `git log --format=%H%x09%cs <commit>..origin/HEAD -- <path>`, newest first;
       - `showAt(dir, commit, path)`: `git show <commit>:<path>`, as bytes.

       An empty `changedSince` is `unchanged`. Otherwise refresh writes a copy of the newest commit's file.
     - **Failures.** Each one is a `failed` check with its reason in `derived.json`, and refresh writes nothing under `raw/`:
       - no network or no such host: `fetch failed: <err.cause.code>`, such as `ENOTFOUND`;
       - timeout: `no answer in 20 s`;
       - a status other than 2xx and 304: `HTTP 404`;
       - a 3xx: `redirected to <Location>`. Refresh doesn't follow it, so the user saves the source again under its new URL;
       - a body over the cap: `body over 5000000 bytes`;
       - a body that isn't UTF-8: `body isn't UTF-8 text`;
       - git missing: `git not found`. A clone or fetch that exits non-zero gives its exit code and the first line of git's stderr;
       - a commit the repo doesn't hold: `commit <c> isn't in <repo>`;
       - a cited path gone upstream: `<path> is gone at <commit8>`.
       - a clone whose `origin/HEAD` doesn't resolve: `remote has no default branch`.
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
       "unverified": { "almanac/ledger-v2": { "mtime": 1793000000000, "size": 812, "since": "2026-11-01", "sources": ["<id>"] } },
       "domains": { "almanac": ["<id>"] } }
     ```

     - `checked` is the day of the last check that didn't fail. A failed check sets `result: "failed"` and `why`, and keeps `checked`.
     - Build writes `chain`, `unverified` and `domains` from `raw/refs/` and the notes. `domains` holds, per domain, the ids its delivered notes cite. Build fills `checked` from the latest copy's `fetched` for a source never checked, and keeps what refresh wrote. Refresh writes the check fields, then runs build. Both write under `build.lock` (`withLock`, `vault.mjs:470`).
     - The chain lives in `raw/`, so a fresh clone's first build labels its notes before any refresh.
     - A hook reads the file once with `readJson(statePath('derived.json'), {})`. A missing file means nothing is unverified. A corrupt one throws, so the hook fails loudly (6.6a).
     - An `unverified` entry applies only while the note file's mtime and size match what the cache holds (`cache.mjs`). A note edited to cite the new copy loses its label at once, before the next build.
   - **Version readers (6.1c).**
     - **Interface.** `tools/ext/readers/<name>.mjs` exports:
       - `ecosystem`, the name a `requires` entry's `package.ecosystem` gives;
       - `lockfiles`, the file names it reads;
       - `scheme`, `'SEMVER'` or `'ECOSYSTEM'`;
       - `read(dir)`, which returns `{ <package>: <version> }` for the folder holding the lockfile;
       - with `ECOSYSTEM`, `compare(a, b)`, which returns a negative number, 0 or a positive number.

       It is loaded with `extension('readers', name, ['read'])` (`ext.mjs:15-20`). Lint checks the rest as it checks aliases (`lint.mjs:223-232`): an unknown reader, a missing export, a `scheme` that is neither, `ECOSYSTEM` without `compare`, and two readers in one domain with one `ecosystem`. Lint warns on a `requires` ecosystem no reader of the note's domain answers to.
     - **Config.** `domains.<d>.readers` lists reader names.
     - **Lockfile.** For each reader, the nearest folder at or above the project root that holds one of its `lockfiles`. The search stops after a folder holding `.git`, or at the filesystem root. So one lockfile at a monorepo root serves its packages.
     - **Cache.** `.state/versions.json` maps `<root>|<reader>` to `{ lockfile, mtimeMs, size, versions }`. A hook re-reads the lockfile when its stat differs, or when its mtime is within `RACY_MS` of the cached read (`cache.mjs:14`). It writes through `writeJson`.
     - **Comparison.** `lib/versions.mjs` holds `compareSemver(a, b)`, SemVer 2.0.0 precedence, prereleases included and build metadata ignored, built on the `SEMVER` pattern `rules.mjs:198-224` already validates with. It also holds OSV range evaluation: events in order, `introduced` opens (`'0'` from the start), `fixed` and `limit` close before their version, and `last_affected` closes after it. No version comparison exists today.
     - **Fit.** A note with `requires` is a match, a mismatch or unknown for a project:
       - an entry matches when the lockfile's version of its package is in one of its ranges, and mismatches when it isn't, or when the lockfile doesn't list the package;
       - an entry is unknown when the domain has no reader for its ecosystem, no lockfile is found, or the reader throws. A throw is logged once per lockfile stat to `.state/errors.log`;
       - a note with several entries matches when any entry matches, mismatches when all mismatch, and is otherwise unknown.
     - **Delivery.** `deliverable(items, { versions, derived })` in `rules.mjs` runs after each hook's match step, and in `pick.mjs show`, on rules and pages alike:
       - it drops mismatches and sorts matches before unknowns within a rank;
       - it adds the labels `version unknown` and `source changed on <since>`. `ruleLine` and `rulePointer` (`rules.mjs:402`, `:405`) put each after the clipped text with ` · ` before it: `… As of 2026-10-02. · version unknown · source changed on 2026-11-01`. The separator keeps a space before each label, which 6.2a's pattern needs;
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
     - Lint's age warning (`lint.mjs:97-100`) counts from the later of `as_of` and the last day every source the note cites was `checked`. A source re-checked unchanged keeps its notes fresh.
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
   - **Windows.** Verified on this machine (§11): `git show` needs forward slashes in `<commit>:<path>`, so refresh joins paths with `/`. A clone from a `C:/…` path works. `git show` returns the committed bytes, CRLF kept, and refresh splits on `\r?\n` as frontmatter does. Removing a test vault that holds a clone works.
   - **Where the build differs.** Each choice the design left open, or made differently:
     - A note with no `requires` ranks with a match in `rankPair`, ahead of `version unknown`.
     - On a page's line, the labels go after its path, not after the clipped summary.
     - Refresh asks `remoteHead` before fetching a git source, and runs git with `GIT_TERMINAL_PROMPT=0`, so a remote that wants credentials fails the check instead of waiting.
     - The start line counts global's sources with the session's domains, and names the smallest `checkAfterDays` among the domains it counts.
     - A bundle with a `source.md` is not refreshed, since nothing fetches one yet.
   - **Done** when the phase 4 check in §9 passes: the suite passes with 2 `todo` tests (6.3c, 6.4a), each red for its reason, lint reports 0 errors, and the grep finds nothing. The perf group still passes.
5. **Media and tool triggers.**
   - 6.4a–c and e, with the extractor interface; real extractors go through build-or-reuse;
   - 6.3c.
6. **Second adapter.** The core and adapter split (6.7a–c), the Codex adapter (6.7e) and compiled files (6.7f), built together so a real second agent shapes the split.

## 9. Checks

| Check | Passing means | Today |
|---|---|---|
| `node --test test/*.test.mjs` | All pass; each `todo` fails for the reason its design section names | 434 tests: 431 pass, 1 skipped (making a link needs Developer Mode on Windows), 2 `todo` (6.3c, 6.4a), about 27 s. Lint: 0 errors. |
| Neutral-core test (§3) | No configured domain's key or title appears in `tools/`, `.claude/skills/`, `test/` or AGENTS.md | Passes on this vault's config, with its `todo` mark removed (phase 3). |
| Phase 4 check: the suite through the TAP reporter, then lint and the grep, below the table | The suite has no failure and exactly 2 `todo` tests, 6.3c and 6.4a, both failing; lint reports 0 errors; the grep prints nothing. Then 6.1c, 6.2a and 6.2b pass, and only phase 5's checks are open. Run the perf group too, since phase 4 adds a read to every hook. | Passes (phase 4, before review): 431 pass, 0 fail, 2 `todo`, 6.3c (the first AskUserQuestion isn't denied) and 6.4a (a quote the PDF's derived text doesn't hold is written); lint 0 errors; the grep prints nothing. The perf group passes. |
| Phase 3 check: the suite, then the grep below the table | With the neutral-core `todo` mark removed, the suite passes with 5 `todo` tests (6.1c, 6.2a, 6.2b, 6.3c, 6.4a), each red for its reason, and the grep prints nothing. Then no test, tool, skill or AGENTS.md example leans on one platform, and only the five later-phase checks are open. | Passes (phase 3): the five `todo` tests fail for their reasons, and the grep prints nothing. |
| The probes as `todo` tests (phase 0) | Each passes with its `todo` mark removed: slow trigger, subagent gate, settle after an mtime change, negated glob, one refusal per file, frontmatter | All pass with their marks removed (phase 2): slow trigger, subagent gate (2), settle after an mtime change (2), one refusal per file, frontmatter, long-path prefix. Negated glob passes (phase 1). |
| Perf group: `VAULT_PERF=1 node --test test/perf/*.perf.mjs` (about 10 s, outside the default run) | Fastest of 5 gated edits under 1,000 ms at 1,000 notes; fastest of 3 under 300 ms at 3,000; three parallel proposes of unrelated rules at 3,000 notes all succeed (6.6f) | About 135–166 ms; about 245–290 ms; all succeed in about 4.3–5.4 s (phase 3). With phase 4's reads, 145 ms; 232 ms; all succeed in about 7.4 s, since builds run one at a time under `build.lock`. A warm session start at 3,000 notes takes about 340 ms, including the vault-wide stat for the lint reminder. The timings are noisy on this machine. |
| Each *Check* in §6 | As stated there, against the presets. 15 of the 17 pass in phase 4; 6.3c and 6.4a are `todo` until phase 5 | 15 pass against the presets (6.2c and 6.6f in the perf group); 6.3c and 6.4a are `todo` tests, each red for its reason (phase 4) |
| Transcript provider test (6.7c) | The fields the provider reads still exist in a current transcript | Not built |
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
  - Line 38 (shown again): a rule is also shown again when its label changes. "source changed on <date>" means a source the note cites has a newer copy, fetched that day, that the note doesn't cite yet: check the fact against the new copy, then propose again with `repeats` and a quote from it, or retire the note. "version unknown" means the note's `requires` couldn't be checked against the project's lockfile.
  - Line 46 (start lines): the line counting the sources a session's domains cite that haven't been checked within `checkAfterDays`.
  - Line 80 (`as_of`): `staleAfterDays` and `checkAfterDays` are set per domain under `domains.<d>.knowledge`, and the age warning counts from the last day the note's sources were checked.
  - Line 81 (`requires`): "Nothing reads a project's versions yet" goes. A domain's `readers` read the project's lockfile, a note the lockfile rules out isn't delivered, and one it can't check is labelled "version unknown".
  - Line 162 (bundles): a doc set is a folder holding `llms.txt`, one source. Save its manifest and the pages notes cite, not the rest.
  - Line 207 (Lint): `/lint` runs refresh first. Offline, it reports the failed checks and goes on.
  - Line 213 (conflicting evidence): between knowledge rules, prefer the one that matches the project's version, then the newer `as_of`.
  - Line 222 (what the hooks refuse): add `.sources/`.

## 11. Unverified claims the design leans on

1. Whether `SessionStart` and `UserPromptSubmit` fire inside subagents. Undocumented. Neither fired inside an Explore subagent in the phase 2 trial, and the design doesn't depend on it.
2. The transcript's `origin.kind` field is observed, not documented, and the format is documented as unstable.
3. The V8 linear engine flag is experimental. It works on Node 22.14, in-process.
4. That a denied `AskUserQuestion` costs one agent retry and no user turn (6.3c).
5. For the second adapter and compiled files: OpenCode v2 payloads, whether Claude Code reads `.agents/skills`, and whether the Copilot cloud agent can reach the vault.
6. Whether Claude Code normalizes a `directory` option's path itself. The launcher doesn't rely on it: it reads a Git Bash `/c/...` path as `C:/...` and refuses a relative one (6.7d). What the phase 2 plugin trial settled: `CLAUDE_PLUGIN_OPTION_VAULT` from the parent env reaches the hooks under `--plugin-dir`, and `pluginConfigs` is read from user settings, `--settings` and managed settings, never project settings (Claude Code's debug log).
7. For refresh (phase 4), with git 2.49.0.windows.1 on Node 22.14:
   - Not verified: that git is on `PATH` on every machine that runs refresh. Without it, each git source is a failed check, `git not found`, and URL sources still run.
   - Not verified: `origin/HEAD` when the remote has none or changes its default branch. A clone sets it and `git fetch` doesn't move it. Refresh treats an `origin/HEAD` that doesn't resolve as a failed check.
   - Not verified: repo paths and cited paths with spaces. Refresh passes arguments as an array with no shell, so none is split, but no run tried one.
   - Not verified: the cost of reading `derived.json` in each hook with thousands of sources. It is expected to be small; the perf group measures it.
   - Not verified: servers that send weak ETags or ignore `If-None-Match`. They answer 200 with the same body, which refresh still records as `unchanged`, at the cost of the download.
   - Settled by scratch scripts against an in-process `node:http` server and a `git init` repo, not kept: `fetch` with `If-None-Match` or `If-Modified-Since` gets a 304 with an empty body; `redirect: 'manual'` returns the 3xx with its `location`; `AbortSignal.timeout` throws a `TimeoutError`; a refused connection and an unknown host throw `fetch failed` with `err.cause.code` set to `ECONNRESET` or `ENOTFOUND`; a streamed body can be stopped at a byte cap. `git clone --no-checkout` from a `C:/…` path takes about 160 ms, `git fetch` about 215 ms. `git show <commit>:<path>` works with forward slashes and fails with a backslash, and returns CRLF as committed. `git log <commit>..origin/HEAD -- <path>` is empty when only another file changed. `git cat-file -e` on an unknown commit, and a clone from a missing path, exit 128. `spawnSync` blocks a test's own server, and `spawn` doesn't.

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
