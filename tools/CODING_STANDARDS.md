# Coding standards for tools/

These keep the hooks safe to run in every session. Follow them when you change anything under `tools/`.

## Runtime

- Node 22.12 or later, ES modules (`.mjs`), built-in modules only; the hooks load modules with `require`, which reads an ES module only from 22.12 on. No npm packages, no build step.
- Scripts find the vault through `vaultPath()`, never the working directory. Hooks run from whatever project the session is in, and from `.live/tools/`, a copy of `tools/` as of the last commit, so `vaultPath()` starts at the nearest folder above the code that holds `vault.config.json`. A script a hook tells a session to run comes from `toolsPath()`, the copy the hook runs from.
- Accept Windows and Git Bash paths and compare them case-insensitively. Use `toPosix`, `inside` and `domainsFor` from `lib/vault.mjs`.

## Hooks

- Every hook goes through `runHook`. It skips safe mode and prints JSON only when there is something to deliver. A hook that throws logs the error to `.state/errors.log`, prints one line, `vault <hook> failed: <message>; see .state/errors.log`, and exits 1, so the user sees a hook error and the call goes ahead. Any code may throw to trigger this.
- Hooks finish fast: no network, and no child process but the one `git status` that `changedFiles` in `lib/git.mjs` runs with a timeout. `lib/git.mjs` is the one place `tools/` runs another program, git, and hooks call only `changedFiles` from it; refresh runs the rest. A loop over the notes calls `checkDeadline()` from `lib/deadline.mjs`, which throws once the hook nears the `VAULT_HOOK_TIMEOUT` its command passes (10 seconds when unset).
- Hook messages, and the tools' descriptions, offers and refusals, are copy the user and the agent read. Keep their wording unless the user agrees to a change.

## State

- Write files with `writeText` or `writeJson` (temp file, then rename), or with `rewriteText` for a change that leaves what a note says as it was, which keeps the day the note was saved. Append rows with `appendJsonl`, one call per batch.
- Only `tools/compile.mjs` writes outside the vault, and only the files a format returns. A format, `tools/adapters/<name>/compile.mjs`, exports `compile(sections, root)`, which reads the project's file and returns the whole new text without writing it; `lib/compile.mjs` loads it by path. The text goes to other machines and repos, so it names no path on this one (pass `fitContext` a `leftOut` that names none) and holds only what committed files say, with no label from `.state/`. A section edited by hand is refused, never overwritten.
- Proposals go in the session's file in `raw/inbox/` (`inboxFile(name)`, named `<date>-<the session's short name>.jsonl`, the name `shortName()` in `lib/agents.mjs` gives) with an `a-` id, and `propose.mjs` adds a line to `log.md` (`appendLog()`) for each note it writes. `log.mjs` adds one for each operation an agent logs, naming every page it wrote, `review.mjs status` one with each lint tally, and `lint.mjs --fix` one naming the notes it fixed. `pick.mjs` appends picks to the session's file in `raw/picks/` (`picksFile(name)`, named the same way) with a `q-` id. The review queue's entries (`u-`) and decision rows (`d-`) go in the session's file in `raw/queue/` (`queueFile(name)`), written under `queue.lock` by `lib/queue.mjs`, which also writes `queue.md`. Readers also take the older `<date>.jsonl`, and order rows by `at`. Rows are never edited. Readers treat a missing folder as empty.
- `.state/calls/` holds the record the vault-call hook writes for each vault tool call, and `.state/offers/` the offers waiting for the user's agreement, through `lib/calls.mjs` and `lib/offers.mjs` under `withLock`. A tool takes its session from its call's record, never from its input, and `keep` writes only what a stored offer holds.
- `raw/` is append-only. `.state/` belongs to the hooks: use the helpers in `lib/sessions.mjs` for sessions, markers and the stamps behind the session-start hook-error line and `/lint` reminder.
- `loadNotes()` in `lib/rules.mjs` reads the notes through the cache in `.state/cache/`, which reads a note again only when its size or mtime changes; hooks pass it the domains they serve, so they walk only those folders and `wiki/global/`, and call it through `loadNotesAsync()`, which stats the notes at once first. The hooks read the notes as they are now, through `settledNotes()`, which keeps a note once git finds it unchanged from HEAD, its text has held for `delivery.settleSeconds`, or its file was saved that long ago and not in the future, and then `liveRules()` and `livePages()` on what it keeps, or through `settledRules()`, which does both for rules; `propose.mjs` writes its note with `writeSettled()` so it applies at once. Session start builds only when `changedSinceBuild()` in `lib/cache.mjs` finds a note changed since the last build. A build that derives reads the copies in `raw/refs/` through `cachedFiles()`, which reads a copy again only when its size or mtime changes. `build()`, lint and the repeat check use `liveRules()`, which has every rule. A rule's hash covers only its delivered text, and the markers carry it, so a reworded rule reaches each session once more.

## Code

- Code that two entry points share goes in `tools/lib/`; the rest stays in its entry point.
- Nothing outside `adapters/` names an agent, its tools or its hook fields. An adapter maps its agent's hook input to the core's events and the results back to its output, and holds no delivery logic. `test/neutral-core.test.mjs` checks the first half against the names each adapter lists in `identifiers`, its folder name and its `sessionVar`. It accepts three kinds of line: `FIRST_AGENT` in `lib/agents.mjs`, the `agents` default in `config()` in `lib/vault.mjs`, and the one-line `hooks/<hook>.mjs` shims that import an adapter's hook.
- Command-line scripts: usage errors and runs that can't finish exit 2, failures exit 1.
- A vault tool is a script directly in `tools/` that reads JSON from stdin and answers `--schema` with its description and input schema, both built from the field list that `--help` prints. The plugin's MCP server runs it for a session. `tools/mcp/` only speaks the protocol and is handed a `run` function; `mcp/launch.mjs` in the plugin root, which lint doesn't read, is the one place that starts a process for a tool call.
- Comments only for a non-obvious why. No docstrings, banner comments or TODOs.
- No test-only code. Tests change behavior through `vault.config.json`.
- Try a change in a test vault from `test/fixture.mjs`, not in this one: `review.mjs status` records a `/lint` run and logs its tally, and `propose.mjs` and `pick.mjs` append to `raw/`, which can't be undone.

## What lint enforces

`node tools/lint.mjs` checks every `.mjs` file under `tools/` and reports each break as an error:

- Imports, whether `import … from`, `import()` or `require()`, are `node:` built-ins or relative paths.
- Every file in `adapters/<agent>/hooks/` calls `runHook`. Each file in `hooks/` is one import of its entry in `adapters/`, kept while installed launchers still run it.
- Nothing in `adapters/`, `hooks/`, `lib/` or `ext/` prints (`console.*`, `process.stdout.write`, `process.stderr.write`) except `lib/vault.mjs`, where `runHook` prints. Scripts directly in `tools/` may print.
- Only `lib/vault.mjs` and `lib/sessions.mjs` call fs functions that change files: write, append, rename, remove, make folders, copy, open for writing or write streams, sync or async, as `fs.x(` or imported by name. Anywhere else, use or add a helper in `lib/vault.mjs`.
- Nothing but `lib/git.mjs` imports `node:child_process`, and nothing in `adapters/`, `hooks/`, `lib/` or `ext/` imports or re-exports anything but `changedFiles` from it, or imports it with `import()`. Nothing in `adapters/`, `hooks/`, `lib/` or `ext/` imports `node:http`, `node:https`, `node:http2`, `node:net`, `node:tls` or `node:dgram`, or calls `fetch(`.
- `process.cwd()` appears only in `lib/vault.mjs`.
- No TODO, FIXME, XXX or HACK comments, no `/**` docstrings, and no banner comments such as `// ===`, `// ---`, `// Step 1` or `// Note:`.

Lint reads the code with comments, strings and regex literals blanked out, so it doesn't match words inside them. It doesn't follow aliases such as `const w = fs.writeFileSync`.

## oxlint

oxlint is a dev check, not a dependency: nothing in `tools/` imports it, and it is the one npm package the repo uses. Pre-commit runs `oxlint --deny-warnings tools hooks mcp test` with the rules in `.oxlintrc.json`, so any warning refuses the commit; a commit that changes the code, the tests or `.oxlintrc.json` is refused on a machine without oxlint (`npm i -g oxlint@1.91.0`). Where code breaks a rule on purpose, put `// oxlint-disable-next-line <rule>` under the comment that says why.
