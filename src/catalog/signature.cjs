'use strict';
const crypto = require('node:crypto');

// Content identity of what the extension emits into a native catalog: the raw
// emitted model entries plus both hidden sets, all in a stable order so two
// equal catalogs produce the same signature. It deliberately contains no
// timestamps, counters or provider secrets — the value is published in
// diagnostics events and compared against hook-confirmed signatures.
function catalogSignature(catalog) {
  const raws = (catalog?.models || []).map(model =>
    Buffer.isBuffer(model.raw) ? model.raw.toString('hex') : JSON.stringify(model?.json ?? model?.uid ?? ''));
  raws.sort();
  return crypto.createHash('sha256').update(JSON.stringify([
    raws,
    [...(catalog?.hiddenNativeModelUids || [])].map(String).sort(),
    [...(catalog?.hiddenFusionUids || [])].map(String).sort(),
  ])).digest('hex').slice(0, 16);
}

module.exports = { catalogSignature };
