# Note formats

## Rule notes

```markdown
---
type: rule
domain: example-ui
kind: taste
basis: stated
topic: code
always: false
applies_to:
  - 'src/client/UI/**/*.ts'
  - '!src/client/UI/**/*.test.ts'
triggers: []
keywords:
  - typed props
created: 2026-10-19
updated: 2026-10-19
---

**Do:** Type UI props and handlers with named types.
**Not:** Annotate them as `any`.
**Because:** An `any` hides type errors that would show up while editing.

## Examples

## Evidence
- 2026-10-19 · stated · session 1a2b3c4d · "never let any into the UI code" (a-1a2b3c4d)
```

- `kind`: `taste`, how something should look or feel to a person: visual design, copy, game feel; `practice`, how the agent should work: planning, building, testing, reviewing, answering; or `knowledge`, a fact about an API, version or tool that training gets wrong or doesn't know. The `propose` tool refuses a new rule without one, and a note without one is read as taste. A reword can change a rule's kind, but a knowledge rule keeps its own: to change it, retire the rule and propose it again. Practice rules take the same bases as taste rules and rank against them. All three kinds take the same scope fields: `always`, `applies_to`, `triggers`, `keywords` and `tools`.
- `basis`: `stated` when the user said it, `inferred` when you generalized it from their corrections, `pick` when a recorded answer from an earlier session backs it (a `q-` row in `raw/picks/`), `reading` when your own reading of what you saw backs it. Knowledge rules use `stated`, `failure` (something worked only after a failure) or `source` (a dated source shows it).
- `as_of`: knowledge rules only, the day the fact was last checked, as YYYY-MM-DD: the source's date, or the day it was proposed (the day the offer was made, for one kept later, or the day a review queue entry was checked), moved up when `repeats` adds newer evidence. Delivery shows it, and lint warns once it is more than 180 days old (`knowledge.staleAfterDays` in `vault.config.json`), counting from the last day refresh checked every source the note cites when that is later; a check that found a newer copy counts once the note cites it. A domain sets its own `staleAfterDays` and `checkAfterDays` under `domains.<d>.knowledge`. Taste and practice rules never expire.
- `requires`: optional, knowledge rules and pages only: the package versions the note holds for, as a list shaped like OSV's `affected` entries (https://ossf.github.io/osv-schema/). Each entry has `package` with `ecosystem` and `name`, and `ranges`, each a `type` (`SEMVER` or `ECOSYSTEM`) and `events` such as `introduced: '2.0.0'` and `fixed: '3.0.0'`. Lint checks the shape and the SEMVER versions. A domain's `readers`, extensions in `tools/ext/readers/`, read the versions from a project's lockfile: a note the lockfile rules out isn't delivered there, and one no reader can check is delivered labelled `version unknown`.
- `package` and `checked_with`: optional, knowledge rules only: the library the rule is about, as `package: { ecosystem: npm, name: <name> }`, and the version it was checked with, in quotes. The `propose` tool takes `package` as `ecosystem/name` and fills `checked_with` from the project's lockfile through the domain's readers. When no reader reads the package, or the projects hold different versions of it, the offer says `version unknown` and the note gets no `checked_with`. The rule isn't delivered in a project whose version has moved on from `checked_with` under `knowledge.movedOn` in `vault.config.json`, or that lacks the package. `major`, the only policy so far, means a newer major version, or a newer minor below 1.0. The rule is delivered where the version is the same or older, and labelled `version unknown` where no reader can tell. A `requires` the user wrote wins over `checked_with`. Evidence through `repeats` from a project on a newer version moves `checked_with` up to it, as an offer in every mode, except from a session that gets no offers, one that agrees by code and has no transcript, whose evidence under `corrections` is written with `checked_with` left as it was. The version is read in the folder the session is in now, which after a resume can differ from the one it started in. `/lint` drafts a reword that gives `checked_with` alone for a rule with `package` and neither `checked_with` nor `requires`. It lists for retirement a rule whose version has moved on in any project a reader has read, naming that project, unless a retirement entry for the rule is open in the review queue or the user dropped one, which keeps the rule. Lint reports `checked_with` without `package`, either on a taste or practice rule, and a `checked_with` the domain's reader for its ecosystem can't compare, as errors: it must be a whole semver version, such as `'1.4.0'`, unless that reader compares its own versions. Where no reader reads the ecosystem, nothing compares `checked_with`, so lint doesn't check its form.
- `topic`: a short topic, ideally one the domain's other rules have or `vault.config.json` lists for it. Lint warns on a rule with no topic unless it's superseded. Among delivered rules, it also warns on a topic only one rule in its domain has that the config doesn't list. Global topics aren't checked against the config. `/lint` reports the listed topics no rule has yet. A reword can move a rule to another topic; one that differs only in case or spacing is the same topic.
- `always`: only for short rules that matter in nearly every session. The user sets it in Obsidian; the `propose` tool refuses it. Lint warns on a knowledge rule with `always` longer than the 300 characters a taste or practice rule may have.
- `applies_to`: globs relative to the domain's project root; global's are read from the file's project root, or from the session's folder when no domain has the file. `**` crosses folders, `*` doesn't, `{a,b}` picks one. Matching ignores case and worktree folders.
  - An entry starting with `!` excludes the files it matches. Entries apply in order, as in a `.gitignore`: the last one that matches a file decides. A list with no plain entry matches nothing, and lint reports a `!` entry with nothing before it to exclude from as an error.
  - `'<namespace>:<glob>'` matches names in a namespace other than files, such as objects in a running app. `namespaces` in `vault.config.json` declares each, with its `separator` and `escape` character, and lint reports an undeclared one as an error. The `escape` is one character, not a glob character (`* ? [ ] { } , !`) and not in the `separator`. `file:` is the same as no prefix. Names in a namespace match with case; file globs ignore it.
  - A tool other than Edit, Write, MultiEdit and NotebookEdit edits names once `editTools` in `vault.config.json` maps it, as `{ "<tool>": { "namespace": "<ns>", "path": "tool_input.<field>", "after": "tool_input.<field>" } }`: `path` is the input field holding the name it edits, and `after` the one holding the new text `triggers` test. A name takes the session's domains, since it has no project folder. Lint reports an entry for a file tool, or for a tool the edit hook's matcher never sends it, as an error.
  - A domain's `aliases`, `{ "<ns>": "<name>" }`, maps a name in the namespace to a file through `tools/ext/aliases/<name>.mjs`, in projects that have what it reads. The edit then matches the file's globs too, so one rule can cover both.
- `triggers`: optional regexes tested against the new text of an edit, or against the input of a call `tools` names as JSON text, so `^` anchors at `{` and quotes and newlines in it are escaped. When present, the rule applies only if one matches. A rule a mapped call reaches through both `applies_to` and `tools` applies when either text matches.
- `keywords`: optional words or phrases that bring the rule up from a prompt.
- `tools`: optional, exact tool names, each agent's own, such as `AskUserQuestion` or an MCP tool's full name. Lint checks them against every adapter that `agents` in `vault.config.json` lists (`claude-code` when unset), and reports a name the edit hook's matcher never sends it, such as `Bash`, or one that edits a file, such as `Edit`, as an error: give a rule on files `applies_to` instead. These checks are lint's only; the hooks deliver the rule whatever `agents` lists.
- Every rule needs `always`, `applies_to`, `keywords` or `tools`; lint reports one with none as an error.
- `superseded_by`: optional, the note that replaces this one, as a link or a key like `example-ui/new-slug`. The old note stays in the vault and the index, and the hooks stop delivering it. Deleting a note retires its rule too.
- `retired` and `retired_because`: the day the rule was retired, as YYYY-MM-DD, and why, in one line. The `propose` tool writes them, with `superseded_by` when another rule replaces it, through `change: 'retire'` once the user keeps the offer. A retired note stays in the vault and its links keep working; `index.md` lists it as retired, and the hooks stop delivering it. A `retired` that is no such day doesn't retire the note: lint reports it as an error. Deleting the note is the user's to do in Obsidian.
- `moved_from`: the key the rule had before the `propose` tool moved it to another domain through `change: 'move'`. Evidence lines, inbox rows, shown-markers, links and `repeats` that still name the old key resolve to the moved note through it, and a page can't take the old key. A second move replaces it.
- Single-quote globs and regexes so Obsidian reads them as text and keeps a namespace's backslash escapes.
- Single-quote any list item that holds `: ` or would read as a number, a date, `true`, `false` or `null`, so it stays text. Lint reports an item that holds `: ` or reads as `true` or `false` as the note's error, so the note isn't delivered; an unquoted `null` leaves the list without a report.
- The `propose` tool refuses a field it doesn't take, such as `tools` or `requires`; add those to the note it writes.
- `**Do:**` and `**Not:**` are required, one line each. Pair every "never X" with an "instead Y". `**Because:**` gives the user's reason; leave it empty rather than invent one. Keep the three lines together under 300 characters for a taste or practice rule and 600 for a knowledge rule, counting the "As of" date a knowledge rule is delivered with (`delivery.maxRuleChars` and `delivery.maxKnowledgeRuleChars`). The hooks cut a rule at its cap.
- `## Evidence` has one line per source: date, kind (`stated` or `correction`; `choice` for a pick), the session's short name, the user's exact words, and the proposal id. A `choice` line also names the options the user passed over and the question, and ends with the pick's id and the proposal id. A `failure` line gives the file, the error as a tool printed it and `fixed by:` the fix; a `source` line gives the URL or `raw/refs/` file, `dated` its date, and its exact words. An `agent's reading` line gives your reading in your own words, unquoted. A `stated` line quoting a page with `author: user` gives the page's path where the session goes: `- 2026-10-19 · stated · wiki/example-ui/concepts/grid.md · "the grid is 8px" (a-1a2b3c4d)`.
- Link notes by their path from the vault root, `[[wiki/<domain>/<folder>/<slug>|<slug>]]`.

## Pages

Pages hold knowledge in the agent's words, or with `author: user` the user's own; What belongs here in `AGENTS.md` says what counts. Sessions find them through `index.md`, and the hooks point a session to one whose `keywords` or `applies_to` match its work. Each page has one `kind`:

- **topic** (`topics/`): sums up what the vault knows on one topic: how its rules and pages fit together, the sources behind them, and what's still open. It links each other page on its topic, source pages included. Each topic in a domain has at most one; `/ingest`, `/lint` and a filed-back answer update it, and start it when the topic has none. Once a topic in a domain has `pages.rollupAfterRules` live rules (3 by default, in `vault.config.json`), `node tools/review.mjs status` lists it while it has no topic page or its topic page doesn't link each of them under `## Rules`, and `/lint` drafts the page or the links. Name it after its topic.
- **concept** (`concepts/`): one idea, technique or API, explained.
- **entity** (`entities/`): one named thing, such as a library, tool, service or game.
- **synthesis** (`syntheses/`): an answer or comparison a session worked out from the vault and filed back, so a later session can reuse it.
- **source** (`sources/source-<slug>.md`): one source, what it says, and the user's words about it. `/ingest` writes it.

Check `index.md` that no note has the slug before you start a page.

```markdown
---
type: page
domain: example-ui
kind: source
topic: layout
summary: Shop screens the user liked and what they said about the spacing.
source: raw/refs/shop-screens.png
source_date: 2026-09-30
created: 2026-10-22
updated: 2026-10-22
---

## You said
- 2026-10-22 · session 1a2b3c4d · "the cards breathe, the tabs feel cramped"

## Agent's reading
What the source shows, by topic, in the agent's words.

## Rules
- [[wiki/example-ui/rules/roomy-cards|roomy-cards]]
```

- `kind`: required, one of the five above. `index.md` labels each page with it, as `source page`, `topic page` and so on. Lint warns on a page without one.
- `author`: `agent`, the default, or `user` for the user's own writing, in any kind. On a page with `author: user` you may only add lines under `## Agent notes`, appending that heading at the end when the page has none. The section runs to the next `#` or `##` heading. The lines you add may hold `###` headings but no `#` or `##` one, and may not move where the section ends, as an unclosed code fence would. The edit hook denies any other change to the file, with no retry, and denies adding or removing `author: user`, which only the user sets. Lint asks it for no `topic` or `summary`, and `lint --fix` leaves it as it is. Its text, without the frontmatter and `## Agent notes`, is the user's words: a rule may quote it as `basis: stated`, with `page:` its path and `quote:` the words.
- `open`: optional, `true` or `false`. Lint reports any other value, which closes the page, and `open` on a rule. A page is open unless it says `open: false`. A session outside the vault folder writes an open page directly, with no offer, frontmatter included, and may create a new page in a domain it reaches or `global`, under a key no other note holds. The edit hook checks each such write as a page offer is checked, but for links, which lint reports: it refuses an edit it can't follow, a delete or a move, an edit that leaves the note no page, a page in the wrong folder for its kind, and a note error the page didn't have; the page can't become a rule, a page with `author: user` takes only `## Agent notes` lines and can't be made one, dropping a quoted line is refused every time and pointed to a page offer, and cutting the page below 70% of its length is refused once. Only the user opens or closes a page: in Obsidian, or by keeping a page offer whose text drops `open: false`, whose head line then says it opens the page. The edit hook refuses any session's edit that adds, changes or removes an `open` line, the vault folder's included. A closed page changes from a project session only through a page offer. `index.md` labels a closed page `closed`. What an open page accepts: an agent may change its frontmatter, so it may reach other sessions than before; an agent may add lines under `## You said`; after each write the page leaves delivery until it settles; an offer on the page made before a write goes stale; `wiki/` isn't in git, and the hook keeps no copy of the text a write replaces; and an edit the hook can't follow in the vault folder, or a shell write anywhere, passes unchecked.
- `topic`: the topic the page belongs under in `index.md`, like a rule's. Lint warns on a page with none.
- `summary`: one line on what the page holds, shown in `index.md` and when a hook points to the page. Lint warns on a page with none. Single-quote it if it holds ` #`, which YAML reads as a comment.
- `keywords`: optional, the words or phrases a request on the page's subject would use. A prompt that mentions one brings the page up.
- `applies_to`: optional globs, written as a rule's. An edit to a matching file brings the page up. A vault-only domain's pages reach no edit, so lint warns on one with `applies_to`.
- `triggers`: optional, as a rule's: an edit to a matching file brings the page up only when its new text matches one.
- `always`, `tools` and `requires`: optional, as a rule's. Nothing delivers `always` or `tools` on a page yet.
- `source`: source pages, a URL, a file under `raw/` that exists, or a bundle's folder, written without a trailing slash. Lint warns on a source page with none.
- `source_date`: optional, when the source was published or last updated, as YYYY-MM-DD. Only source pages take `source` and `source_date`; lint warns on another page with either.
- `package`: an entity page about a library names it as OSV does, the shape `requires` uses: `package: { ecosystem: npm, name: <name> }`. Lint warns on one in another shape, and on two pages with one package, since each library has one entity page.
- `job`: optional, entity pages only: a short phrase for the task the library does, such as `parses dates`. `node tools/review.mjs status` lists two entity pages in one domain with one `job` that no synthesis page compares, so `/lint` drafts the comparison.
- `compares`: synthesis pages only: the entity pages the page compares, two or more, by key, as `compares: [global/react, global/vue]`. Lint warns on one that names fewer, or a page that isn't an entity page.
- An entity page may have `## Gotchas` and `## Docs read`, so what it says traces to what happened. A `## Gotchas` line takes a `failure` Evidence line's form, `` - <date> · session <short name> · `<file>` · error: "<as printed>" · fixed by: <the fix> ``, and may end with a link to the rule it backs. A `## Docs read` line is `- <URL or raw/refs/ file> · fetched <date>`. Lint warns on a line of either in another form. What is neither goes under `## Agent's reading`.
- `updated`: the day the page last changed. Set it whenever you change a page. Lint warns on a page other than a source page when a rule it links under `## Rules` or a source page it cites changed after it, and on a topic page when any source page on its topic did, going by `updated` or, since Obsidian doesn't change `updated`, the day the file was last saved.
- A source page has `## You said`, `## Agent's reading` and `## Rules`, and a topic page `## Rules`, even when one is empty. Lint warns on a missing one.
- `## You said`: source pages, the user's exact words about the source, one line each with the date and the session's short name. Empty when they said nothing. Lint warns on a line in another form, and on a line whose quote isn't in what the user typed in that session. A line whose session is no longer registered, or whose transcript is gone, can't be checked, and lint counts it in its tally of such quotes (see Evidence in `AGENTS.md`).
- `## Agent's reading`: source pages, the agent's description. It backs a rule only as `basis: reading`, so the rule's note labels it as the agent's.
- `## Rules`: the rules the page draws on. A source page's rules link back under their `## Examples`. A topic page may have none yet, which says no taste is captured on its topic.
- The other pages' bodies are free: write what a session working on the topic should know.
- Cite each claim a source backs with a footnote that names the source: a file under `raw/` or a URL, then its date when it has one. A source page's own source needs none. `index.md` counts the sources a page's footnotes name and the source pages it links. Lint warns on a footnote that names neither, a citation with no footnote, and a footnote nothing cites.

  ```markdown
  The tab bar packs six tabs into the top strip.[^1] A flex container spaces them with its `gap`.[^2]

  [^1]: raw/refs/shop-screens.png · dated 2026-09-30
  [^2]: https://developer.mozilla.org/en-US/docs/Web/CSS/gap
  ```

- A footnote may end in a locator: `#page=3` for a PDF, `#t=00:12:31` for audio or video, `#L10-L20` or `#L10` for lines of a text file. An anchor in derived text is a line of its own, so a `[p. 3]` inside a sentence is text. Lint warns on a line range past the file's end, and on a page or time the source's derived text has no anchor for.
- A **bundle** is a folder under `raw/refs/` holding a `source.md`: one source, however many files it holds. Its `source.md` starts with frontmatter giving the `commit` it was taken at with its `url` or `repo`, or a `sha256` list of `'<hash>  <path>'` lines, one per file, as `sha256sum` writes them. A footnote cites a file in it by its path. `node tools/bundle.mjs raw/refs/<folder>` writes its `source.md`, with `--url` or `--repo` and `--commit` for a folder taken from a repository, or the `sha256` list without them; it refuses a folder that already has one. A **doc set** is a folder under `raw/refs/` holding an `llms.txt` and no `source.md`, also one source: save its manifest and the pages notes cite, not the rest.
- **Derived text**, `derived/<sha256>.md`, is the text of a binary source: frontmatter giving its `kind` (`pdf`, `video`, `audio` or `image`), `extractor`, `extractor_version` and `source`, the binary's path under `raw/`, then the text with anchors such as `[p. 3]` and `[t=00:12:31]`. `node tools/extract.mjs <file>` writes it, and replaces it when the extractor or its version has changed (`--force` extracts again); it is never edited by hand. Lint warns when a listed extractor's version has moved on from the one that made the text, naming the command to run. Quotes from a binary are checked against its derived text, without the anchor lines, so a quote may run across a page break.

- Log each operation once, from the vault folder, or from anywhere with the paths in full. Each adds one line to `log.md` and rebuilds `index.md`:
  - a page written or changed on its own: the vault's `log` tool with `pages` that page, except a page `keep` wrote, which `keep` logged
  - an ingest: `log` with `ingest` the source and `pages`, and `batch` true when the source is one of a batch
  - an answer filed back: `log` with `query` the question and `pages`
- Lint warns, outside code and the user's quoted words, on a link that no note or other markdown file in the vault answers, on a bare `[[slug]]` more than one note has, and on a link by a note's key or through a folder it isn't in, giving the path to write. It reads a markdown link that starts with `./` or `../` from the note's folder, and any other link from the vault root. It also warns on two topic pages on one topic in a domain, and on a page other than a topic page that no other note links, with a `[[link]]` or a markdown link to its `.md` file.

## Picks

A pick is the user's choice between options the agent showed them for one piece of work in a domain's project, such as a screen's layout. It holds for that piece; a rule comes from it only when it says something for every piece, through `basis: pick`. `tools/pick.mjs` writes the rows; `node tools/pick.mjs --help` lists the fields.

```json
{"id":"q-1a2b3c4d","at":"2026-10-21T10:00:00.000Z","source":"pick","session":"…","transcript":"…","cwd":"…","domain":"example-ui",
 "project":"C:/projects/shop-game","subject":"shop","question":"Which shop layout?","header":null,
 "options":[{"label":"A, Grid","description":"…"},{"label":"B, Featured shelf","description":"…"}],"multiSelect":false,
 "pick":"B, Featured shelf","notes":"the featured rod reads first on phone","reason":null,"status":"user","sheet":"raw/picks/2026-10-21-shop.png"}
```

- `domain`: the domain the pick is for. A session in one domain gets it by default; one in several, such as a session at a monorepo root, must give it, and it must be one of the session's.
- `project`: that domain's project root, its marker folder or path, by default. When the domain has several roots in the session, as at a monorepo root, give it: the full path, or a folder name that names one root alone. A confirmation takes its pick's domain and project; a replacement must give the same ones.
- `subject`: the piece of work, lowercase-kebab-case.
- `status`: `user` when the user picked, `provisional` when the agent picked alone while they were away. `notes` is the user's words verbatim, so a provisional pick has none; `reason` is the agent's own. `tools/pick.mjs` refuses `notes`, on a pick or a confirmation, and a comment's `text` that the user didn't type in this session, and refuses both when the session has no transcript.
- `replaces`: the id of the pick this one reverses. A provisional pick can replace only another provisional pick. `confirms`: the id of the provisional pick the user agreed with; the row repeats its question, options, pick and sheet, and its reason unless it gives one. Either one ends the earlier row's turn: a row is live until a later row names it, and only a live row can be named.
- A comment row has `subject` and `text`, the user's words about the piece, and no options.
- The `pick` tool called with `show` the subject, and `domain` and `project` when needed, returns the live picks and comments on the subject in that project, newest first, then the delivered rules of the domain and of every other domain whose project holds that one, each leaving out the topics in its `showSkipTopics` in `vault.config.json`. The rules it prints count as shown to the session. The builder runs it before building or reviewing the piece and pastes its output into the reviewer's prompt.
- A sheet, a `.png`, `.jpg`, `.jpeg` or `.webp` image or a file with derived text (one saved in `raw/refs/` and extracted), is copied into `raw/picks/`, refused over `picks.maxSheetBytes` (3 MB by default, in `vault.config.json`).
- A provisional, replaced or confirmed pick backs no rule; propose from the live row instead.
- `review.mjs status` lists provisional picks not yet confirmed. Lint warns on a `replaces` or `confirms` that names no row, and on a sheet that doesn't exist.

## Inbox rows

Each note the `propose` and `keep` tools write, and each Evidence line they add through `repeats`, gets a row in the session's file in `raw/inbox/`. Rows are never edited, and a reader orders them by `at`.

```json
{"id":"a-1a2b3c4d","at":"2026-11-03T10:00:00.000Z","source":"agent","kind":"stated","text":"never let any into the UI code",
 "note":"example-ui/typed-props","session":"…","agent":"…","transcript":"…","cwd":"…","domain":"example-ui","consent":"prompt"}
```

- `text`: the exact words that back the rule (and `fix` for a failure, `pick` for a recorded answer, `page` for a user's page). Lint checks a quote in a note whose transcript is gone against this.
- `consent`: how the user agreed to the rule. `prompt` means they allowed the `keep` call at the agent's permission prompt. `code` means they typed the offer's code, and `approved` holds that message as they typed it. A row written in `corrections` mode has neither, and nor has one from before the vault recorded consent or from a vault-folder session that wrote at once, which may hold `approved` words alone.
- `change`: `reword` on the row of a kept reword, whose `note` is the rule it changed.
- Lint warns on a `consent` other than `prompt` or `code`, and on `code` with no `approved`.
- `queued`: the review queue entry the rule was proposed again from (see Queue rows). Its `session`, `agent`, `transcript` and `cwd` are that entry's, the session the words were typed in.

## Queue rows

Offers the user never answered, and rules a subagent or `/lint` drafted, wait in `raw/queue/<date>-<session>.jsonl` for the user's review. Rows are never edited. `node tools/build.mjs` writes the open entries to `queue.md`, which the edit hook keeps from hand edits.

```json
{"id":"u-9f8e7d6c","at":"2026-11-03T10:00:00.000Z","kind":"rule","why":"ignored","unattended":"left","from":"o-9f8e7d6c",
 "session":"…","agent":"…","transcript":"…","cwd":"…","domain":"global","key":"global/zod-refine-async",
 "fields":{…},"text":"…","quote":"…","checked":"2026-11-03"}
```

- `id`: `u-` and the offer's own hex when the entry comes from an offer, so one offer makes one entry; `from` names that offer.
- `why`: `unreleased` for a held offer the agent never released, `skipped` when the user wrote after seeing the offer without agreeing to it, `ignored` when nothing came after it, `unattended` for a subagent's rule, `drafted` for one `tools/queue.mjs draft` wrote.
- `unattended`: null, `subagent`, or `left` for an offer after which the user typed nothing at all.
- `kind`: `rule`, `evidence`, `page`, `reword`, `retire`, `move` or `domain`. A domain entry's `fields` are the `domain` tool's, and its `key` is the domain's name.
- `fields`: what `propose` takes to offer the rule again; `text`: the offer's lines.
- `quote` and `checked`: the words that passed the quote check, and the day. When the transcript is gone, `propose` with `queued` checks the quote against this row.

A decision is a later row: `{"id":"d-…","at":"…","decides":"u-…","decision":"kept|dropped|later","offer":"o-…","session":"…","agent":"…"}`. An entry is open until a `kept` or `dropped` row names it; `later` records that the user has seen it. `propose` with `queued` set to an entry's id, and `asked` where proposals is `off`, and for a rule entry `repeats` or `slug`, which replace its own, offers it again in every mode and in the vault folder too, and keeping it appends the `kept` row. `node tools/queue.mjs` lists and shows entries, and appends `drafted` entries and `later` and `dropped` rows. `node tools/review.mjs status` lists each drop with the session that made it. Lint warns on a row of the wrong shape, a decision that names no entry or closes one already closed, and an entry's `stated` or `inferred` quote that its session's transcript, while it exists, doesn't hold.
