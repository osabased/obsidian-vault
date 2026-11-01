import fs from 'node:fs';
import { toPosix, inVaultFolder, writeText, plural } from './lib/vault.mjs';
import { reachOf, compileFor } from './lib/compile.mjs';
import { UsageError, failure } from './lib/input.mjs';

const USAGE = `usage: node tools/compile.mjs <project>...
Writes the project's taste rules into a marked section of the instruction file of each agent its domain lists under "compile" in vault.config.json.`;

// Every project is checked before any file is written, so a mistyped path in the list leaves the others as they were.
function plan(args) {
  if (!args.length) throw new UsageError();
  return args.map(arg => {
    const project = toPosix(arg);
    if (!fs.statSync(project, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`${arg} is not a folder.`);
    if (inVaultFolder(project)) throw new UsageError(`${arg} is in the vault, which holds no project to compile for.`);
    const reach = reachOf(project);
    if (!reach) throw new UsageError(`${arg} is in no domain that lists an agent under "compile" in vault.config.json.`);
    return { project, reach };
  });
}

try {
  let refused = false;
  for (const { project, reach } of plan(process.argv.slice(2))) {
    for (const r of compileFor(project, reach)) {
      const refuse = reason => {
        refused = true;
        console.log(`refused ${r.path}: ${reason}`);
      };
      if (r.refused) {
        refuse(r.refused);
      } else if (r.state === 'current') {
        console.log(`unchanged ${r.path}`);
      } else {
        try {
          // A linked file keeps its link, since the rename would otherwise replace the link with a file.
          writeText(fs.existsSync(r.path) ? fs.realpathSync(r.path) : r.path, r.text);
        } catch (e) {
          refuse(`the file can't be written (${e.code ?? e.message}). Make it writable, then compile again.`);
          continue;
        }
        console.log(`wrote ${r.path}: ${plural(r.rules, 'rule')}`);
      }
    }
  }
  if (refused) process.exitCode = 1;
} catch (e) {
  const { message, code } = failure(e, 'compile', USAGE, 'Not compiled');
  console.error(message);
  process.exitCode = code;
}
