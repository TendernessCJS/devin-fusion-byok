'use strict';

// Persistent record of providers that answered a cache_control breakpoint
// with HTTP 400 and recovered only after the marker was stripped. Keyed by a
// hash of [id, baseUrl] so neither an apiKey nor the endpoint host ever lands
// in the state file; a missing or corrupt file reads back as empty state.

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const MAX_UNSUPPORTED = 32;

function providerKey(provider) {
  return createHash('sha256').update(JSON.stringify([provider.id || '', provider.baseUrl || ''])).digest('hex');
}

function createCacheSupport({ root }) {
  const file = path.join(root, 'provider-cache.json');
  const load = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data?.version !== 1 || !data.unsupported || typeof data.unsupported !== 'object' || Array.isArray(data.unsupported)) return {};
      return data.unsupported;
    } catch { return {}; }
  };
  const malformed = provider => !provider || typeof provider !== 'object' || (!provider.id && !provider.baseUrl);
  return {
    enabledFor(provider) {
      if (malformed(provider)) return true;
      return !Object.hasOwn(load(), providerKey(provider));
    },
    disable(provider) {
      if (malformed(provider)) return;
      const unsupported = load();
      const key = providerKey(provider);
      if (Object.hasOwn(unsupported, key)) return;
      unsupported[key] = { at: Math.floor(Date.now() / 1000), reason: '400' };
      const entries = Object.entries(unsupported);
      while (entries.length > MAX_UNSUPPORTED) {
        let oldest = 0;
        for (let index = 1; index < entries.length; index++) {
          if ((entries[index][1]?.at ?? 0) < (entries[oldest][1]?.at ?? 0)) oldest = index;
        }
        entries.splice(oldest, 1);
      }
      const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, unsupported: Object.fromEntries(entries) }), { mode: 0o600 });
        fs.renameSync(temporary, file);
      } catch { fs.rmSync(temporary, { force: true }); }
    },
  };
}

module.exports = { createCacheSupport };
