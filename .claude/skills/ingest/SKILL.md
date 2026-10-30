---
name: ingest
description: "Go through one source with the user (a reference, a doc or changelog page). What they say about it becomes pages and rules."
disable-model-invocation: true
---

# Ingest

Work in the vault root. AGENTS.md has the page and rule formats. The user's typed words about the source are the evidence.

1. **Source.** Take the one source the user named: a file under `raw/refs/`, or a URL. Copy a file from elsewhere into `raw/refs/` under a new name first. If they named none, list the files in `raw/refs/` that no page's `source` names yet, and ask which.
2. **Read it** in full. For a URL, the browser's `get_page_text` gives the page's own words, which a knowledge rule can quote; WebFetch gives a summary.
3. **Say back** what it shows, a line or two per topic of the domain (`node tools/propose.mjs --help` lists the ones its rules and pages have and the ones it lists), labelled as your reading. Ask what they like and dislike in it and why, and wait for the answer.
   - For a doc or changelog, say instead which of its facts your training gets wrong or doesn't know, with its date, and ask which matter to them. How-tos (steps, setup, API usage) belong in the project's skills, for Roblox the osaskills `roblox-*` skills: tell the user so.
4. **Write the source page** `wiki/<domain>/source-<slug>.md`, `kind: source`, with the topic it's mostly about, a one-line summary, and their words verbatim under `## You said`. If they had nothing to say about it, `## You said` and `## Rules` stay as empty headings beside your reading, and no rule comes from it.
5. **Propose** a rule for each thing they said, the clearest first, with `tools/propose.mjs` (`node tools/propose.mjs --help` lists the fields). Pipe the JSON from the Bash tool with a quoted heredoc to `node tools/propose.mjs "$CLAUDE_CODE_SESSION_ID"`.
   - Taste: basis `stated` or `inferred`, quoting their typed words, or `reading` for what you saw in the source yourself, in your words.
   - Doc facts: `kind: knowledge`, basis `source`, quoting the page you read, by its URL; for a file you copied into `raw/refs/`, cite the URL it came from.
   - Give a rule about code or files `applies_to` globs from the project root; `always` is the user's to set.

   End your reply with the lines it prints; the rule applies from then on. If the user doesn't want it, delete its note, and if they want it worded otherwise, edit it. Then propose the next.
6. **Update the topic pages.** For each topic the source touched, find the topic's page in `index.md` (the page under that topic marked `topic page`) and add what the source and the user's words show, linking the source page in the body and the new rules under `## Rules`. Start one, with `kind: topic`, if the topic has none, and give it the `keywords` a request on the topic would use, and `applies_to` when the topic is about certain files, so the hooks point sessions to it. Set `updated` to today on every page you change.
7. **Link and log.** Link each rule you proposed under the source page's `## Rules`, and the source page under the rule note's `## Examples`. Run `node tools/log.mjs ingest <source> <page>...` once, naming the source and every page you wrote or changed, then `node tools/lint.mjs`, and fix any errors.

Done when the source page holds their words, each preference they stated is a rule, each topic the source touched has a topic page that reflects it, and lint shows no errors.
