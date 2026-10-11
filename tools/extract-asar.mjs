import { readAsarHeader, walkAsar } from './asar.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [, , asarPath, outDir, filterSrc] = process.argv;
const re = new RegExp(filterSrc);
const { fd, header, baseOffset } = readAsarHeader(asarPath);
const files = walkAsar(header);
let n = 0;
for (const f of files) {
  if (!re.test(f.path)) continue;
  const dest = join(outDir, f.path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, fd.subarray(baseOffset + f.offset, baseOffset + f.offset + f.size));
  n++;
}
console.log(`written=${n} out=${outDir}`);
