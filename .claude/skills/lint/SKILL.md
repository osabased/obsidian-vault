---
name: lint
description: "Check the whole agent-taste wiki: lint findings, hook errors, missed rules, contradictions, repeats, empty topics, stale pages, concepts with no page, claims a newer source overrides and gaps worth a web search, and the fixes for them."
disable-model-invocation: true
---

# Lint

Work in the vault root. AGENTS.md has the note and page formats. A rule applies as soon as its note is written, so fixing the wiki changes the notes themselves.

1. **Status.** Run `node tools/review.mjs status`, which also records this run, quieting the session-start error line and reminder, and logs its tally. Tell the user its lint tally, any hook errors, quoting the newest, the listed topics no rule has yet (taste not captured, not a fault), and the sources no source page names yet, which `/ingest batch` takes in. Then relay the missed rules. Taste rules never expire, so each one gets a fix to bring it up, not a deletion:
   - **Rules corrected again in later sessions.** For a session marked shown, the rule reached the agent and the user still corrected it: suggest how its wording or triggers could change. For one marked not shown, add the keywords or applies_to that would have brought it up. An unknown session ran before the hooks recorded deliveries, or was pruned.
   - **Rules no session was shown.** Suggest the keywords or applies_to that would bring each up in the sessions its domain gets.
2. **Lint.** Run `node tools/build.mjs`, then `node tools/lint.mjs`. For each error and warning, say what it means and the fix you propose. Name the rules with an empty **Because:** in one line; only the user can give their reason.
   - A rule that index.md marks `not delivered` reaches no session until its error is fixed.
   - A page lint calls stale needs rereading against the rule or source page that changed.
3. **Read the wiki.** Read `index.md`, then every rule and page, a domain at a time, and find what lint can't see:
   - rules that contradict each other, in one domain, between a domain and global, or between domains whose project folders nest, starting with the pairs status lists under "Rules on one topic whose globs overlap";
   - rules that say the same thing;
   - topic pages that no longer match their rules, and topics with two topic pages;
   - rules on a topic whose topic page doesn't link them;
   - concepts, APIs and named things that two pages mention with no page of their own;
   - claims a newer source overrides: each knowledge rule status lists under "Knowledge rules a newer source on their topic may override" against the newer source pages it names, and on each topic, a page's claims against the source pages dated after the sources it cites;
   - gaps worth a web search: a question a topic page leaves open, a claim only one old source backs, a topic with rules and no source. Write the search you would run for each.
4. **Fix.** Fix frontmatter, links, summaries, topic pages and generated files yourself, and log each page you change with `node tools/log.mjs wiki/<domain>/<slug>.md`.
   - Write the page a concept is missing from the sources the vault holds, citing them with footnotes, and link it from its topic page. One the vault's sources say too little about is a gap.
   - Rewrite a page's claim that a newer source overrides from that source, and cite it. For a knowledge rule, show the user the newer source's words and the Do, Not and `as_of` you would change, or the note that should supersede it.
   - For an Evidence or You said line lint can't check, or whose quote isn't in its source, find the words in what the line names: the session's transcript, the pick's row or the file. Add a line in the form AGENTS.md gives, with those exact words, and ask the user before you remove the old line. Put a quote you can't find to the user.
   - List the gaps with their searches. Run a search only when the user asks, and take in what it finds with `/ingest`.
   - For contradictions, show the user both rules and let them decide. Change a rule's Do, Not or Because, or delete a note, only once the user says yes.
5. Run `node tools/lint.mjs` again. Done when it shows no errors, each finding from steps 1 and 3 is fixed or put to the user, and the user has answered each change you proposed to a rule.
