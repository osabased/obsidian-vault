---
name: lint
description: "Check the whole vault wiki: lint findings, hook errors, missed rules, contradictions, repeats, empty topics, stale pages, concepts with no page, claims a newer source overrides and gaps worth a web search, and the fixes for them."
disable-model-invocation: true
---

# Lint

Work in the vault root. `reference/notes.md` has the note and page formats. A rule applies as soon as its note is written, so fixing the wiki changes the notes themselves. You change a rule only through an offer the user keeps: the edit hook refuses a hand edit to a rule's frontmatter or its Do, Not or Because.

1. **Refresh.** Run `node tools/refresh.mjs`, which checks each saved source in `raw/refs/` against its URL or repo, saves a new copy of each one that changed, and prints a line per source and a tally. Tell the user the tally. Offline, every source is a failed check: say how many and go on. The notes a changed source left unverified, and the checks that failed, come up in the status next.
2. **Status.** Run `node tools/review.mjs status`, which also records this run, quieting the session-start error line and reminder, and logs its tally. Tell the user its lint tally, any hook errors, quoting the newest, the listed topics no rule has yet (taste not captured, not a fault), and the sources no source page names yet, which `/ingest batch` takes in; a re-fetch with a new `sha256` is one of them, though a page names its URL. Then relay the notes a changed source has left unverified: check each fact against the newer copy, then propose again with `repeats` and a quote from it, or draft a reword from it in step 5, or draft its retirement in step 5. Relay the source checks that failed with their reasons. Relay the section "Quotes lint can't check" as a count, not line by line: a URL or a pruned transcript is nothing the user can fix. Then relay the missed rules. Taste rules never expire, so each one gets a fix to bring it up, not a deletion:
   - **Rules corrected again in later sessions.** For a session marked shown, the rule reached the agent and the user still corrected it: draft a reword of its wording, keywords or applies_to in step 5. For one marked not shown, draft the keywords or applies_to that would have brought it up. An unknown session ran before the hooks recorded deliveries, or was pruned.
   - **Rules no session was shown.** Draft the keywords or applies_to that would bring each up in the sessions its domain gets.

   Then relay the sections on versions, domains and pages, each drafted in step 5:
   - **Knowledge rules with a package and no checked_with.** Draft a reword that gives `checked_with` alone: the package's version in the projects that rule was shown in, from `.state/versions.json`. When the section says no version readers are set, tell the user that no rule is checked against a version until they name readers under `domains.<domain>.readers` in `vault.config.json`.
   - **Rules past their version in a project.** Draft each one's retirement.
   - **Global rules that keep matching one kind of project.** Draft a domain for each marker, with a name and title you propose, and a move of each rule it lists into it.
   - **Libraries with enough rules for an entity page**, **Entity pages that do the same job, with no comparison** and **Topics whose rules need a topic page to roll them up.** Draft the entity page, the comparison or the topic page, or the links the topic page lacks.
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
5. **Fix and draft.** Fix pages yourself, their frontmatter, links and summaries and the topic pages, and log each page you change with the vault's `log` tool, `pages` the one page. A page with `author: user` is the user's own writing: put what you'd change to the user, and add only new lines under its `## Agent notes`. A rule's Do, Not, Because, `applies_to` and `keywords` change through a drafted reword, below. Its other frontmatter, such as `topic`, `triggers` or `as_of`, no reword reaches: put the change to the user to make in Obsidian.
   - Write the page a concept is missing from the sources the vault holds, citing them with footnotes, and link it from its topic page. One the vault's sources say too little about is a gap.
   - Draft a page whose claim a newer source overrides, or whose source changed, with the claim rewritten from the newer source and cited. For a knowledge rule, draft a reword from the newer source's words, or its retirement, with `superseded_by` the rule that replaces it.
   - Skip the lines the tally counts: a quote from a URL, and a quote of a session whose transcript is gone and whose line's id has no inbox row. A line whose transcript is there is checked and can warn, whatever its id. Status lists them under "Quotes lint can't check".
   - For an Evidence or You said line whose quote lint flags as not in its source, or whose form lint can't read, find the words in what the line names: the session's transcript, the pick's row, the file or the user's page. Add a line in the form `reference/notes.md` gives, with those exact words, and ask the user before you remove the old line. Put a quote you can't find to the user.
   - List the gaps with their searches. Run a search only when the user asks, and take in what it finds with `/ingest`.
   - For contradictions, draft a reword of the rule you recommend changing, and say in the walk why, ranking the pair as status does for pairs whose globs overlap, and the others as AGENTS.md's Evidence section says. Deleting a note is the user's to do in Obsidian.
   - Draft each change that needs the user into the review queue with `node tools/queue.mjs draft`, which takes the fields the `propose` tool takes and writes only the queue entry: a page update, as `page` and the page's whole new `text`; an entity page for a library with rules and no page, with its `package`, or a comparison of two that do one job, a synthesis page whose `compares` names both; a topic page that rolls up its topic's rules; each reword, as `change: 'reword'` with the rule's `key` and basis `reading`, `source` or `failure`, or with `checked_with` alone and no basis; each retirement, as `change: 'retire'` with `key`, `because` and, when another rule replaces it, `superseded_by`; and a domain, as the `domain` tool's fields, then a move of each rule into it, as `change: 'move'` with `key` and `domain`. A fix you can make without the user is made, not drafted.
6. **Walk the queue.** Take the entries `node tools/queue.mjs list` lists, oldest first, a domain before the moves into it, one at a time:
   - Show the entry with `node tools/queue.mjs show <id>`, its why and its unattended mark first.
   - Offer it with the vault's `propose` tool and `queued` its id, then call `keep`: Allow once keeps it.
   - On a Deny, ask the user one question: later, drop, or change. Record later with `node tools/queue.mjs later <id>` and drop with `node tools/queue.mjs drop <id>`. For change, revise it as they say and propose the revision; once it is kept, drop the entry.
   - The user can stop at any entry, and the rest stay open.
7. Run `node tools/lint.mjs --fix` again. Done when it shows no errors, each finding from steps 2 and 4 is fixed, drafted or put to the user, the user has answered each entry you walked, and `node tools/review.mjs done` has marked the run's end, so the notes this run changed don't count toward the next reminder.
