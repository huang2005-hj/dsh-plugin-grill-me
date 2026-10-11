// Minimal asar reader: pickle sizes locate the JSON directory; offsets are relative to the data area.
import { readFileSync } from 'node:fs';

export function readAsarHeader(asarPath) {
  const fd = readFileSync(asarPath);
  // 4 unused + 4 payload size + 4 string-data size, then the JSON directory
  const payloadLen = fd.readUInt32LE(4);
  const stringLen = fd.readUInt32LE(8);
  const jsonStart = 16;
  const jsonEnd = 8 + payloadLen;
  const header = JSON.parse(fd.subarray(jsonStart, jsonEnd).toString('utf8'));
  if (stringLen !== payloadLen - 4) throw new Error(`unexpected pickle layout: stringLen=${stringLen} payloadLen=${payloadLen}`);
  const baseOffset = jsonEnd;
  return { fd, header, baseOffset };
}

export function walkAsar(header) {
  const out = [];
  (function walk(node, prefix) {
    for (const [name, e] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (e.files) walk(e, p);
      else out.push({ path: p, offset: Number(e.offset), size: e.size });
    }
  })(header, '');
  return out;
}
