'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Persisted record of catalog-shaped RPC methods the LS bridge saw but the
// CATALOG whitelist does not know: method name and timestamp only — never a
// host, header or body. This is an observation record, not an input: nothing
// may act on it to degrade or admit traffic automatically.
function recordUnknownCatalog(root, rpc, { limit = 50 } = {}) {
  try {
    const method = String(rpc).slice(0, 120);
    const file = path.join(root, 'catalog-unknown.json');
    let entries = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) entries = parsed;
    } catch {}
    entries = entries.filter(entry => entry && entry.rpc !== method);
    entries.push({ at: new Date().toISOString(), rpc: method });
    if (entries.length > limit) entries = entries.slice(entries.length - limit);
    fs.writeFileSync(file, JSON.stringify(entries));
  } catch {}
}
module.exports = { recordUnknownCatalog };
