import { readAsarHeader, walkAsar } from './asar.mjs';

const [, , asarPath, mode = 'stats', filterSrc] = process.argv;
const { header } = readAsarHeader(asarPath);
const files = walkAsar(header);

if (mode === 'stats') {
  const dirs = new Map();
  for (const f of files) {
    const top = f.path.split('/').slice(0, 2).join('/');
    dirs.set(top, (dirs.get(top) ?? 0) + 1);
  }
  console.log(`total entries: ${files.length}`);
  const interesting = [...dirs.entries()].filter(([k]) => /dsh|deepseek/i.test(k)).sort();
  console.log(interesting.map(([k, v]) => `${k} (${v} files)`).join('\n'));
} else {
  const re = new RegExp(filterSrc);
  const hits = files.filter((f) => re.test(f.path));
  console.log(`matches=${hits.length}`);
  console.log(hits.map((f) => `${f.size}\t${f.path}`).join('\n'));
}
