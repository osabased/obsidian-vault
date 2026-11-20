---
name: ingest
description: "Take in a source with the user, or with `/ingest batch` every file in raw/refs/ no source page names yet. Each becomes a source page and updates to the pages it touches; what the user says and the source's dated facts become rules."
disable-model-invocation: true
argument-hint: "[file | URL | batch]"
---

# Ingest

Work in the vault root. `reference/notes.md` has the page and rule formats. With `batch`, follow Batch at the end. Otherwise take one source through these steps with the user.

1. **Source.** Take the source the user named. If they named none, run `node tools/review.mjs sources`, which lists the files in `raw/refs/` no source page names, and ask which. If a source page already covers it, update that page in step 4 rather than start another: one whose `source` is the file, or for a URL, the URL or a file in `raw/refs/` whose frontmatter gives that `url`. A copy with a `sha256` is covered only by a page naming that file, or a copy with the same `url` and `sha256`: a re-fetch with a new hash is a new source, with a source page of its own.
2. **Save it** in `raw/refs/`, so pages and rules cite a copy whose words the `propose` tool can check:
   - A file under `raw/refs/` is there already. Copy a file from elsewhere in under a new name.
   - For a URL, save the page's own words, as the browser's `get_page_text` gives them (raise `max_chars` for a long page), to a new `raw/refs/<slug>.md` that starts with frontmatter giving its `url`, the address the browser ends on after any redirect, and the day you `fetched` it, and no `sha256`, `etag` or `last_modified`: a later tool computes those. WebFetch gives a summary rather than the page's words, so if no browser can open the page, ask the user to save it into `raw/refs/`.
   - For a binary source, such as a PDF or a recording, run `node tools/extract.mjs <file>`, which writes its text to `derived/` for the `propose` tool and lint to check quotes against; for a bundle, run it on each file in the folder. If a line says `failed`, stop and tell the user what it printed. The one line that isn't a stop is `no extractor in extractors reads` a file's extension, whatever the file is, such as an image, a font or an archive: it goes on without derived text. An image backs basis `reading`; any other such file backs nothing. A `failed` line for an extractor that threw, a bad result or a key- or token-shaped value is still a stop.
   - Then run `node tools/scan.mjs <file>` on the source, whatever it is, giving a bundle or doc set as its folder. If it exits 1, the source holds a key- or token-shaped value: show the user the lines it printed and stop until they remove the values from the file, or add the allow ids of the ones that aren't secrets to `privacy.allow` in `vault.config.json`. Any other exit but 0 means the scan didn't finish: show the user what it printed and stop. A `skipped` line for a file no extractor reads means its text wasn't scanned: tell the user so.

   Then read it in full, a binary in its derived text, and an image with none by viewing the image itself, which backs only basis `reading` (step 5).
3. **Discuss** the main points with the user, a line or two per topic of the domain (the `propose` tool's schema lists the ones its rules and pages have and the ones it lists), labelled as your reading.
   - Name each **new fact** in it, a dated fact your training gets wrong or doesn't know, with its date, and ask which to keep as rules.
   - Ask what they like and dislike in it and why, and wait for the answer.
   - How-tos (steps, setup, API usage) belong in the project's skills, such as an `example-ui-*` skill for `example-ui`: tell the user so.
4. **Write the source page** `wiki/<domain>/sources/source-<slug>.md`, `kind: source`, with `source` the file in `raw/refs/`, `source_date` the day it was published or last updated, the topic it's mostly about and a one-line summary. Put their words verbatim under `## You said`, and your reading under `## Agent's reading`, quoting each new fact in the source's words. `## You said` stays an empty heading if they said nothing about it, and `## Rules` until step 7. Its domain is the one whose topics the source fits, or `global` if it fits every project. For a source that fits neither, offer the user a new domain in your reply: a name, a title, its topics, and `vaultOnly: true` when it will hold pages only, or the file that marks its projects. Once they agree, call the vault's `domain` tool (its schema lists the fields) and do what it returns, then write the page in it; if they decline, use `global`.
5. **Propose rules**, the clearest first, with the vault's `propose` tool (its schema lists the fields).
   - Taste and practice rules come from the user's words: basis `stated` or `inferred`, quoting what they typed, or `reading` for something you saw in the source that they asked you to make a rule of.
   - Knowledge rules come from the new facts the user kept: `kind: knowledge`, basis `source`, with `source` and `source_date` as on the source page, and the source's words as the quote. A source with no date backs none.
   - Quote a binary source from its derived text, leaving out the `[p. 3]` and `[t=00:12:31]` anchor lines; a quote may run across one. What an image shows is your reading, so an image backs only basis `reading`.
   - Give a rule about code or files `applies_to` globs from the project root, fitting the files in the domain's projects. `always` is the user's to set.
   - A rule goes in its source page's domain. A vault-only domain takes no rules: put a rule from its source in the domain whose projects its `applies_to` globs fit, or in `global`.

   `propose` returns each rule as an offer: do what it returns, so the user keeps it through the vault's `keep` tool. End your reply with the lines `keep` returns; the rule applies from then on. If the user denies it, ask whether to drop it or word it otherwise, and propose the new wording. Then propose the next.
6. **Update the pages it touches.** For each topic the source touches, find in `index.md` the topic page and the concept and entity pages under it.
   - Add what the source shows to each page it bears on, citing it with a footnote, and what the user said, linking the source page. Where it contradicts a page and is newer than that page's sources, rewrite the claim from it and say what changed; where it's older, keep the claim and note the disagreement.
   - A page with `author: user` is the user's own writing: add to it only new lines under its `## Agent notes`.
   - Start a topic page, `kind: topic`, for a topic with none, with the `keywords` a request on the topic would use, and `applies_to` when the topic is about certain files, so the hooks point sessions to it.
   - Start a concept or entity page for an idea, API or named thing that the source explains, or that two pages now mention, and that has no page yet. Give it `keywords` too, and link it from its topic page.
   - Link the source page from the page of the topic it is mostly about, and the new rules under the topic page's `## Rules`. Set `updated` to today on every page you change.
7. **Link and log.** Link each rule you proposed under the source page's `## Rules`, and the source page under the rule note's `## Examples`. Call the vault's `log` tool once with `ingest` the source and `pages` every page you wrote or changed, then run `node tools/lint.mjs --fix`, and fix any errors it leaves.

Done when the source page holds their words, each preference they stated is a taste or practice rule, each dated fact they kept is a knowledge rule, every page the source bears on reflects it with a footnote, and lint shows no errors.

## Batch

`/ingest batch` takes in every file `node tools/review.mjs sources` lists, without the user, so it writes pages only: a rule reaches sessions as soon as it is written, and the user approves each one first.

1. Tell the user how many sources there are, then take them one at a time through steps 2, 4, 6 and 7 above, with these changes:
   - Step 2: run `extract.mjs` and `scan.mjs` as there. Leave each source step 2 stops on for the user: write nothing for it, go on to the next, and when the batch ends, list each one left with the lines the tool printed. A file no extractor reads isn't left: take it through, and list it at the end as a source whose text wasn't scanned.
   - Step 4: pick the domain whose topics the source fits, or `global` if it fits every project. `## You said` stays empty. Leave a source that fits neither for item 2: write nothing for it yet.
   - Steps 6 and 7: there are no rules to link.
   - Step 7: log each source with the `log` tool, `ingest` the source, `batch` true and `pages` the pages.
2. Offer the user a domain for each source left at step 4, as step 4 above does, and take each through steps 4, 6 and 7 in the domain they agree to, or in `global` if they decline.
3. When every source has a page, list a knowledge rule for each new fact quoted under `## Agent's reading` on the source pages this batch wrote, numbered, each with its domain and `applies_to` (see step 5), Do, Not, topic, source and date, and ask which to add. `log.md` names those pages on its `· batch` lines from this session, and from an earlier session whose batch stopped before this step: its `· batch` lines are the last before this session's, with no line of its own after them.
4. Propose the ones the user approves as in step 5. Link each under its source page's `## Rules` and under the `## Rules` of its topic's page, which you start as in step 6 if the topic has none, and the source page under the rule note's `## Examples`. Set `updated` to today on the source page and the topic page, and log each with the `log` tool, `pages` the one page; `keep` logged the rule.

Done when `node tools/review.mjs sources` lists nothing, each knowledge rule the user approved is written and linked, and lint shows no errors.
