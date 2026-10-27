# Coding standards for tools/

These keep the hooks safe to run in every session. Follow them when you change anything under `tools/`.

## Runtime

- Node 22 ES modules (`.mjs`), built-in modules only. No npm packages, no build step.
- Scripts find the vault through `vaultPath()`, never the working directory. Hooks run from whatever project the session is in.
- Accept Windows and Git Bash paths and compare them case-insensitively. Use `toPosix`, `inside` and `domainsFor` from `lib/vault.mjs`.

## Hooks

- Every hook goes through `runHook`. It skips safe mode, fails open (errors go to `.state/errors.log`, nothing is printed), and prints JSON only when there is something to deliver.
- Hooks finish fast: no network and no child processes.
- Hook messages are copy the user and the agent read. Keep their wording unless the user agrees to a change.

## State

- Write files with `writeText` or `writeJson` (temp file, then rename). Append rows with `appendJsonl`, one call per batch.
- Proposals go in dated files in `raw/inbox/` (`inboxFile()`) with an `a-` id, and `propose.mjs` adds a line to `log.md` (`appendLog()`) for each note it writes, as `log.mjs` does for each page an agent writes. `pick.mjs` appends picks to dated files in `raw/picks/` (`picksFile()`) with a `q-` id. Rows are never edited. Older rows in `raw/inbox/` carry `c-` and `p-` ids. Readers treat a missing folder as empty.
- `raw/` is append-only. `.state/` belongs to the hooks: use the helpers in `lib/sessions.mjs` for sessions, markers and the stamps behind the session-start hook-error line and `/lint` reminder.
- The hooks read the notes as they are now, through `settledNotes()` and `settledRules()` in `lib/rules.mjs`, which leave out notes saved in the last `delivery.settleSeconds`; `propose.mjs` writes its note with `writeSettled()` so it applies at once. `build()`, lint and the repeat check use `liveRules()`, which has every rule. A rule's hash covers only its delivered text, and the markers carry it, so a reworded rule reaches each session once more.

## Code

- Code that two entry points share goes in `tools/lib/`; the rest stays in its entry point.
- Command-line scripts: usage errors exit 2, failures exit 1.
- Comments only for a non-obvious why. No docstrings, banner comments or TODOs.
- No test-only code. Tests change behavior through `vault.config.json`.

## What lint enforces

`node tools/lint.mjs` checks every `.mjs` file under `tools/` and reports each break as an error:

- Imports, whether `import … from`, `import()` or `require()`, are `node:` built-ins or relative paths.
- Every file in `hooks/` calls `runHook`.
- Nothing in `hooks/` or `lib/` prints (`console.*`, `process.stdout.write`, `process.stderr.write`) except `lib/vault.mjs`, where `runHook` prints. Scripts directly in `tools/` may print.
- Only `lib/vault.mjs` and `lib/sessions.mjs` call fs functions that change files: write, append, rename, remove, make folders, copy, open for writing or write streams, sync or async, as `fs.x(` or imported by name. Anywhere else, use or add a helper in `lib/vault.mjs`.
- Nothing imports `node:child_process`. Nothing in `hooks/` or `lib/` imports `node:http`, `node:https`, `node:http2`, `node:net`, `node:tls` or `node:dgram`, or calls `fetch(`.
- `process.cwd()` appears only in `lib/vault.mjs`.
- No TODO, FIXME, XXX or HACK comments, no `/**` docstrings, and no banner comments such as `// ===`, `// ---`, `// Step 1` or `// Note:`.

Lint reads the code with comments, strings and regex literals blanked out, so it doesn't match words inside them. It doesn't follow aliases such as `const w = fs.writeFileSync`.
