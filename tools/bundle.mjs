import fs from 'node:fs';
import path from 'node:path';
import { vaultPath, filesIn, writeText, plural, fromRoot } from './lib/vault.mjs';
import { isUrl, bundleOf, diskRel, manifestNames } from './lib/rules.mjs';
import { hashFile } from './lib/sources.mjs';
import { yamlQuote, yamlScalar } from './lib/frontmatter.mjs';
import { UsageError, refuse, failure } from './lib/input.mjs';

const USAGE = `usage: node tools/bundle.mjs raw/refs/<folder> [--url <u> | --repo <r>] [--commit <c>]
Writes the folder's source.md: the url or repo with the commit the folder was taken at, given both, or else a sha256
line for each file in it.`;

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
  const at = diskRel(fromRoot(ref).replace(/\\/g, '/'));
  if (!at?.stat.isDirectory() || !/^raw\/refs\/[^/]/.test(at.rel)) throw new UsageError(`${ref} isn't a folder under raw/refs/.`);
  return at.rel;
}

// A source.md or a manifest anywhere inside would make the folder swallow a source, or turn it into a doc set.
function swallowed(dir, files) {
  const manifests = manifestNames();
  for (const f of files) {
    const name = path.posix.basename(f);
    const inner = path.posix.dirname(f);
    if (name === 'source.md') return `${dir} holds ${dir}/${f}, a bundle of its own, so it would swallow it.`;
    if (manifests.includes(name)) return `${dir} holds ${dir}/${f}, which makes ${inner === '.' ? 'it' : `${dir}/${inner}`} a doc set, one source already.`;
  }
  return null;
}

function bundle(args) {
  const { ref, flags } = parseArgs(args);
  const dir = folderOf(ref);
  if (fs.existsSync(vaultPath(...dir.split('/'), 'source.md'))) refuse(`${dir} already has a source.md, and raw/ is append-only.`);
  const outer = bundleOf(dir);
  if (outer && outer !== dir) refuse(`${dir} is inside ${outer}, which is one source already.`);
  const files = filesIn(vaultPath(...dir.split('/'))).sort();
  if (!files.length) refuse(`${dir} holds no files.`);
  const clash = swallowed(dir, files);
  if (clash) refuse(clash);
  const fields = flags.commit
    ? [flags.url ? `url: ${yamlScalar(flags.url)}` : `repo: ${yamlScalar(flags.repo)}`, `commit: ${yamlQuote(flags.commit)}`]
    : ['sha256:', ...files.map(f => `  - ${yamlQuote(`${hashFile(`${dir}/${f}`)}  ${f}`)}`)];
  const rel = `${dir}/source.md`;
  writeText(vaultPath(...rel.split('/')), `---\n${fields.join('\n')}\n---\n`);
  return `wrote ${rel}: ${plural(files.length, 'file')}`;
}

try {
  console.log(bundle(process.argv.slice(2)));
} catch (e) {
  const f = failure(e, 'bundle', USAGE, 'Not written');
  console.error(f.message);
  process.exitCode = f.code;
}
