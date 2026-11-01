import { makeVault, ruleNote, pageNote, sourcePage } from '../fixture.mjs';

const TOPICS = ['layout', 'color', 'code', 'tests', 'perf', 'naming', 'errors', 'docs'];
const WORDS = ['button', 'padding', 'retry', 'cache', 'schema', 'index', 'deploy', 'docker', 'query', 'tween', 'font', 'color', 'grid', 'layout', 'auth', 'token', 'logger', 'metrics', 'queue', 'worker'];
const EXTS = ['txt', 'ts', 'tsx', 'py', 'go', 'sql', 'md', 'json'];
const OTHERS = ['backend', 'infra', 'data'];
const KINDS = { topic: 'topics', concept: 'concepts', source: 'sources', entity: 'entities', synthesis: 'syntheses' };
const DOMAINS = ['ui', ...OTHERS, 'global'];

const globOf = i => `src/${WORDS[i % WORDS.length]}/**/*.${EXTS[i % EXTS.length]}`;

// Note 0 is a ui rule on this glob, so an edit of this file is gated in any vault that has it. Note 4, a global rule, is
// the one with tools, so an AskUserQuestion call is gated in every session.
export const GATED = globOf(0).replace('**', 'a').replace('*.', 'b.');

// Notes from to - 1, all settled. Each run of 25 holds 15 rules, then 10 pages of every kind with footnotes and links
// to the run's rules, every domain in both. A note depends only on its index.
export function addNotes(v, from, to) {
  for (let i = from; i < to; i++) {
    const domain = DOMAINS[i % DOMAINS.length];
    const topic = TOPICS[i % TOPICS.length];
    const kw = [WORDS[i % WORDS.length], WORDS[(i * 7 + 3) % WORDS.length]];
    const glob = globOf(i);
    const run = Math.floor(i / 25);
    if (Math.floor(i / 5) % 5 < 3) {
      const always = (i * 0.618) % 1 < 0.03;
      v.write(`wiki/${domain}/rules/rule-${i}.md`, ruleNote({
        domain, topic, always, applies_to: [glob, `**/*.${EXTS[(i + 1) % EXTS.length]}`], keywords: always ? [] : kw,
        doLine: `Rule ${i}: use the ${kw[0]} helper for every ${kw[1]} call in this module.`, notLine: `Inline the ${kw[1]} logic by hand.`,
        because: `Consistency across ${domain}.`, extra: i === 4 ? ['tools: [AskUserQuestion]'] : [],
        evidence: [`- 2026-10-01 · stated · session 1a2b3c4d · "use the ${kw[0]} helper" (a-${String(i).padStart(8, '0')})`],
      }));
    } else {
      const kind = Object.keys(KINDS)[(i + run) % 5];
      const ref = `raw/refs/ref-${i % 50}.md`;
      const sections = kind === 'source' ? ['## You said', '', "## Agent's reading", '', '## Rules'] : ['## Rules'];
      const body = [
        ...Array.from({ length: 20 }, (_, k) => {
          const j = 25 * run + (k * 7 + i) % 15;
          return `Paragraph ${k} about ${kw[0]} and ${kw[1]} with a claim.[^${k % 3 + 1}] See [[wiki/${DOMAINS[j % DOMAINS.length]}/rules/rule-${j}|rule]].`;
        }),
        '', ...sections, '',
        `[^1]: ${ref} · dated 2026-10-01`, `[^2]: https://example.com/${i}`, `[^3]: raw/refs/ref-${(i + 1) % 50}.md`,
      ];
      const page = { domain, topic, summary: `'Page ${i} on ${kw.join(' and ')}.'`, keywords: kw, applies_to: [glob], body };
      v.write(`wiki/${domain}/${KINDS[kind]}/${kind === 'source' ? `source-page-${i}` : `page-${i}`}.md`, kind === 'source' ? sourcePage({ ...page, source: ref }) : pageNote({ ...page, kind }));
    }
  }
}

export function bigVault(t, n) {
  const v = makeVault(t, {
    domain: 'ui',
    topics: TOPICS,
    domains: Object.fromEntries(OTHERS.map(d => [d, { title: d, markers: [`${d}.project`], topics: TOPICS }])),
  });
  for (let i = 0; i < 50; i++) v.write(`raw/refs/ref-${i}.md`, `---\nurl: https://example.com/${i}\nfetched: 2026-10-01\n---\nSome text ${i}.\n`);
  addNotes(v, 0, n);
  return v;
}
