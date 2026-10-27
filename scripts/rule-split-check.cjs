#!/usr/bin/env node
'use strict';
// Verifies a rule-volume split lost no bullet: every `- ` bullet in the
// baseline (git show <baseRef>:<oldPath>) must reappear in the current
// oldPath + newPaths, modulo --allow exemptions for deliberate rewrites.
// Usage: node scripts/rule-split-check.cjs <baseRef> <oldPath> [newPath ...] [--allow=<substr>]...
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const allow = [];
const paths = [];
for (const arg of args) {
  if (arg.startsWith('--allow=')) allow.push(arg.slice(8));
  else paths.push(arg);
}
if (paths.length < 2) {
  console.error('usage: rule-split-check.cjs <baseRef> <oldPath> [newPath ...] [--allow=<substr>]...');
  process.exit(2);
}
const [baseRef, oldPath, ...newPaths] = paths;
const key = line => line.replace(/[`*\s]/g, '').slice(0, 30);
const bullets = text => text.split('\n').filter(l => l.startsWith('- ')).map(key);
let baseline;
try {
  baseline = execFileSync('git', ['show', `${baseRef}:${oldPath}`], { encoding: 'utf8' });
} catch (e) {
  console.error(`cannot read ${baseRef}:${oldPath}: ${e.message.split('\n')[0]}`);
  process.exit(2);
}
const oldKeys = bullets(baseline);
const merged = [oldPath, ...newPaths].map(p => fs.readFileSync(p, 'utf8')).join('\n');
const mergedKeys = new Set(bullets(merged));
let exempt = 0;
const missing = [];
for (const k of oldKeys) {
  if (mergedKeys.has(k)) continue;
  if (allow.some(a => k.includes(a.replace(/[`*\s]/g, '')))) { exempt++; continue; }
  missing.push(k);
}
console.log(`base bullets: ${oldKeys.length}`);
console.log(`current bullets: ${mergedKeys.size}`);
if (missing.length) {
  for (const k of missing) console.log(`MISSING: ${k}`);
  console.log('deliberate rewrite? re-run with --allow=<substring of the key>');
  process.exit(1);
}
console.log(`OK 守恒（豁免 ${exempt} 条）`);
