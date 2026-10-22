# Coding standards for tools/

These keep the hooks safe to run in every session. Follow them when you change anything under `tools/`.

## Runtime

- Node 22 ES modules (`.mjs`), built-in modules only. No npm packages, no build step.
- Scripts find the vault through `vaultPath()`, never the working directory. Hooks run from whatever project the session is in.
- Accept Windows and Git Bash paths and compare them case-insensitively. Use `toPosix`, `inside` and `domainsFor` from `lib/vault.mjs`.

## Hooks

- Every hook goes through `runHook`. It skips safe mode and the pass, fails open (errors go to `.state/errors.log`, nothing is printed), and prints JSON only when there is something to deliver.
- Hooks finish fast: no network, and no waiting on child processes. Background work goes through `spawnPass`.
- Hook messages are copy the user and the agent read. Keep their wording unless the user agrees to a change.

## State

- Write files with `writeText` or `writeJson` (temp file, then rename). Append rows with `appendJsonl`, one call per batch.
- Rows in `raw/inbox/` and `raw/picks/` go in dated files (`inboxFile()`, `picksFile()`), carry a prefixed id (`c-`, `p-`, `q-`, and `a-` for proposals), and are resolved by id in `raw/decisions.jsonl`, never edited. Readers treat a missing folder as empty.
- `raw/` is append-only. `.state/` belongs to the hooks: use the helpers in `lib/sessions.mjs` for sessions, markers and pass state.
- Only `lib/commands.mjs` writes `confirmed.json`, under `withLock`, and before it saves any note.
- The hooks enforce the wording and hash recorded in the ledger, never the live note.

## Code

- Code that two entry points share goes in `tools/lib/`; the rest stays in its entry point.
- Command-line scripts: usage errors exit 2, failures exit 1.
- Comments only for a non-obvious why. No docstrings, banner comments or TODOs.
- In transcripts, the user's words are the text of user entries whose `turnOrigin` and `origin.kind` are each absent or "human", the prompts of `queued_command` attachments with `origin.kind` "human" (messages sent mid-turn), and, in AskUserQuestion results, answers typed instead of picking an option and notes on answers. Briefs, task notifications and peer messages are not, and neither is a picked option, which is the agent's wording and goes to `raw/picks/`. Read transcripts through `userBlocks()` and `answered()` in `session-pass.mjs`. Where only words the user certainly typed may count (commands and proposals), use `typedMessages()` in `lib/transcript.mjs`, which also skips user entries that carry no origin at all: slash-command echoes are unmarked, and a brief can produce them. For a slash command the user typed, it keeps only the text of `<command-args>`. Evidence for knowledge rules comes from the tool calls and results of the session and its subagents, through `toolActivity()` in the same file.
- No test-only code. Tests change behavior through `taste.config.json`, for example a `pass.command` array.

## What lint enforces

`node tools/lint.mjs` checks every `.mjs` file under `tools/` and reports each break as an error:

- Imports, whether `import … from`, `import()` or `require()`, are `node:` built-ins or relative paths.
- Every file in `hooks/` calls `runHook`.
- Nothing in `hooks/` or `lib/` prints (`console.*`, `process.stdout.write`, `process.stderr.write`) except `lib/vault.mjs`, where `runHook` prints. Scripts directly in `tools/` may print.
- Only `lib/vault.mjs` and `lib/sessions.mjs` call fs functions that change files: write, append, rename, remove, make folders, copy, open for writing or write streams, sync or async, as `fs.x(` or imported by name. Anywhere else, use or add a helper in `lib/vault.mjs`.
- Only `lib/sessions.mjs` and `session-pass.mjs` import `node:child_process`. Nothing in `hooks/` or `lib/` imports `node:http`, `node:https`, `node:http2`, `node:net`, `node:tls` or `node:dgram`, or calls `fetch(`.
- `process.cwd()` appears only in `lib/vault.mjs`.
- No TODO, FIXME, XXX or HACK comments, no `/**` docstrings, and no banner comments such as `// ===`, `// ---`, `// Step 1` or `// Note:`.

Lint reads the code with comments, strings and regex literals blanked out, so it doesn't match words inside them. It doesn't follow aliases such as `const w = fs.writeFileSync`.
