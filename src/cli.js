#!/usr/bin/env node
// Command-line tool (steps 3–10 run here until the web app exists).
//   node src/cli.js parse <file>            show units and the Stage 1 gate result
//   node src/cli.js replace <file> <find> <replacement> <outfile>
import fs from 'node:fs';
import path from 'node:path';
import { intake, parseDocument, writeDocument } from './index.js';

const [cmd, file, ...rest] = process.argv.slice(2);
if (!cmd || !file) {
  console.log('usage: node src/cli.js parse <file> | replace <file> <find> <replacement> <outfile>');
  process.exit(1);
}
try {
  const item = intake({ name: path.basename(file), bytes: fs.readFileSync(file) });
  const doc = parseDocument(item);
  if (cmd === 'parse') {
    console.log(`${item.name}: ${doc.format}, ${doc.blocks.length} blocks, ${doc.units.length} units. Stage 1 gate passed.`);
    for (const w of doc.warnings) console.log('warning:', w);
    for (const u of doc.units) console.log(`${u.id}\t${u.location}\t${u.isCopy ? '' : '[not copy] '}${u.text.replace(/\s+/g, ' ').trim()}`);
  } else if (cmd === 'replace') {
    const [find, replacement, outFile] = rest;
    const b = doc.blocks.find((x) => x.text.includes(find));
    if (!b) throw new Error(`"${find}" was not found`);
    const start = b.text.indexOf(find);
    const out = writeDocument(doc, [{ id: 'E1', blockId: b.id, start, end: start + find.length, before: find, after: replacement }]);
    if (!out.check.ok) throw new Error('round-trip check failed: ' + out.check.problems.join('; '));
    fs.writeFileSync(outFile, out.bytes);
    console.log(`Changed ${b.location}. Round-trip check passed. Wrote ${outFile}`);
  }
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
