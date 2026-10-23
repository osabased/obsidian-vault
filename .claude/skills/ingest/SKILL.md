---
name: ingest
description: "Go through one source with the user (a reference, a judgment, a doc or changelog page). What they say about it becomes a ref page and proposed rules."
disable-model-invocation: true
---

# Ingest

Work in the vault root. AGENTS.md has the ref page and rule formats. The user's typed words about the source are the evidence.

1. **Source.** Take the one source the user named: a file under `raw/refs/` or `raw/judgments/`, or a URL. Copy a file from elsewhere into `raw/refs/` under a new name first. If they named none, list the files in those two folders that no page's `source` names yet, and ask which.
2. **Read it** in full. For a URL, the browser's `get_page_text` gives the page's own words, which a knowledge rule can quote; WebFetch gives a summary.
3. **Say back** what it shows, a line or two per topic of the domain in `taste.config.json`, labelled as your reading. Ask what they like and dislike in it and why, and wait for the answer.
   - For a doc or changelog, say instead which of its facts your training gets wrong or doesn't know, with its date, and ask which matter to them. How-tos (steps, setup, API usage) belong in the project's skills, for Roblox the osaskills `roblox-*` skills: tell the user so.
4. **Write the ref page** `wiki/<domain>/ref-<slug>.md`, with their words verbatim under `## You said`. If they had nothing to say about it, the page keeps only your reading and no rule comes from it.
5. **Propose** one rule per reply from what they said, the clearest first, with `tools/propose.mjs` (`node tools/propose.mjs --help` lists the fields). Pipe the JSON from the Bash tool with a quoted heredoc to `node tools/propose.mjs "$CLAUDE_CODE_SESSION_ID"`.
   - Taste: basis `stated` or `inferred`, quoting their typed words.
   - Doc facts: `kind: knowledge`, basis `source`, quoting the page you read this session, by its URL. A file you copied into `raw/refs/` this session can't back one.

   End your reply with the lines it prints. After their confirm or drop, propose the next.
6. **Link** each rule you proposed under the page's `## Rules`, and the page under the rule note's `## Examples`. Run `node tools/lint.mjs` and fix any errors.

Done when the page holds their words, each preference they stated is proposed or, once the session's 3 proposals are used, named in your last reply for another session, and lint shows no errors.
