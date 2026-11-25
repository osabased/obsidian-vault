---
name: distill
description: "Turn what this session learned into vault pages, written at once, and rules, proposed as your proposals setting says."
disable-model-invocation: true
argument-hint: "[subject]"
---

# Distill

Turn what this session learned into vault knowledge a later session can use. The vault folder is the one the session-start note names; its `reference/notes.md` has the formats, and its Pages section is what you need before writing a page. If the user named a subject, distill only that.

1. **Harvest.** List every lesson the session holds, one line each:
   - a fix: something that worked only after a failure, with the error as printed and the fix;
   - a dated source's fact: a doc, changelog or issue the session read, with its URL or file and its date;
   - understanding the session worked out: how a thing works, why an approach won, how two options compare;
   - the user's corrections and stated preferences, in their words.

   Leave out what mattered only to this task, and the story of the task. If the session was compacted, its summary is all you see of the part before: distill what you can see, and keep a list of what the summary mentions too thinly to write. Spend nothing to recover it.
2. **Check the vault.** For each lesson, read the vault's `index.md` and call the vault's `search` tool with its words, then read the notes that come up. A lesson a note already states is covered.
3. **Route** each lesson to one place:
   - a preference or correction of the user's: a taste or practice rule, quoting their words;
   - a fix, or a dated source's fact your training gets wrong: a knowledge rule, basis `failure` or `source`;
   - understanding, and the background a rule's one line leaves out: a page. Extend the page on its subject if there is one, or start a concept, entity or synthesis page, one subject to a page;
   - steps an agent follows: the skill they belong in;
   - a fact about this project, such as how it builds or where its files live: the session's auto memory, or a line for the project's `CLAUDE.md`;
   - friction with the tools or the workflow: name it in your report;
   - covered: a rule the user's words here restate takes them as evidence, through `propose` with `repeats`; anything else covered needs nothing.

   Rules and pages go in a domain this session reaches, which the vault's `status` tool names, or in `global` when they hold in every project. A lesson for another domain is filed later from the vault folder.
4. **Write the pages** with your edit tool, for an agent reading them later: what to know, by subject. Cite each claim a URL or a file under `raw/` backs with a footnote that names it and its date, give what you saw run as the command, its result and the day, and label the rest as your reading. Give each page `keywords`, and `applies_to` when it is about certain files, so the hooks bring it up. Set `updated` to today on each page you change, and link each new page from its topic page, starting the topic page when its topic has none. A page the user closed with `open: false` takes a page change instead: `propose` with `page`, `text` and `hold: true`.
5. **Hold the rules.** Propose each through the vault's `propose` tool with `hold: true`. When it refuses, fix what it names and propose again; when it lists rules the lesson may repeat, propose again with `repeats`, or as it is if the lesson says something new. When `status` shows `proposals: off` and the session is outside the vault folder, list the rules in your report instead, and propose the ones the user then asks you to keep.
6. **Log and lint.** Call the vault's `log` tool once for each page you wrote, with `pages` that page. Run `node <vault folder>/tools/lint.mjs`, and fix each error and warning it reports on a page you wrote.
7. **Report and release.** Reply with the pages you wrote, each lesson routed elsewhere with where it goes, the lessons already covered, the lessons for another domain, and what compaction hid. Then call `propose` with `release: true`, end your reply with what it returns, and do what it says, so the user allows each rule.

Done when every lesson from step 1 is written, held, routed elsewhere, covered or reported, lint reports nothing on the pages you wrote, and the held rules are released.
