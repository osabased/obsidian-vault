---
name: lint
description: "Check the whole agent-taste wiki: lint findings, hook errors, missed rules, contradictions, repeats, empty topics, stale pages, concepts with no page, claims a newer source overrides and gaps worth a web search, and the fixes for them."
disable-model-invocation: true
---

# Lint

Work in the vault root. AGENTS.md has the note and page formats. A rule applies as soon as its note is written, so fixing the wiki changes the notes themselves.

1. **Refresh.** Run `node tools/refresh.mjs`, which checks each saved source in `raw/refs/` against its URL or repo, saves a new copy of each one that changed, and prints a line per source and a tally. Tell the user the tally. Offline, every source is a failed check: say how many and go on. The notes a changed source left unverified, and the checks that failed, come up in the status next.
2. **Status.** Run `node tools/review.mjs status`, which also records this run, quieting the session-start error line and reminder, and logs its tally. Tell the user its lint tally, any hook errors, quoting the newest, the listed topics no rule has yet (taste not captured, not a fault), and the sources no source page names yet, which `/ingest batch` takes in; a re-fetch with a new `sha256` is one of them, though a page names its URL. Then relay the notes a changed source has left unverified: check each fact against the newer copy, then propose again with `repeats` and a quote from it, or retire the note with `superseded_by`. Relay the source checks that failed with their reasons. Relay the section "Quotes lint can't check" as a count, not line by line: a URL or a pruned transcript is nothing the user can fix. Then relay the missed rules. Taste rules never expire, so each one gets a fix to bring it up, not a deletion:
   - **Rules corrected again in later sessions.** For a session marked shown, the rule reached the agent and the user still corrected it: suggest how its wording or triggers could change. For one marked not shown, add the keywords or applies_to that would have brought it up. An unknown session ran before the hooks recorded deliveries, or was pruned.
   - **Rules no session was shown.** Suggest the keywords or applies_to that would bring each up in the sessions its domain gets.
3. **Lint.** Run `node tools/lint.mjs --fix` and tell the user in one line what it fixed. For each error and warning left, say what it means and the fix you propose. Name the rules with an empty **Because:** in one line; only the user can give their reason.
   - The warning "N quotes can't be checked" is a tally, and needs no fix.
   - A rule that index.md marks `not delivered` reaches no session until its error is fixed.
   - A page lint calls stale needs rereading against the rule or source page that changed.
   - Findings on `vault.config.json` or `vault.local.json`, such as a domain that reaches no project on this machine or a path that doesn't exist, are the user's to fix: tell them the change.
   - Findings on a file in `raw/refs/` or `derived/` can't be fixed in place, since `raw/` is append-only and `derived/` is written by extraction: put them to the user.
4. **Read the wiki.** Read `index.md`, then every rule and page, a domain at a time, and find what lint can't see:
   - rules that contradict each other, in one domain, between a domain and global, or between domains whose project folders nest, starting with the pairs status lists under "Rules on one topic whose globs overlap";
   - rules that say the same thing;
   - topic pages that no longer match their rules, and topics with two topic pages;
   - rules on a topic whose topic page doesn't link them;
   - concepts, APIs and named things that two pages mention with no page of their own;
   - claims a newer source overrides: each knowledge rule status lists under "Knowledge rules a newer source on their topic may override" against the newer source pages it names, and on each topic, a page's claims against the source pages dated after the sources it cites;
   - gaps worth a web search: a question a topic page leaves open, a claim only one old source backs, a topic with rules and no source. Write the search you would run for each.
5. **Fix.** Fix frontmatter, links, summaries and topic pages yourself, and log each page you change with `node tools/log.mjs wiki/<domain>/<folder>/<slug>.md`. A page with `author: user` is the user's own writing: put what you'd change to the user, and add only new lines under its `## Agent notes`.
   - Write the page a concept is missing from the sources the vault holds, citing them with footnotes, and link it from its topic page. One the vault's sources say too little about is a gap.
   - Rewrite a page's claim that a newer source overrides from that source, and cite it. For a knowledge rule, show the user the newer source's words and the Do, Not and `as_of` you would change, or the note that should supersede it.
   - Skip the lines the tally counts: a quote from a URL, and a quote of a session whose transcript is gone and whose line's id has no inbox row. A line whose transcript is there is checked and can warn, whatever its id. Status lists them under "Quotes lint can't check".
   - For an Evidence or You said line whose quote lint flags as not in its source, or whose form lint can't read, find the words in what the line names: the session's transcript, the pick's row, the file or the user's page. Add a line in the form AGENTS.md gives, with those exact words, and ask the user before you remove the old line. Put a quote you can't find to the user.
   - List the gaps with their searches. Run a search only when the user asks, and take in what it finds with `/ingest`.
   - For contradictions, show the user both rules with the one you recommend first, and let them decide. Status prints the ranking for pairs whose globs overlap; rank the others as AGENTS.md's Evidence section says. Change a rule's Do, Not or Because, or delete a note, only once the user says yes.
6. Run `node tools/lint.mjs --fix` again. Done when it shows no errors, each finding from steps 2 and 4 is fixed or put to the user, the user has answered each change you proposed to a rule, and `node tools/review.mjs done` has marked the run's end, so the notes this run changed don't count toward the next reminder.
