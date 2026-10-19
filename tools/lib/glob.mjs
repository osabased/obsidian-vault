function convert(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      const whole = i === 0 || glob[i - 1] === '/';
      if (whole && i + 2 === glob.length) {
        out += '.*';
        i++;
      } else if (whole && glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '[^/]*';
        i++;
      }
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '{') {
      const close = glob.indexOf('}', i);
      const body = close < 0 ? '' : glob.slice(i + 1, close);
      if (close < 0 || body.includes('{')) throw new Error(`unbalanced braces in ${glob}`);
      out += `(?:${body.split(',').map(convert).join('|')})`;
      i = close;
    } else if (ch === '}') {
      throw new Error(`unbalanced braces in ${glob}`);
    } else {
      out += /[\\^$.|+()[\]]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return out;
}

export const globToRegExp = glob => new RegExp(`^${convert(String(glob).replace(/\\/g, '/').replace(/^\.?\//, ''))}$`, 'i');

export function validGlob(glob) {
  if (typeof glob !== 'string' || !glob.trim()) return false;
  try {
    globToRegExp(glob);
    return true;
  } catch {
    return false;
  }
}

export function specificity(glob) {
  const literal = glob.split('/').filter(s => s && !/[*?{]/.test(s)).length;
  return [literal, glob.replace(/[*?{},]/g, '').length];
}

export const bySpecificity = (a, b) => b[0] - a[0] || b[1] - a[1];

export function bestMatch(globs, rel) {
  const hits = globs.filter(g => validGlob(g) && globToRegExp(g).test(rel));
  return hits.sort((a, b) => bySpecificity(specificity(a), specificity(b)))[0] ?? null;
}
