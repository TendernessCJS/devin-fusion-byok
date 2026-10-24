#!/usr/bin/env node
// Read-only contract-drift snapshot for release evidence. Reuses the probe's
// artifacts/marker tables — never writes, never touches caches.
const fs = require('node:fs');
const { REQUIRED, INFORMATIONAL, artifacts, sha256, scanMarkers } =
  require('../src/activation/native-contract.cjs');

const DEFAULT_EXT = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf';
const KEYS = ['cli', 'ls', 'desktop', 'chat'];
const NAMES = { cli: 'CLI 二进制', ls: 'LS 二进制', desktop: '桌面主 bundle', chat: '聊天 bundle' };

function usage() {
  console.error('usage: node scripts/native-contract-report.cjs [--extension-path=<abs>] [--json]');
  process.exit(2);
}
function missingAdd(report, key, marker) {
  (report.missing[key] = report.missing[key] || []).push(marker);
}
const args = process.argv.slice(2);
let extensionPath = DEFAULT_EXT, json = false;
for (const arg of args) {
  if (arg === '--json') json = true;
  else if (arg.startsWith('--extension-path=')) extensionPath = arg.slice('--extension-path='.length);
  else usage();
}
if (!fs.existsSync(extensionPath)) usage();

(async () => {
  const files = artifacts(extensionPath);
  const report = { version: null, artifacts: {}, missing: {}, informational: {}, status: 'ok' };
  try {
    const plist = fs.readFileSync(files.plist, 'utf8');
    report.version = (plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/) || [])[1] || null;
  } catch {}
  for (const key of KEYS) {
    const entry = { role: NAMES[key], path: files[key], exists: false, bytes: null, sha256: null, required: {}, informational: {} };
    try {
      const st = fs.statSync(files[key]);
      entry.exists = st.isFile(); entry.bytes = st.size;
    } catch {}
    if (entry.exists) {
      entry.sha256 = await sha256(files[key]);
      const found = await scanMarkers(files[key], [...REQUIRED[key], ...INFORMATIONAL[key]]);
      for (const m of REQUIRED[key]) entry.required[m] = found.has(m) ? 'hit' : 'missing';
      for (const m of INFORMATIONAL[key]) entry.informational[m] = found.has(m) ? 'hit' : 'missing';
    }
    report.artifacts[key] = entry;
  }
  for (const key of KEYS) {
    const entry = report.artifacts[key];
    const reqMiss = REQUIRED[key].filter(m => entry.required[m] === 'missing');
    if ((key === 'cli' || key === 'ls') && !entry.exists) { report.status = 'unavailable'; report.code = 'artifact-missing'; break; }
    if (!entry.exists) missingAdd(report, key, 'artifact-missing');
    if (reqMiss.length) reqMiss.forEach(m => missingAdd(report, key, m));
    const infoMiss = INFORMATIONAL[key].filter(m => entry.informational[m] === 'missing');
    if (infoMiss.length) report.informational[key] = infoMiss;
  }
  if (report.status === 'ok' && Object.keys(report.missing).length) report.status = 'drift';
  if (json) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
  console.log(`Devin ${report.version || '?'} — contract report (${new Date().toISOString()})`);
  for (const key of KEYS) {
    const e = report.artifacts[key];
    console.log(`\n${e.role}: ${e.path}`);
    if (!e.exists) { console.log('  missing'); continue; }
    console.log(`  ${e.bytes} B  sha256 ${e.sha256.slice(0, 16)}…`);
    for (const [m, r] of Object.entries(e.required)) console.log(`  required      ${r === 'hit' ? '✓' : '✗ MISSING'}  ${m}`);
    for (const [m, r] of Object.entries(e.informational)) console.log(`  informational ${r === 'hit' ? '✓' : '✗ absent'}  ${m}`);
  }
  console.log(`\nverdict: ${report.status}${report.code ? ' (' + report.code + ')' : ''}`);
  process.exit(0);
})().catch(e => { console.error('probe failed:', e.message); process.exit(1); });
