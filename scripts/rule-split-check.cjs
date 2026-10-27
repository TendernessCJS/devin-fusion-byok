#!/usr/bin/env node
'use strict';
// Verifies a rule-volume split lost no bullet: every `- ` bullet in the
// baseline (git show <baseRef>:<oldPath>) must reappear in the current
// oldPath + newPaths, modulo --allow exemptions for deliberate rewrites.
// SHRUNK additionally flags a bullet that survived but shed >20% (and >=8
// chars) of its normalized length — the "still there, tail silently cut" case.
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
const norm = line => line.replace(/[`*\s]/g, '');
const bullets = text => text.split('\n').filter(l => l.startsWith('- '))
  .map(l => { const n = norm(l); return { key: n.slice(0, 30), len: n.length }; });
const allowed = k => allow.some(a => k.includes(norm(a)));
let baseline;
try {
  baseline = execFileSync('git', ['show', `${baseRef}:${oldPath}`], { encoding: 'utf8' });
} catch (e) {
  console.error(`cannot read ${baseRef}:${oldPath}: ${e.message.split('\n')[0]}`);
  process.exit(2);
}
const oldBullets = bullets(baseline);
const merged = [oldPath, ...newPaths].map(p => fs.readFileSync(p, 'utf8')).join('\n');
const curLens = new Map();
for (const b of bullets(merged)) curLens.set(b.key, Math.max(curLens.get(b.key) || 0, b.len));
let exempt = 0, shrunkExempt = 0;
const missing = [], shrunk = [];
for (const b of oldBullets) {
  const curLen = curLens.get(b.key);
  if (curLen === undefined) {
    if (allowed(b.key)) { exempt++; continue; }
    missing.push(b.key);
    continue;
  }
  if (curLen < b.len * 0.8 && b.len - curLen >= 8) {
    if (allowed(b.key)) { exempt++; shrunkExempt++; continue; }
    shrunk.push({ key: b.key, baseLen: b.len, curLen, pct: Math.round((1 - curLen / b.len) * 100) });
  }
}
console.log(`base bullets: ${oldBullets.length}`);
console.log(`current bullets: ${curLens.size}`);
if (missing.length || shrunk.length) {
  for (const k of missing) console.log(`MISSING: ${k}`);
  for (const s of shrunk) console.log(`SHRUNK: ${s.key} (base ${s.baseLen} → current ${s.curLen}, -${s.pct}%)`);
  console.log('deliberate rewrite or intentional trim? re-run with --allow=<substring of the key>');
  process.exit(1);
}
console.log(`OK 守恒（豁免 ${exempt} 条${shrunkExempt ? `，其中缩水豁免 ${shrunkExempt} 条` : ''}）`);
