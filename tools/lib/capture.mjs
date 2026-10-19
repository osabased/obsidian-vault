const PATTERNS = [
  ['rather', /\bi(?:'d| would)? rather\b|\bi(?:'d| would)? prefer\b|\bmy preference\b/i],
  ['want-rule', /\bi want (?:the agent|agents?|you|claude|it|them|everything|all|ui|the ui)\b[^.!?\n]*\b(?:always|never|to be|to use|to have|to look)\b/i],
  ['always-never', /\b(?:always|never)\b/i],
  ['dont', /\b(?:don'?t|do not|stop|avoid)\b[^.!?\n]{0,40}\b(?:use|using|choose|pick|add|make|write|put|ever|do)\b/i],
  ['instead', /\binstead\b|\brather than\b/i],
  ['id-pick', /\bi'?d (?:keep|go with|use|pick|choose)\b/i],
  ['from-now-on', /\b(?:from now on|going forward|in (?:the )?future|next time|every time|whenever)\b/i],
  ['looks', /\b(?:looks?|feels?|seems?) (?:off|wrong|cheap|generic|bad|cluttered|busy|plain|ugly|amateur|weird|odd|empty|cramped)\b/i],
  ['too', /\btoo (?:big|small|large|bright|dark|round|busy|much|many|plain|generic|cluttered|loud|thin|thick|tight|cramped|long|short|wide|narrow|slow|fast)\b/i],
  ['should', /\b(?:it|this|that|they|ui|the \w+) should(?:n'?t)? (?:be|have|use|look|feel)\b/i],
  ['like', /\bi (?:really )?(?:like|love|hate|dislike)\b|\bnot a (?:big )?fan of\b/i],
  ['make-more', /\bmake (?:it|them|this|that|these|those|the \w+) (?:a (?:bit|little|lot) )?(?:more|less|bigger|smaller|darker|lighter|brighter|wider|narrower|taller|shorter|bolder|thinner|thicker)\b/i],
];

export const stripInjected = text => String(text ?? '')
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g, '')
  .trim();

export const sentences = text => text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);

const kindsOf = s => {
  const straight = s.replace(/[‘’]/g, "'");
  return PATTERNS.filter(([, re]) => re.test(straight)).map(([kind]) => kind);
};

export function capturable(text) {
  const t = stripInjected(text);
  if (t.startsWith('<')) return [];
  const plain = t.replace(/```[\s\S]*?(?:```|$)/g, '\n').split(/\r?\n/).filter(l => !/^\s*>/.test(l)).join('\n');
  return sentences(plain)
    .filter(s => s.length <= 400)
    .map(s => ({ text: s, kinds: kindsOf(s) }))
    .filter(c => c.kinds.length);
}

export const normText = s => String(s)
  .toLowerCase()
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ')
  .trim();
