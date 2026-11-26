# Self-maintaining vault: design

Status: decided, 2026-11-03, then revised the same day after an independent review and again after a two-researcher panel, which reversed §11.17: automatic commits wait for the code/data split (§3.8, §12). Phases 1 to 3 are built (`e92d0a7`, merged as `bbd7167`). On 2026-11-05 the user dropped the code/data split, and with it the automatic commits and the async upkeep hook; phase 5 became the status-line counts alone (§11.27, §12), and is built (`00a0a7c`, merged as `1a5f5b9` the same day). The dropped design is in git history at `bbd7167`. It follows the user's answers of 2026-11-03, cited here as A1 to A14 (§1). The user took every recommended option, then the review's fixes, including an async SessionStart hook for upkeep, then the panel's fixes. §11 records the decisions. The copy in §7 is approved.

Scope: how the vault grows from the user's work and keeps itself in order. That covers how project sessions capture rules and page changes, the review queue, how pages build up, how rules age and retire, how domains appear, what session start reports, and `/lint`. The vault is personal, so this designs for one user. Mechanism only: this design adds no domain knowledge. Names of libraries, marker files, readers and thresholds go in `vault.config.json`, in extensions or in notes, never in `tools/`.

Inputs: reads of `AGENTS.md`, `reference/delivery.md`, `reference/notes.md`, `tools/CODING_STANDARDS.md`, `tools/lib/instructions.mjs`, `tools/propose.mjs`, `tools/keep.mjs`, `tools/lib/offers.mjs`, `tools/lib/calls.mjs`, `tools/lib/handlers/` (start, prompt, stop, pre-tool, subagent-start, vault-call), `tools/adapters/claude-code/adapter.mjs`, `tools/adapters/codex/adapter.mjs`, `tools/mcp/tools.mjs`, `mcp/launch.mjs`, `tools/review.mjs`, `tools/refresh.mjs`, `tools/lint.mjs`, `tools/lib/git.mjs`, `tools/lib/vault.mjs`, `tools/lib/versions.mjs`, `hooks/launch.mjs`, `hooks/hooks.json`, `.githooks/pre-commit`, `.githooks/post-commit`, `.gitignore`, the `/lint`, `/ingest` and `/vault` skills, at commit `fffd7bc`, and the Claude Code hooks reference (code.claude.com/docs/en/hooks, "Run hooks in the background").

Claims about the code are verified unless marked *(unverified)* or *(inferred)*. A bare file name means the one file of that name in `tools/`, `tools/lib/` or `hooks/`.

## 1. The user's answers

| # | Answer, short | Section |
|---|---|---|
| A1 | A correction or a stated preference gets a rule offer at once, as now. | §3.1 |
| A2 | Gotcha rules and page changes are held during a task and offered together, once, in the final reply. This holds in every project. In a project no domain covers, they go to `global`, limited by `applies_to`. | §3.1 |
| A3 | The user approves each rule and each page change: Allow once at a prompt, or a typed code. | §3.1, §3.2 |
| A4 | A skipped or ignored offer goes to the review queue. So does whatever an unattended run learned (a subagent, `claude -p`, a run left alone), marked as unattended. | §3.3 |
| A5 | Each library has one entity page that collects its gotchas and versions and links its rules. A comparison page appears when two libraries do the same job. | §3.2 |
| A6 | Superseded on 2026-11-25 (§11.29): a gotcha goes on the library's page, and becomes a rule only when missing it would be silent or costly at a set moment. Was: a gotcha starts as a rule, and the library gets a page once a gotcha needs more than one line of background, or once it has about 3 rules. | §3.2 |
| A7 | A page is built from what happened: the error, the fix that worked and the docs read, with links and dates. Anything else is labelled as the agent's reading. | §3.2 |
| A8 | Rules that cluster on a topic roll up into a page that explains and links them. Roll-ups are drafted into the queue. | §3.2, §3.7 |
| A9 | Nothing happens to a rule without the user's click: no new rule, no change, no retirement. | §3.4 |
| A10 | A knowledge rule whose library version has moved on is flagged. It stops reaching projects on the newer version. It is retired only after the user approves. | §3.4 |
| A11 | Domains appear when needed. Agents offer them as now. `/lint` also suggests them from `global` rules whose `applies_to` keeps matching one kind of project. | §3.5 |
| A12 | At each session start, cheap checks run with no model cost. They fix what has one right answer and commit it. The rest is named in the start line. Content waits. No schedules, and no agent runs the user didn't start. The commit was dropped (§11.27). | §3.6 |
| A13 | `/lint` in the vault folder refreshes sources and makes the fixes. It drafts page updates, roll-ups, domain suggestions and retirements. Then it walks the user through the queue one decision at a time. | §3.7 |
| A14 | Approved changes, mechanical fixes and logs are committed automatically. The user's Obsidian edits go in their own commit, marked as theirs, with the next vault commit. A commit that pre-commit refuses stays uncommitted and is reported. Dropped (§11.27). | §3.8 |

## 2. Where it stands

- **Capture.** In domain sessions, the start note tells the agent to propose a taste rule on a correction, and a knowledge rule after a failure or from a dated source, both in one sentence (`WHEN`, `instructions.mjs:8`). In `ask` mode, `propose` returns an offer and the agent calls `keep` at once. Nothing holds an offer until the end of a task. A session in no domain hears only about stated preferences (`GLOBAL`, `uncoveredNote`, `instructions.mjs:56-75`). Project sessions are told nothing about pages.
- **What `propose` knows about its caller.** The server passes `propose` only the session id (`tools/mcp/tools.mjs:5`), and `propose.mjs:56` refuses a second argument. `keep` and `proposals` also get the call id. The call record holds `subagent` (`calls.mjs:37`), but `propose` can't reach it.
- **`page` on `propose`.** The field exists: it names a page of the user's own (`author: user`) as the evidence for `basis: stated` (`propose.mjs:23`).
- **Pages and rules from agent sessions.** The edit hook refuses only a new rule note written from outside the vault folder (`newRuleGuard`, `pre-tool.mjs:34`), and exempts vault-folder sessions entirely (`pre-tool.mjs:37`). A project session can write or rewrite any page. `AGENTS.md` (File back) tells it to do so from any session. `/lint` step 5 changes a rule's Do, Not or Because by hand "once the user says yes" (`.claude/skills/lint/SKILL.md:35`), and step 2 sets `superseded_by` by hand. In `acceptEdits` mode no prompt shows for those edits.
- **Offers that are never kept.** `makeOffer` deletes every offer older than 7 days, from any session, each time it makes a new one (`offers.mjs:46`). A skipped offer leaves no trace.
- **A Deny.** When the user denies a `keep`, `keep` never runs, so the offer stays `pending` (`keep.mjs:62`). The call record keeps `allowed: null` (`calls.mjs:38`), which `declined()` reads (`offers.mjs:73`), but `pruneCalls` deletes call records after 2 days (`calls.mjs:75`).
- **Held offers and codes.** `codeConsent` refuses a keep once the user has sent more than one message since the offer was made (`offers.mjs:85`). The count, `typed`, is taken when the offer is made (`offers.mjs:42`). An offer made mid-task and shown in the final reply would be refused on a client that uses codes. `typedFor` parses the whole transcript (`agents.mjs:46-48`).
- **Modes.** `propose` makes no offer in `corrections` mode or in the vault folder; it writes at once (`propose-rule.mjs:271`). In `off` it refuses without `asked` (`propose-rule.mjs:278`). `status.mjs:8` and `reference/delivery.md` name `corrections` as the vault folder's mode.
- **Versions.** A note whose `requires` the project's lockfile rules out is not delivered there (`rules.mjs:429-430`). This is a delivery-time filter: nothing is stored and nothing is retired. `propose` refuses `requires` (`propose-rule.mjs:330`), so no rule proposed in a session carries a version. Readers come only from `domains.<d>.readers` (`versions.mjs:54-57`), and `projectVersions` reads only at the roots of the session's domain hits (`versions.mjs:157-170`). `vault.config.json` has `domains: {}`, so today no project's versions are read at all.
- **Locks.** `withLock` treats a live holder's lock as stale after `staleMs`, 30 s by default (`vault.mjs:511`).
- **Commits.** No tool commits. `.githooks/pre-commit` rebuilds the generated files, stages them when every note, pick, queue entry and the config they are built from is wholly in the commit and otherwise keeps them out of it, runs lint over the whole vault with `--fail-on error`, runs the tests when code changes, and refuses rewrites in `raw/`. `.githooks/post-commit` makes `.live/<tree>/`, the copy of `tools/` as of the new commit, when that commit changed `tools/`, and points `.live/current` at it (`hooks/live.mjs`, `make`). `core.hooksPath` is `.githooks`. `CODING_STANDARDS.md` allows a hook no child process except the one `git status` in `changedFiles`, and only `lib/git.mjs` in `tools/` runs a program. `mcp/launch.mjs`, at the repo root, is the sanctioned process starter for the tool server, used by both clients (`adapters/codex/adapter.mjs:143`).
- **Remote.** `origin` is `github.com/osabased/obsidian-vault`, the plugin's own upstream, a private repository (`gh repo view`). The user pushes `main` from the vault folder often: 12 pushes between 2026-10-31 and 11-03 (`git reflog show origin/main`). Its history was cleared of the author's notes once, at `4fe83bc`.
- **Shell writes to the vault.** The Stop hook's `shellWritten` skips the vault's own paths (`stop.mjs:23`, `vaultOwn`), so nothing records which vault files an agent's shell command wrote.
- **`lint --fix`.** `lint fix()` rewrites notes without waiting for them to settle (`lint.mjs:167-184`). Session start runs `build`, not `lint --fix` (`start.mjs:81-86`).
- **Stop.** The Stop hook fires at the end of every turn. It can't tell the final turn of a task from a turn in the middle. Both adapters declare `stopContext` (`adapters/claude-code/adapter.mjs:7`, `adapters/codex/adapter.mjs:11`).

## 3. Design

### 3.1 Capture in project sessions (A1 to A4)

**Taste, at once (A1).** No change. A correction or a stated preference is offered when it happens, through `propose` and `keep`.

**Gotchas and page changes, held (A2).** A gotcha is a knowledge rule: something that worked only after a failure, or a fact a dated source shows. A gotcha rule and a page change are offered as **held offers**:

1. When the agent learns a gotcha, it calls `propose` with `hold: true`. `propose` runs every check it runs today, including the quote check against this session's transcript. It stores the offer in `.state/offers/` with `state: 'held'`. Its reply tells the agent not to show the offer yet.
2. A page change is held in the same way: `propose` with `page`, `text` and `hold: true` (§3.2).
3. When the task is done, the agent calls `propose` with `release: true` and nothing else. It returns every held offer of the session, each with its lines. Release sets each offer's `typed` to the current count of typed messages, stamps `released_at`, and sets its state to `pending`.
4. Where the client prompts before a tool runs, the agent calls `keep` once per offer before it writes its final reply. Each call is one prompt with that offer's lines: Allow once keeps it, Deny ends it. The final reply then says what was kept.
5. Where the client has no tool prompt, the agent ends its final reply with all the lines, each offer ending with its own code. The user types the codes of the offers they keep, in one message, and the agent calls `keep` for each on that message. Each `keep` passes `codeConsent` as it is today, because release set `typed` (§2, Held offers and codes).

The agent decides when the task ends. The start note tells it: "when the task is done, before your final reply". **Option B**, not chosen: the Stop hook continues a turn once when held offers exist. It can't tell a final turn from a mid-task turn, so it would interrupt work in progress, and `stop_hook_active` isn't consulted (`adapter.mjs:109`). A missed release costs nothing: the sweep in §3.3 queues the held offers. So no client needs a Stop hook for this.

**Compaction.** Held offers are stored, so they survive compaction, but the agent's memory of them doesn't. When the start hook runs on `compact` or `clear` and the session holds offers, the start note says so and tells the agent to release them before its final reply (copy in §7.2).

**Modes.** Held offers follow the domain's `proposals` mode:
- `ask`: as above.
- `corrections`: the user's click on the mode is their consent to rules written at once (§3.4). `hold: true` holds the rule; release writes the held rules and returns their lines for the final reply, as `corrections` does today. Page changes are not rules, so release returns them as offers that need `keep` (A3).
- `off`: the agent proposes only what the user asks to keep. `hold` changes nothing about the `asked` check, so a gotcha isn't captured unless the user asks. Page offers take the same `asked` check.
- The vault folder: offers as in `ask`, whatever the mode, and without the `off` gate, since `/ingest` and `/lint` go through each item with the user (§3.4).

**Projects in no domain.** The same applies. Gotcha rules go to `global` with `applies_to` globs, which `reference/notes.md` reads from the file's project root. `uncoveredNote` gains the knowledge and page sentences that `WHEN` gives domain sessions (approved copy in §7.1).

**Consent (A3).** Every rule and every page change from a project session goes through an offer and `keep`. The edit hook refuses a Write or Edit of any note under `wiki/` from a session registered outside the vault folder. This widens `newRuleGuard`, and the refusal points to `propose` with `page` and `text` (§3.2). `vaultGuard` and `userNoteGuard` still run first, so a page offer can't rewrite a page with `author: user` outside its `## Agent notes`. `keep` checks this again before it writes.

On 2026-11-24 the user reversed A3 for pages: "Make open pages default because there's too much human intervention that is needed right now." A project session now writes pages directly, new ones included, and only a page the user closed with `open: false` goes through an offer (`open` in `reference/notes.md`). Rules still go through `propose` and `keep`.

**Subagents and unattended runs (A4).** The server passes `propose` the call id as well as the session id, as it does for `keep` (`tools/mcp/tools.mjs`), and `propose.mjs` reads the call record. When the record carries `subagent`, `propose` writes a queue row with `unattended: 'subagent'`, makes no offer, and returns "queued for the user's review". A run with no user, such as `claude -p` or a session the user left, is caught by the sweep (§3.3). An adapter that can tell a non-interactive run at session start can export `unattended(env, input)`, and that run's `propose` then queues at once. Whether Claude Code exposes this is *(unverified)*. The sweep catches such a run either way.

**A resumed session.** A session resumed after the sweep finds its offers already `queued`. `keep` on a queued offer refuses with the entry's id, and the agent proposes again with `queued` (§3.3).

### 3.2 Pages (A3, A5 to A8)

**Page offers.** These extend `propose` and `keep`. There is no new tool.

- `propose` with `page` **and** `text` is a page change: `page` is the vault path of a page under `wiki/`, and `text` is the page's whole new content. `page` without `text` keeps its meaning today, a user's page cited for `basis: stated`. Telling them apart by `text` keeps the approved copy in §7.1.
- For a page change, `propose` checks the page's frontmatter and links as lint does. It refuses `author: user` pages except for lines added under `## Agent notes`. It stores `fields: { page, text, base }`, where `base` is the SHA-256 of the file as it stands, or null for a new page. The offer's lines are the page path, `new` or `change`, and a unified diff, or the whole text for a new page. Those lines are what the prompt shows, so they are never cut: `propose` refuses a page change whose lines exceed `pages.maxOfferChars`, and the agent splits it into smaller changes.
- `keep` gains `kind: 'page'`. It refuses when the file's hash is no longer `base`, so a page that changed since the offer is offered again. It writes with `writeSettled`, adds the `log.md` line that the `log` tool would add, and rebuilds `index.md`. It commits nothing (§3.8).
- **Option B**, not chosen: a separate `page` tool. Each tool's description and schema join every session's context, and `test/context-load.test.mjs` caps the tool list at 12,000 characters. One field and two help lines on `propose` cost less than a new tool. If the cap is breached, this comes back to the user (§11.6).

In the vault folder, pages are still written directly. A9 is about rules, and A3 is about project sessions.

**Library entity pages (A5, A7).** One `kind: entity` page per library. The library is named by a new `package` frontmatter field: `{ ecosystem, name }`, written as in OSV, the same shape `requires` uses. Lint warns when two entity pages name one package. The body has fixed sections, so that A7 can be checked:

```markdown
## Versions
- 3.2.1 · seen 2026-11-03 · <project folder name>

## Gotchas
- 2026-11-03 · session 1a2b3c4d · `src/api/client.ts` · error: "<as printed>" · fixed by: <the fix> · [[wiki/global/rules/<slug>|<slug>]]

## Docs read
- <URL or raw/refs/ file> · fetched 2026-11-03

## Agent's reading

## Rules
```

`## Gotchas` lines take the form of a `failure` Evidence line. `## Docs read` lines name a URL or a `raw/refs/` file with a date. Claims elsewhere in the body need footnotes, as on any page. Text that is neither goes under `## Agent's reading`. Lint warns on a `## Gotchas` or `## Docs read` line in another form. `## Versions` lines come from the project's lockfile through the readers (§3.4), the same versions that `.state/versions.json` holds.

**When a page starts (A6).** A gotcha starts as a rule. The agent holds a page offer as well when the gotcha needs background that one line can't hold. That is the agent's judgement, stated in the start note. When `propose` writes a rule with a `package` that already has `pages.entityAfterRules` live rules (3 by default) and no entity page, its reply says so. The agent then holds an entity page offer for its final reply. `/lint` drafts the pages that are still missing into the queue (§3.7).

**Comparisons (A5).** An entity page may give `job`, a short phrase such as the task the library does. When two entity pages in one domain, or in global, share a `job`, and no `kind: synthesis` page names both of them in a new `compares` field, `review.mjs status` lists the pair. `/lint` then drafts the comparison page into the queue. An agent may also hold a comparison page offer when the user picks between two libraries in a session.

**Roll-ups (A8).** A roll-up is the topic page that `reference/notes.md` already defines. `review.mjs status` lists the topics with `pages.rollupAfterRules` live rules (3 by default) that have no topic page, or whose topic page doesn't link all of them under `## Rules`. `/lint` drafts the page or the missing links into the queue.

### 3.3 The review queue (A4, A8, A13)

**Where.** `raw/queue/<date>-<session>.jsonl`, one file per session, named as inbox files are named. `raw/` is append-only and git-tracked, and `raw/inbox/` already holds the agent's proposals. A row is never edited. A decision is a later row that names the entry, as a pick's `replaces` does. `node tools/build.mjs` writes a generated `queue.md` of the open entries, for reading in Obsidian. The edit hook protects it as it protects `index.md`.

Options considered:
- **A, chosen.** `raw/queue/` rows plus a generated `queue.md`. The queue is tracked, keeps its history, and reads in Obsidian.
- **B.** `.state/queue/`. It is gitignored and "belongs to the hooks". The queue would be lost with `.state/`, and the user couldn't commit it.
- **C.** A hand-editable `queue.md`. Rows could no longer be checked, and an edit could approve an entry without a click.

**Entry row.**

```json
{"id":"u-9f8e7d6c","at":"2026-11-03T10:00:00.000Z","kind":"rule","why":"ignored","unattended":"left",
 "from":"o-9f8e7d6c","session":"…","agent":"…","transcript":"…","cwd":"…","domain":"global","key":"global/zod-refine-async",
 "fields":{…},"text":"<the offer's lines without a code>","quote":"<the words the quote check passed>","checked":"2026-11-03"}
```

- `id`: `u-` and the offer's own hex when the entry comes from an offer, so the same offer can't make two entries.
- `kind`: `rule`, `evidence`, `page`, `reword`, `retire`, `domain` or `move`.
- `why`:
  - `unreleased`: a held offer the agent never released, so the user never saw it;
  - `skipped`: the user sent a message after the offer was shown that held no code for it, or no Allow;
  - `ignored`: the offer was shown and nothing came after it;
  - `unattended`: a subagent or a non-interactive run made it;
  - `drafted`: `/lint` wrote it.
- `unattended`: null, `subagent`, `headless` or `left`. `left` marks an offer after which the user typed nothing at all, the "run left alone" of A4. The walk in §3.7 shows the mark first.
- `quote` and `checked`: the words that passed the quote check when the entry was made. This is the precedent of inbox rows: lint checks a quote whose transcript is gone against its row, and it checks queue rows the same way.

**Decision row.** `{"id":"d-…","at":"…","decides":"u-…","decision":"kept|dropped|later","offer":"o-…","session":"…"}`. An entry is open until a `kept` or `dropped` row names it. A `later` row keeps it open and records that the user has seen it.

**Deny (§11.3).** A Deny is the user's no, so it doesn't queue. This keeps today's rule that "a Deny ends a proposal" (`delivery.md`). The prompt hook marks a `pending` offer `denied` once its `keep` call was recorded and never allowed, as `declined()` reads it (`offers.mjs:73`). It does this on the user's next message, well before `pruneCalls` deletes the record. The sweep skips `denied` offers, and the purge deletes them.

**Sweep.** `lib/queue.mjs` `sweep()` runs at session start, under the hook's deadline and under `offers.lock`. It reads `.state/offers/` and the session registry, and no transcript. For each offer of another session that is still `held` or `pending`, from a session whose `last_seen` is older than `queue.sweepAfterHours` (12 by default):
- `held`: `why: unreleased`.
- `pending`, with `last_prompt` later than `released_at` (or the offer's `at`): the user wrote after seeing it, so `why: skipped`.
- `pending` otherwise: `why: ignored`, `unattended: left`.
- `mode` offers have no queue kind; they are left to the purge.

It appends the entry unless one with its id exists, then marks the offer `queued`. `last_seen` is set by session start and by every prompt (`touchSession`, `start.mjs:100`, `prompt.mjs:43`), so a resume would make an ignored offer look skipped. The prompt hook therefore also stamps `last_prompt`, which only a typed message sets. Neither needs a transcript.

The 7-day purge in `makeOffer` deletes only offers that are `kept`, `used`, `superseded`, `denied` or `queued`, and `mode` offers. A held or pending offer is swept before it can expire.

**Existing offers.** Offers made before this change carry no `released_at`. The first sweep treats them by their `at`, as any pending offer. *(At the time of review, `.state/offers/` held three offers, one `pending`.)*

**Keep from the queue.** `propose` takes `queued: "u-…"`. It loads the entry's fields, runs every check again, and accepts the entry's `quote` as `basis: pick` accepts a pick row's words. It checks the quote against the transcript when it still exists, and against the row when it is gone. It returns a fresh offer, and `keep` then writes it and appends the `kept` decision row. An entry backs one note, as a pick row does.

**`tools/queue.mjs`.** This is a command-line script, not an MCP tool, so it adds nothing to every session's tool list. `/lint` runs it from the vault folder.
- `list` prints the open entries, oldest first, unattended ones marked.
- `show <id>` prints one entry.
- `draft < row.json` appends a `drafted` entry. It refuses fields `propose` would refuse, and it refuses the bases backed by the user's typed words (`stated`, `inferred`), so a draft can't plant words as the user's. Drafts carry `reading`, `source`, `failure` or a page.
- `later <id>` and `drop <id>` append decision rows, each naming the session that wrote it.

None of these writes a note, so none needs consent. A shell in any session can run `later` or `drop`. Like any raw shell write, the vault guards against mistakes there, not deliberate workarounds (`AGENTS.md`, Limits of consent). `review.mjs status` lists drops with the session that made them.

### 3.4 Rules: consent and retirement (A9, A10)

**Every change is an offer (A9).** A new rule, new evidence through `repeats`, a change to a rule's text or scope, a move to another domain, and a retirement are all offers that `keep` writes. In the vault folder, `propose` returns an offer as in `ask`, instead of writing as in `corrections` (§11.4). `/ingest` step 5 and the `/lint` walk then keep each rule at the prompt.

**Changes to an existing rule.** `propose` takes `key`, naming the rule, and `change`: `reword`, `retire` or `move`. `key` without `change` keeps today's meaning, and `change` without `key` is refused.

**Rewording.** With `change: 'reword'`, the new `do`, `not`, `because`, `applies_to` or `keywords` replace the old. `keep` with `kind: 'reword'` writes them and adds an Evidence line naming the offer. Its lines show the old and new text.

**The rule guard.** The edit hook refuses, from any agent session, the vault folder included, a Write or Edit that changes a rule note's frontmatter or its Do, Not or Because. Lines added under `## Evidence` and `## You said` stay allowed, as do the user's own edits in Obsidian, which no hook sees. The refusal points to `propose` with `key`. This holds in `acceptEdits` mode too, since the hook runs before the permission check. `lint --fix` writes through `rewriteText`, not the edit tool, so it isn't refused. `/lint` step 2's `superseded_by` becomes a `retire` offer that names the rule superseding it.

`corrections` mode stays a choice the user makes for project sessions through `proposals`, which needs their click. A click on the mode is the user's consent to writing at once in that mode. A9 is about what the agent does on its own.

`lint --fix` at session start may rewrite a link's spelling inside a rule note. A rule's hash covers only its delivered text (`CODING_STANDARDS.md`, State), and `rewriteText` keeps the file's saved day. This is not a change to the rule (§11.10).

**Retirement.** `keep` gains `kind: 'retire'`. It writes `retired: YYYY-MM-DD`, `retired_because: <one line>`, and `superseded_by` when one rule replaces another, into the note's frontmatter. The hooks skip a retired note as they skip `superseded_by`. `index.md` lists it as retired, and its links keep working. Deleting the note, which `reference/notes.md` already allows, stays the user's own act in Obsidian (§11.11).

**Moves.** `keep` with `kind: 'move'` moves a note to another domain. The key changes from `<old>/<slug>` to `<new>/<slug>`, so the move also rewrites the wiki links that name the note, as `lint --fix` does, and writes `moved_from: <old key>`. Inbox rows, shown-markers and Evidence lines that name the old key resolve through `moved_from`. `propose` refuses a move to a domain that doesn't exist yet, so the walk keeps the domain offer before its moves.

**Version flag (A10).** Where the flag is set is the open point between A10 and A12. A12 keeps session start cheap and mechanical. A10 makes a flagged rule stop reaching newer projects. The answer: the flag is not stored anywhere. It is worked out at delivery for each project, as `requires` is today (`rules.mjs:429`).

- A knowledge rule records the library it is about and the version it was checked with. `propose` takes `package` (`ecosystem/name`). It fills a new frontmatter field, `checked_with: '<version>'`, from the project's lockfile through the readers, as `fitOf` reads them. When no reader reads the package, the offer's lines say `version unknown`, and the rule is never flagged. No readers exist today (no `tools/ext/`, `domains: {}`), so every rule kept now lacks `checked_with`. `review.mjs status` lists knowledge rules with a `package` and no `checked_with` once readers are set, and `/lint` drafts a `reword` for each, filling the version from the projects where the rule was shown. The user confirms the version when keeping it.
- At delivery, a rule with `checked_with` is a mismatch in a project whose version has **moved on** under `knowledge.movedOn`. It isn't delivered there, through the same branch as `requires`. It is still delivered in projects on the old version, and in projects whose version is unknown, where it is labelled as today. A `requires` the user wrote by hand wins over `checked_with`.
- A project whose lockfile a reader read, and which lacks the package, is a mismatch, as it is for `requires` (`versions.mjs:182`). The rule is about a library that project doesn't use.
- "Moved on" under `major`: a newer major version, or a newer minor below 1.0, SemVer's breaking line (§11.1). It applies to readers on the SemVer scheme. A reader on the `ECOSYSTEM` scheme (`versions.mjs:167`) may export `movedOn(a, b)`; one that doesn't gives `unknown`, and its rules are never flagged.
- **Readers for every project.** Global reaches every project, so `projectVersions` reads `global`'s readers at each session's root. A session in no domain has no hit today, so it gets a root: the nearest folder above its `cwd` that holds `.git`, found with `fs`, or the `cwd` itself. Which readers run for `global` is set in `vault.config.json` under `domains.global.readers`, as for any domain. None are set today, so until the user names some, every version is `unknown` and A10 flags nothing. `review.mjs status` says so while it holds.
- Session start counts, in the status line, the rules whose version has moved on in the session's own projects (§3.6). A project that lacks the package is a mismatch but isn't counted, since a retirement wouldn't fit it. `/lint` lists every rule whose version has moved on in any project in `.state/versions.json`, naming the project each version was read in, and drafts a `retire` entry for each (§3.7). Retirement waits for the user's click. Neither counts nor lists a rule whose `retire` entry is open in the review queue, which the queue count already shows, or was dropped, which kept the rule (§11.28).
- New evidence through `repeats`, from a session on the newer version, moves `checked_with` up, as it moves `as_of`. It is a change to the rule, so it is an offer too.

**Option B**, not chosen: `propose` writes OSV `requires` with an upper bound. That puts the "moved on" policy into each note, so changing the policy means rewriting notes, and a user's `requires` can't be told from the agent's.

### 3.5 Domains (A11)

Agents offer a domain as they do today. In addition, `review.mjs status` gains a section, "Global rules that keep matching one kind of project":

1. For each `global` rule with `applies_to`, take the registered sessions that were shown it (`trackedSessions` keys and `cwd`), and their project roots (§3.4, Readers for every project).
2. Find the file names present at the root of every one of those projects and missing from at least one other registered project root. These are the candidate markers. No name is built in.
3. List the candidates with at least `domains.suggestAfterProjects` projects (2 by default), with the rules that share them.

`/lint` turns each candidate into a `domain` entry, with a name and title the agent proposes and the marker found. It adds one `move` entry per rule. The domain offer and each move are kept one at a time (A9), the domain first.

### 3.6 What session start reports (A12)

The start hook, under the existing 10-second deadline and `checkDeadline()`:
- runs `sweep()` (§3.3);
- adds to the status line what waits for the user: the open review-queue entries and how many are unattended, the rules past their version in this session's projects (§3.4), and "no version readers set" when no domain names readers and a rule that reaches the session names a package.

The status line is the user's, not the agent's. These counts cost no context and no model time. A12's "named in the start line" lands there (§11.14). The agent's context gets nothing new.

Session start fixes only what it fixed before, the generated files through `build`. It runs no `lint --fix` and commits nothing (§11.27). Everything about content waits for `/lint`: stale pages, contradictions, drafts and retirements.

### 3.7 `/lint` (A13)

The skill keeps its steps 1 to 3 (refresh, status, `lint --fix`). Step 4, reading the wiki, keeps its findings. Steps 5 and 6 change, and the hand edits to rules in steps 2 and 5 become offers:

5. **Draft.** For each finding that needs the user, append a `drafted` entry with `node tools/queue.mjs draft`:
   - page updates from sources that changed ("Notes a changed source has left unverified", "newer source" pairs);
   - entity pages for packages with enough rules and no page;
   - comparisons;
   - roll-ups;
   - domain suggestions and their moves;
   - retirements of version-flagged rules, and of rules a changed source no longer backs;
   - rewordings (`kind: 'reword'`) for "corrected again", "never shown" and contradictions.

   Page drafts carry the page's whole new text and its `base` hash. Mechanical fixes are made, not drafted.
6. **Walk the queue.** Take the entries from `queue.mjs list`, oldest first, a domain before its moves, one at a time:
   - Show the entry, its `why`, and its unattended mark first.
   - Make its offer with `propose` and `queued`. Then call `keep`: Allow once keeps it.
   - On a Deny, ask one question: Later, Drop, or Change. Record Later and Drop with `queue.mjs`. Change revises the text, and the agent offers it again.
   - The user can stop at any entry, and the rest stay open.
7. **End.** Run `lint --fix` again, then `review.mjs done`. The user commits (§3.8).

On a client without tool prompts, the walk asks in text, and the user types the entry's code, or Later or Drop.

The walk is one click for each entry kept, and two for the rest (§11.13). **Option B**, not chosen: ask Keep, Change, Later or Drop first, then the `keep` prompt. That is two clicks for every entry kept, and keeping is the common case.

### 3.8 Commits (A14)

**Dropped on 2026-11-05 (§11.27).** No tool commits. `keep`, `/lint`, `log`, `pick` and session start write files and leave them uncommitted; the user commits the vault as today, and `.githooks/pre-commit` checks each commit. A14 and A12's "commit it" are not built.

They waited for option A of `docs/design-code-data-split.md`, since the vault folder is the checkout of the plugin's upstream (`origin`, `github.com/osabased/obsidian-vault`, private), and one automatic commit on `main` would make every later push of `main` carry data (§11.17). The split was then dropped, and with it the ledger of who wrote each file, the commit set, user-edit commits, the lint gate and `commitPaths`. Their design is at `bbd7167`.

## 4. The open points, as settled

1. **A10 against A12, the version flag.** No flag is stored, and session start stops nothing. Delivery works out "moved on" for each project from `checked_with` and the lockfile, through the existing `requires` branch. Session start only counts the flagged rules in the status line. `/lint` drafts the retirements, and `keep` retires (§3.4). Flags need readers named under `domains.global.readers` or a domain's `readers`.
2. **End of task.** The agent's own judgement, told in the start note. The agent holds offers, then releases them before its final reply, and is reminded after compaction. Stop isn't used, because it can't tell the last turn. A missed release is caught by the sweep as `unreleased`, so a client without Stop loses nothing (§3.1).
3. **The queue.** `raw/queue/<date>-<session>.jsonl` entry rows and decision rows, with a generated `queue.md`. Unattended entries carry `unattended: subagent | headless | left` (§3.3).
4. **Page offers.** `propose` with `page` and `text`. `keep` with `kind: 'page'`, a `base` hash, and the prompt showing a diff. The edit hook refuses wiki writes from project sessions, and rule-text writes from every agent session (§3.2, §3.4).
5. **Session-start commits.** Dropped with the code/data split (§11.27). Session start counts what waits in the status line, and fixes and commits nothing beyond `build` (§3.6, §3.8).

## 5. Files that change

| File | Change |
|---|---|
| `tools/lib/instructions.mjs` | `WHEN` splits: taste offered at once, knowledge and pages held and released before the final reply. `uncoveredNote` gains the knowledge and page sentences. The vault-folder note says rules are offered. The compaction reminder. Copy in §7. |
| `tools/mcp/tools.mjs` | `propose` gets `(sid, call)`, as `keep` does. |
| `tools/propose.mjs`, `tools/lib/propose-rule.mjs` | Accept the call id and read the call record. Fields `hold`, `release`, `text` (a page change with `page`), `package`, `queued`, and `change` (`reword`, `retire`, `move`) with `key`. A page change over `pages.maxOfferChars` is refused. A subagent's call queues. `checked_with` is filled from the lockfile. The entity-page hint. The vault folder offers instead of writing, without the `off` gate. `hold` and `release` in each mode. |
| `tools/keep.mjs` | Kinds `page`, `reword`, `retire`, `move`. The `base` hash check. A queued offer refused with its entry id. Appends the `kept` decision row. |
| `tools/lib/offers.mjs` | `held`, `denied` and `queued` states. Release resets `typed` and stamps `released_at`. The purge spares held and pending offers. |
| `tools/lib/calls.mjs`, `tools/lib/handlers/prompt.mjs`, `tools/lib/sessions.mjs` | Mark a denied offer `denied` from its call record on the next prompt. Stamp `last_prompt` on each typed message. |
| `tools/lib/queue.mjs` (new), `tools/queue.mjs` (new) | Entry and decision rows, open entries, `sweep()` under `offers.lock`. The command line: `list`, `show`, `draft`, `later`, `drop`. |
| `tools/lib/handlers/pre-tool.mjs` | `newRuleGuard` becomes a wiki guard: any note under `wiki/` from a session outside the vault folder is refused and pointed to `propose`. A rule guard for every agent session: rule frontmatter and Do, Not, Because. `queue.md` joins the generated files. |
| `tools/lib/rules.mjs`, `tools/lib/versions.mjs` | `checked_with` against the project's version under `knowledge.movedOn`. An optional `movedOn` export for `ECOSYSTEM` readers. A root for sessions in no domain. `retired` notes skipped. `moved_from` resolves old keys. |
| `tools/lib/lint.mjs` | Shapes of `package`, `checked_with`, `retired`, `moved_from`, `job` and `compares`. One entity page per package. `## Gotchas` and `## Docs read` line forms. Queue rows and their quotes. |
| `tools/review.mjs` | Sections: open queue, drops and who made them, version-flagged rules, no readers set, domain candidates, entity-page candidates, comparison candidates, roll-up candidates. |
| `tools/lib/handlers/start.mjs`, `tools/lib/status.mjs` | `sweep()`. The queue and version counts in the status line, and "no version readers set". The compaction reminder. The vault folder's mode is no longer `corrections` (`status.mjs:10`). |
| `tools/lib/build.mjs` | Writes `queue.md`. Marks retired notes in `index.md`. |
| `.githooks/pre-commit` | Adds `queue.md` to the files it rebuilds and stages. |
| `vault.config.json` defaults (in `config()`) | `queue.sweepAfterHours` 12, `pages.entityAfterRules` 3, `pages.rollupAfterRules` 3, `pages.maxOfferChars`, `knowledge.movedOn` `major`, `domains.suggestAfterProjects` 2. |
| `.claude/skills/lint/SKILL.md`, `.claude/skills/ingest/SKILL.md`, `.claude/skills/vault/SKILL.md` | The draft and walk steps; steps 2 and 5 offer instead of editing rules. `/ingest` keeps rules through `keep`. The vault folder no longer writes as in `corrections`. |
| `AGENTS.md`, `reference/delivery.md`, `reference/notes.md`, `tools/CODING_STANDARDS.md` | Held offers, page offers, rewording, the queue, `checked_with`, `retired`, `moved_from`, entity page sections. File back from a project session becomes a page offer. The vault folder's mode (`delivery.md`). The hooks' Never list gains the rule guard. |

## 6. Checks that go red first

All of these build on `test/fixture.mjs` and run with `node --test test/*.test.mjs`. Passing means every one is green. Each line says what fails today.

1. `page-guard.test.mjs`: a Write to `wiki/global/entities/x.md` from a session registered in a project is refused. Today it goes through, and the test at `page-guard.test.mjs:131-134` asserts that; it is rewritten.
2. `page-guard.test.mjs`: from a vault-folder session, a Write that changes a rule's Do line is refused, and one that adds an `## Evidence` line is allowed. Today both go through.
3. `keep.test.mjs`: `propose` with `page` and `text` returns an offer, and `keep` writes the page and a log line. Today `propose` refuses: "page is only for basis stated". `stated` with `page` and `quote` still works. A `keep` of a page whose hash changed since the offer is refused.
4. `keep.test.mjs`: on a code client, an offer held, three typed messages, `release`, then one message with the code is kept. Today `codeConsent` refuses it ("more than one message").
5. `keep.test.mjs`: a `change: 'reword'` offer, once kept, changes the rule's Do line, and `change` without `key` is refused. A page change longer than `pages.maxOfferChars` is refused, not cut. Today `change` is an unknown field.
6. `queue.test.mjs` (new):
   - (a) a pending offer of a session quiet past `sweepAfterHours` becomes an entry row with the right `why` and `unattended`, without reading a transcript;
   - (b) a held offer becomes `why: unreleased`;
   - (c) an offer whose `keep` was denied is not queued, and the purge deletes it;
   - (d) two sweeps at once write one row;
   - (e) an 8-day-old pending offer is queued, not deleted;
   - (f) a session resumed after the offer, with no typed message since, gives `why: ignored`, not `skipped`;
   - (g) added on 2026-11-25: an offer on a rule since retired or deleted is marked `moot`, not queued, and one on a rule present but not delivered is queued, judged by every domain's notes whatever the sweeping session reads.

   Today nothing is queued, and the offer is deleted.
7. `mcp.test.mjs`: `propose` through the server, from a call whose record has `subagent`, writes a queue row and no offer. Today `propose` gets no call id and returns an offer.
8. `queue.test.mjs`: `queue.mjs draft` refuses a row with `basis: stated`. Today there is no `queue.mjs`.
9. `versions.test.mjs`: a rule with `package` and `checked_with: '1.4.0'` is delivered at 1.9.0, not delivered at 2.0.0 under `major`, and delivered labelled `version unknown` where no reader reads it. A session in no domain, with `domains.global.readers` set, reads its root's lockfile. Today `propose` refuses `package`, delivery ignores `checked_with`, and an uncovered session reads nothing.
10. `keep.test.mjs`: a `retire` offer, once kept, writes `retired`, the note stops being delivered, and `index.md` marks it. A `move` rewrites links and writes `moved_from`. Today both are unknown kinds.
11. `proposals.test.mjs`: in the vault folder, `propose` returns an offer, also under `off`. Today it writes.
12. `start.test.mjs` or `status.test.mjs`: after `compact`, a session with held offers gets the reminder. Today it doesn't.
13. Dropped with commits (§11.27). It was `upkeep.test.mjs` (new), in scratch git repositories with no git hooks, as the data repository has none:
    - (a) a user-edited page plus a tool-written `log.md` give two commits, the user's first with `Vault-Change: user`;
    - (b) a page an agent wrote through the Write tool is committed as the agent's;
    - (c) a vault file a shell command wrote during a vault-folder turn is committed as `Vault-Change: unattributed`, not as the user's;
    - (d) with `.git/index.lock` present, nothing is committed and `upkeep.json` says why;
    - (e) with a file staged, nothing is committed;
    - (f) with a note that has a lint error, or a rewritten `raw/` file, the lint gate refuses, the files stay changed, and the refusal is recorded;
    - (g) after a commit, `git diff --cached --quiet` passes;
    - (h) a note changed within `delivery.settleSeconds` is not rewritten by `lint --fix`.

    Today there is no `upkeep.mjs`, and `lint fix()` rewrites unsettled notes.
14. Dropped with the async hook (§11.27). It was `plugin.test.mjs`: `hooks/hooks.json` holds the async `startup` entry, and the claude-code adapter declares it.
15. `status.test.mjs` and `versions.test.mjs`: the status line names the open queue count and the unattended count, which a `later` decision leaves open, in a project and in the vault folder, and skips a queue line that holds no row; the rules past their version in the session's projects, leaving out a rule with `requires`, a retired rule, a project without the package, and a rule whose `retire` entry is open or dropped; and "no version readers set" only when a rule that reaches the session names a package, in `package` or in `requires`. `review.mjs status` leaves out the same rules and names the project each version was read in, not a project below it. Today the line ends at the proposals mode. `test/perf/latency.perf.mjs`: a start with 2,000 open queue entries takes under 500 ms, and a start that sweeps 500 offers into the queue stays within the start hook's 9-second deadline.
16. `status.test.mjs`: from fixture sessions in three projects sharing one root file, `review.mjs status` lists the domain candidate. Today the section doesn't exist.
17. `wiki.test.mjs`: lint warns on two entity pages with one `package`, and on a `## Gotchas` line in another form.
18. `context-load.test.mjs` is green today and must stay green after the new `propose` fields (§11.6) and the §7 copy. Measured during the panel: tools/list 10,265 of 12,000 characters; with the §7.1 copy, the domain note about 1,563 of 1,600 and the no-domain note about 746 of 850. Little room is left.

The copy in §7 is approved, so its tests can pin the wording.

## 7. Copy

`CODING_STANDARDS.md` keeps the wording of hook messages, tool descriptions, offers and refusals until the user agrees to a change.

### 7.1 Approved on 2026-11-03 (§11.16)

- **Domain sessions, replacing the knowledge half of `WHEN`:** "When something only worked after a failure caused by an API, version or tool your training gets wrong, or a dated source shows it, hold a knowledge rule with the vault's `propose` tool and `hold: true`. Hold a page change the same way when a library needs more than a rule's line. When the task is done, call `propose` with `release: true` and end your final reply with what it returns."
- **`uncoveredNote` addition:** "The same holds for knowledge rules and page changes in this project: hold them as `global` rules with `applies_to` globs, and release them before your final reply."
- **Held reply:** "Held `o-…`; nothing is written yet. Don't show it now. Release it with the others when the task is done."
- **Changed on 2026-11-24, with pages open by default:** the page sentence of the domain note became "Write a vault page directly when a library needs more than a rule's line.", and the `uncoveredNote` addition "The same holds for knowledge rules in this project: hold them as `global` rules with `applies_to` globs, and release them before your final reply. Write a page under wiki/global/ directly."
- **Subagent reply:** "Queued `u-…` for the user's review; nothing is written. Tell your caller what you queued."
- **Wiki guard refusal:** "`<path>` is a vault page. Outside the vault folder, pages change only through the vault's `propose` tool with `page` and `text`, so the user agrees to each change."
- **Status line additions:** "· queue 4 (1 unattended)", "· 2 rules past their version here". "· last commit refused: <first line>" and "· upkeep skipped: <why>" were dropped with commits (§11.27).

The first line says "end your final reply with what it returns". On a client that prompts, the agent calls `keep` first and the reply says what was kept (§3.1). The line stays as approved; the release reply says which applies.

### 7.2 Added in the revisions, approved on 2026-11-03 (§11.26)

- **Compaction reminder:** "You hold N vault offers from before the compaction. Call `propose` with `release: true` before your final reply."
- **Rule guard refusal:** "`<path>` is a rule. Its Do, Not, Because and frontmatter change only through the vault's `propose` tool with `key`, so the user agrees to each change. Add Evidence lines as before."
- **Queued offer refusal (`keep`):** "Offer `o-…` went to the review queue as `u-…`. Propose it again with `queued: \"u-…\"`."
- **Release reply, prompt client:** "Call `keep` for each offer below, then say in your final reply what was kept."
- **Status line additions:** "· no version readers set". "· git index locked for 2 h" was dropped with commits (§11.27).

### 7.3 Added for phase 5, approved on 2026-11-05

- **Status line, one rule past its version:** "· 1 rule past its version here", the singular of the approved "· 2 rules past their version here".

### 7.4 Rule or page, approved on 2026-11-25 (§11.29)

- **Every start note:** "A rule is only for a silent or costly mistake an agent would make at a set moment unless told, and it needs the user's words, a failure or a dated source." Then, outside the vault folder: "Write the rest worth keeping on a vault page directly, and end your final reply with one line naming any vault pages you wrote or changed.", with "on a page under wiki/global/" in a folder no domain reaches. It replaces "Write a vault page directly when a library needs more than a rule's line." and "Write a page under wiki/global/ directly."
- **Knowledge half of the domain note:** "When a failure or a dated source shows an API, version or tool your training gets wrong in a way that would be silent or costly, hold a knowledge rule with the vault's `propose` tool and `hold: true`."
- **`propose` description, prompt client:** "Proposes a vault rule, or evidence for one." then the start note's first sentence, which both share as one constant, then "Under corrections a project session's unheld rule is written at once; else it returns an offer to pass to `keep`, written once the user allows it. Subagents' rules go to the review queue." It leaves out where the rest goes, which the start note and the refusal say, to fit the cap.
- **`propose` description, code client:** the same up to "else it returns", then "an offer to end your reply with, kept once the user's reply has its code. Subagents' rules go to the review queue." The two come to 386 and 399 of the 400-character cap.
- **Refusal of a new rule on `reading` or `inferred`:** "basis reading and inferred are for rewording a rule the vault has. A new rule, or evidence for one, needs the user's words (basis stated or pick), a failure or a dated source. Write what you saw or generalized on a vault page instead."
- **Quote refusals for a new rule** end "write it on a vault page instead" where they said "give your own reading with basis reading instead".
- **Delivered rule line:** ends "More: <page path>".

## 8. Unverified claims the design leans on

- Claude Code shows parallel `keep` calls as separate prompts, one after another. *(unverified)*
- The permission prompt shows the whole `offer` argument, a long page diff included, without cutting it. Page-offer consent depends on it. `pages.maxOfferChars` bounds the risk. *(unverified)*
- Claude Code exposes no field or variable that marks a `claude -p` run to hooks. `initialUserMessage` is a SessionStart output field, not an input marker. *(unverified; the sweep doesn't depend on it)*
- The Deny dialog's text field reaches the agent, so the user can say "later" there. *(unverified; the walk asks the question anyway)*

Settled since the first draft: Codex's hooks don't run through `hooks/launch.mjs`. They run `.live/tools/adapters/codex/launch.mjs`, and its server is `mcp/launch.mjs` (`adapters/codex/adapter.mjs:134`, `:143`).

## 9. Not doing

- No schedule, cron, `/loop` or background agent run. Session start's work is mechanical code. Everything that needs a model waits for a session the user starts (A12).
- No automatic commit, no push and no sync between machines (§11.27).
- No web search on its own. `/lint` lists gaps with their searches, as today.
- No automatic retirement, rewording or move of a rule (A9). Version flags filter delivery only (A10).
- No readers chosen for the user. `domains.global.readers` stays empty until they set it.
- No multi-user attribution beyond "user" and "agent" (one user).
- No change to where the code lives. The split is dropped (§11.27).
- No new consent path. Held offers, page offers, rewordings and queue keeps all go through `keep` as today.

## 10. Recommendation

Extend what exists rather than add parallel paths. Held offers are released before the final reply. Page offers and rule rewordings go through `propose` and `keep`, and the edit hook makes that the only way an agent changes a rule or, from a project, a page. The queue is append-only rows under `raw/queue/`, with a generated `queue.md`, swept without reading transcripts and never fed by a Deny. Version flags are worked out at delivery from a new `checked_with` field, once the user names readers. Session start counts what waits for the user in the status line. Nothing commits on its own; the user commits the vault (§11.27). §12 gives the build order. The `/lint` walk is one `keep` prompt per entry.

## 11. Decisions

The user took every recommended option on 2026-11-03, and then the independent review's fixes the same day. The alternatives are kept here so the reasons can be found later.

1. **"Moved on" for a knowledge rule's version:** a newer major, or a newer minor below 1.0 (`knowledge.movedOn: major`). Not chosen: any newer minor; any newer version.
2. **How a rule records its version:** new `package` and `checked_with` fields that `propose` fills. Not chosen: OSV `requires` with an upper bound in each note.
3. **What a Deny means:** the user's no, dropped as today and marked `denied`. Only skipped, ignored and unreleased offers are queued. Not chosen: a Deny queues too.
4. **Rules in the vault folder:** offered and kept at the prompt like everywhere else (A9), with a rule guard on hand edits. `/ingest` step 5 and `/lint` steps 2 and 5 change to match. Not chosen: vault-folder sessions keep writing as in `corrections`.
5. **`corrections` mode:** kept as the user's opt-in through `proposals`. Not chosen: removed under A9.
6. **Page offers:** extend `propose` and `keep`, told apart from a stated `page` by `text`, as long as `test/context-load.test.mjs` stays green. If it doesn't, this comes back to the user. Not chosen: a new `page` tool.
7. **Where the queue lives:** `raw/queue/` rows plus a generated `queue.md`. Not chosen: `.state/queue/`; a hand-editable `queue.md`.
8. **Where session-start commits run:** an async SessionStart hook with `matcher: "startup"`, and `mcp/launch.mjs` for clients without async hooks. Decided after the review; it replaces a detached spawn from `hooks/launch.mjs`, which can't tell a fresh start from a resume (§3.6, option B). Built with the split (§12). Not chosen: in the hook under the deadline; only from `keep` and `/lint`. Dropped with §11.27.
9. **Branch gate:** dropped with §11.17. The data repository holds no code branches. It was: commit only when HEAD is on `commits.branch`, default `main`.
10. **Link fixes inside rule notes at session start:** not a rule change, since the delivered text is unchanged. Not chosen: limit session-start fixes to pages and generated files.
11. **Retiring a rule:** a `retired` field that keeps the note and its links. Not chosen: deleting the note.
12. **File back from project sessions** (`AGENTS.md`): becomes a page offer under the wiki guard. Not chosen: a direct write.
13. **The `/lint` walk:** the `keep` prompt first, with a question only after a Deny. Not chosen: a question first, then the prompt.
14. **Where session start names what waits (A12's "start line"):** the user's status line, which costs no context. Not chosen: a start line the agent also sees.
15. **Defaults:** sweep after 12 hours quiet; 3 rules for an entity page or a roll-up; 2 projects for a domain suggestion. Upkeep at most every 10 minutes was dropped with §11.27.
16. **The copy in §7.1:** approved as drafted.
17. **Keeping automatic commits off the upstream:** reversed after the panel review. Automatic commits wait for option A of the code/data split and happen only in its data repository. Not chosen: a pre-push guard on `Vault-Change:` commits, which would refuse every push of `main` after the first automatic commit, and whose only way through publishes the data. Dropped with §11.27.
18. **Held rules under `corrections` mode:** held, then written at release without a prompt, since the mode is the user's consent; page changes still need `keep`. Not chosen: offered as in `ask`.
19. **Gotchas under `off` mode:** captured only when the user asks, as `off` means today. Not chosen: held and offered anyway.
20. **A project that lacks a rule's package:** the rule isn't delivered there, as for `requires`. Not chosen: delivered, labelled `version unknown`.
21. **Readers for `global`:** left for the user to name in `domains.global.readers`, with `review.mjs status` saying none are set. Not chosen: default readers in the design, which would put ecosystem names into `tools/`.
22. **Changes to an existing rule:** an explicit `change` field (`reword`, `retire`, `move`) with `key`, so one field doesn't carry three meanings.
23. **Long page offers:** refused above `pages.maxOfferChars`, never cut, so the user approves only what the prompt shows.
24. **Shell writes in the vault folder:** committed as unattributed, since the Stop hook can't tell a shell write from the user's save. Dropped with §11.27.
25. **Unattended fixes:** upkeep's `lint --fix` rewrites settled notes only. Dropped with §11.27.
26. **The copy in §7.2:** approved as drafted.
27. **The code/data split and automatic commits:** dropped on 2026-11-05. The vault is personal, so separating its code from its data isn't worth the split's cost. Without the split, automatic commits would land on the plugin's upstream `main` (§11.17). An independent review then found they add little on their own terms: a note reaches sessions as soon as it is written, committed or not, and an automatic commit in a checkout that concurrent sessions share can take in another session's unfinished work. Phase 5 keeps the status-line counts, which need neither. A12's "commit it" and A14 are not built; the user commits the vault as before. Not chosen: the split with automatic commits in its data repository (§11.8, §11.17); automatic commits on `main` without it.
28. **A dropped retirement:** decided on 2026-11-05. A rule whose `retire` entry is open or dropped leaves the status line's past-version count and `/lint`'s list. While the entry is open, the queue count alone shows it. A drop is final, even if the project later moves on again; the rule still isn't delivered where its version has moved on. Not chosen: leave out only an open entry, so a dropped rule is counted and drafted again at every `/lint`; after a drop, draft a reword that moves `checked_with` up to the project's version.
29. **Rule or page:** decided on 2026-11-25, after agents proposed rules where a page did better. A rule is only for a silent or costly mistake an agent would make at a set moment unless told, and not catch in time. It stands on the user's words (`stated`, `pick`), a failure or a dated source; `propose` refuses a new rule, or `repeats` evidence, on `reading` or `inferred`, and rewords still take both, since `/lint` drafts them. A delivered rule ends with `More:` and one page, a page it is drawn from before its topic's page. A session's final reply names the pages it wrote or changed. Under `off`, rules stop and pages don't. The four `reading` rules move into pages and are retired. Supersedes A6.
30. **Where the user's own settings live:** decided on 2026-11-26, after a push put the user's domain and privacy allow ids in the public repo. Domains, the `proposals` mode and `privacy.allow` go in the untracked `vault.local.json`, which wins over `vault.config.json` object by object; the `domain` and `proposals` tools write only it, and the edit guard on it stays. `vault.config.json` holds the defaults the repo ships. History was left as it was. Not chosen: resetting the tracked file and keeping the user's copy with `git skip-worktree`, which a pull or checkout can overwrite while the tools keep writing to the tracked file; a force-push to scrub the commit, which clones, forks and the old commit's hash on GitHub would still hold.

## 12. Build order

Each phase ships with its checks from §6 green.

1. **Queue and held offers.** `hold`, `release`, the sweep with `last_prompt`, `denied`, the queue files and `queue.mjs`, subagent queueing, the compaction reminder. Checks 4, 6, 7, 8, 12.
2. **Page and rule guards.** Page offers, the wiki guard, the rule guard, `change: reword`, the vault folder offering instead of writing, the `/lint` and `/ingest` skill steps. Checks 1, 2, 3, 5, 11, 17, 18.
3. **Versions, retirement and moves.** `package`, `checked_with`, readers for every project, `retire`, `move`, domain and page candidates in `review.mjs status`. Checks 9, 10, 16.
4. **The code/data split.** Dropped (§11.27).
5. **Status-line counts.** The open queue entries and how many are unattended, the rules past their version in the session's projects, and "no version readers set". Check 15. The async hook, `upkeep.mjs`, the ledger and `commitPaths` were dropped with phase 4 (§11.27).

No phase commits. The user commits the vault as today.
