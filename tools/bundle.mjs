import fs from 'node:fs';
import path from 'node:path';
import { vaultPath, vaultRel, filesIn, writeText, plural } from './lib/vault.mjs';
import { isUrl, bundleOf } from './lib/rules.mjs';
import { hashFile } from './lib/sources.mjs';
import { plainSafe, yamlQuote } from './lib/frontmatter.mjs';
import { UsageError, refuse, failure } from './lib/input.mjs';

const USAGE = `usage: node tools/bundle.mjs raw/refs/<folder> [--url <u> | --repo <r>] [--commit <c>]
Writes the folder's source.md: the url or repo with the commit the folder was taken at, given both, or else a sha256
line for each file in it.`;

class NotAFolder extends Error {}

function parseArgs(args) {
  const flags = {};
  const given = [];
  for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^--(url|repo|commit)$/);
    if (!m) {
      if (args[i].startsWith('--')) throw new UsageError();
      given.push(args[i]);
    } else if (flags[m[1]] !== undefined || i + 1 >= args.length) {
      throw new UsageError();
    } else {
      flags[m[1]] = args[++i].trim();
    }
  }
  const { url, repo, commit } = flags;
  if (given.length !== 1 || (url !== undefined && repo !== undefined) || ((url ?? repo) === undefined) !== (commit === undefined)) throw new UsageError();
  if (url !== undefined && !isUrl(url)) throw new UsageError();
  if (repo === '' || (commit !== undefined && !/^[0-9a-f]{7,64}$/.test(commit))) throw new UsageError();
  return { ref: given[0], flags };
}

// The folder as the disk spells it, from the vault root, so its lines match what lint and the source pages read.
function folderOf(ref) {
  const rel = (path.isAbsolute(ref) && vaultRel(ref)) || ref;
  let real;
  try { real = fs.realpathSync.native(vaultPath(...rel.split(/[\\/]/))); } catch { throw new NotAFolder(ref); }
  if (!fs.statSync(real).isDirectory()) throw new NotAFolder(ref);
  const at = path.relative(fs.realpathSync.native(vaultPath()), real).split(path.sep).join('/');
  if (!/^raw\/refs\/[^/]/.test(at)) throw new NotAFolder(ref);
  return at;
}

const scalar = s => (plainSafe(s) ? s : yamlQuote(s));

function bundle(args) {
  const { ref, flags } = parseArgs(args);
  const dir = folderOf(ref);
  if (fs.existsSync(vaultPath(...dir.split('/'), 'source.md'))) refuse(`${dir} already has a source.md, and raw/ is append-only.`);
  const outer = bundleOf(dir);
  if (outer && outer !== dir) refuse(`${dir} is inside ${outer}, which is one source already.`);
  const files = filesIn(vaultPath(...dir.split('/'))).sort();
  if (!files.length) refuse(`${dir} holds no files.`);
  const fields = flags.commit
    ? [flags.url ? `url: ${scalar(flags.url)}` : `repo: ${scalar(flags.repo)}`, `commit: ${yamlQuote(flags.commit)}`]
    : ['sha256:', ...files.map(f => `  - ${yamlQuote(`${hashFile(`${dir}/${f}`)}  ${f}`)}`)];
  const rel = `${dir}/source.md`;
  writeText(vaultPath(...rel.split('/')), `---\n${fields.join('\n')}\n---\n`);
  return `wrote ${rel}: ${plural(files.length, 'file')}`;
}

try {
  console.log(bundle(process.argv.slice(2)));
} catch (e) {
  if (e instanceof NotAFolder) {
    console.error(`${e.message} isn't a folder under raw/refs/.\n${USAGE}`);
    process.exitCode = 2;
  } else {
    const f = failure(e, 'bundle', USAGE, 'Not written');
    console.error(f.message);
    process.exitCode = f.code;
  }
}
