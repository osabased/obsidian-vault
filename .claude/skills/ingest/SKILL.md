---
name: ingest
description: "Take in a source with the user, or with `/ingest batch` every file in raw/refs/ no source page names yet. Each becomes a source page and updates to the pages it touches; what the user says and the source's dated facts become rules."
disable-model-invocation: true
argument-hint: "[file | URL | batch]"
---

# Ingest

Work in the vault root. AGENTS.md has the page and rule formats. With `batch`, follow Batch at the end. Otherwise take one source through these steps with the user.

1. **Source.** Take the source the user named. If they named none, run `node tools/review.mjs sources`, which lists the files in `raw/refs/` no source page names, and ask which. If a source page already covers it, update that page in step 4 rather than start another: one whose `source` is the file, or for a URL, the URL or a file in `raw/refs/` whose frontmatter gives that `url`.
2. **Save it** in `raw/refs/`, so pages and rules cite a copy whose words propose.mjs can check:
   - A file under `raw/refs/` is there already. Copy a file from elsewhere in under a new name.
   - For a URL, save the page's own words, as the browser's `get_page_text` gives them (raise `max_chars` for a long page), to a new `raw/refs/<slug>.md` that starts with frontmatter giving its `url` and the day you `fetched` it. WebFetch gives a summary rather than the page's words, so if no browser can open the page, ask the user to save it into `raw/refs/`.

   Then read it in full.
3. **Discuss** the main points with the user, a line or two per topic of the domain (`node tools/propose.mjs --help` lists the ones its rules and pages have and the ones it lists), labelled as your reading.
   - Name each **new fact** in it, a dated fact your training gets wrong or doesn't know, with its date, and ask which to keep as rules.
   - Ask what they like and dislike in it and why, and wait for the answer.
   - How-tos (steps, setup, API usage) belong in the project's skills, for Roblox the osaskills `roblox-*` skills: tell the user so.
4. **Write the source page** `wiki/<domain>/sources/source-<slug>.md`, `kind: source`, with `source` the file in `raw/refs/`, `source_date` the day it was published or last updated, the topic it's mostly about and a one-line summary. Put their words verbatim under `## You said`, and your reading under `## Agent's reading`, quoting each new fact in the source's words. `## You said` stays an empty heading if they said nothing about it, and `## Rules` until step 7.
5. **Propose rules**, the clearest first, with `tools/propose.mjs` (`--help` lists the fields). Pipe the JSON from the Bash tool with a quoted heredoc to `node tools/propose.mjs "$CLAUDE_CODE_SESSION_ID"`.
   - Taste rules come from the user's words: basis `stated` or `inferred`, quoting what they typed, or `reading` for something you saw in the source that they asked you to make a rule of.
   - Knowledge rules come from the new facts the user kept: `kind: knowledge`, basis `source`, with `source` and `source_date` as on the source page, and the source's words as the quote. A source with no date backs none.
   - Give a rule about code or files `applies_to` globs from the project root, fitting the files in the domain's project folders that `vault.config.json` lists; a knowledge rule needs them. `always` is the user's to set.
   - A rule goes in its source page's domain. A research domain takes no rules, so a rule from its source goes in the domain, or `global`, whose projects its `applies_to` is for.

   End your reply with the lines it prints; the rule applies from then on. If the user doesn't want it, delete its note, and if they want it worded otherwise, edit it. Then propose the next.
6. **Update the pages it touches.** For each topic the source touches, find in `index.md` the topic page and the concept and entity pages under it.
   - Add what the source shows to each page it bears on, citing it with a footnote, and what the user said, linking the source page. Where it contradicts a page and is newer than that page's sources, rewrite the claim from it and say what changed; where it's older, keep the claim and note the disagreement.
   - Start a topic page, `kind: topic`, for a topic with none, with the `keywords` a request on the topic would use, and `applies_to` when the topic is about certain files, so the hooks point sessions to it.
   - Start a concept or entity page for an idea, API or named thing that the source explains, or that two pages now mention, and that has no page yet. Give it `keywords` too, and link it from its topic page.
   - Link the source page from the page of the topic it is mostly about, and the new rules under the topic page's `## Rules`. Set `updated` to today on every page you change.
7. **Link and log.** Link each rule you proposed under the source page's `## Rules`, and the source page under the rule note's `## Examples`. Run `node tools/log.mjs ingest <source> <page>...` once, naming the source and every page you wrote or changed, then `node tools/lint.mjs`, and fix any errors.

Done when the source page holds their words, each preference they stated is a taste rule, each dated fact they kept is a knowledge rule, every page the source bears on reflects it with a footnote, and lint shows no errors.

## Batch

`/ingest batch` takes in every file `node tools/review.mjs sources` lists, without the user, so it writes pages only: a rule reaches sessions as soon as it is written, and the user approves each one first.

1. Tell the user how many sources there are, then take them one at a time through steps 2, 4, 6 and 7 above, with these changes:
   - Step 4: pick the domain whose topics the source fits, or `global` if it fits every project. `## You said` stays empty.
   - Steps 6 and 7: there are no rules to link.
   - Step 7: log each source with `node tools/log.mjs ingest --batch <source> <page>...`.
2. When every source has a page, list a knowledge rule for each new fact quoted under `## Agent's reading` on the source pages this batch wrote, numbered, each with its domain and `applies_to` (see step 5), Do, Not, topic, source and date, and ask which to add. `log.md` names those pages on its `· batch` lines from this session, and from an earlier session whose batch stopped before this step: its `· batch` lines are the last before this session's, with no line of its own after them.
3. Propose the ones the user approves as in step 5. Link each under its source page's `## Rules` and under the `## Rules` of its topic's page, which you start as in step 6 if the topic has none, and the source page under the rule note's `## Examples`. Set `updated` to today on the source page and the topic page, and log each with `node tools/log.mjs wiki/<domain>/<folder>/<slug>.md`; propose.mjs logged the rule.

Done when `node tools/review.mjs sources` lists nothing, each knowledge rule the user approved is written and linked, and lint shows no errors.
