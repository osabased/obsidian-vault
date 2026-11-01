// A preload for a test that runs a tool as another program holds a file: fs.readFileSync throws EBUSY for a path ending with $HOLD.
import fs from 'node:fs';

const hold = process.env.HOLD;
const read = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
  if (hold && typeof p === 'string' && p.split(String.fromCharCode(92)).join('/').endsWith(hold)) throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${p}'`), { code: 'EBUSY' });
  return read.call(this, p, ...rest);
};
