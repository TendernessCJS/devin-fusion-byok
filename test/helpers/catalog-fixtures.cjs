'use strict';
const { buildCatalog } = require('../../src/catalog.cjs');
const { fields, s, v, m } = require('../../src/protocol/wire.cjs');

const cat = (...parts) => Buffer.concat(parts.flat());
const proto = { json: false, type: 'application/proto', framed: false };
const json = { json: true, type: 'application/json', framed: false };
const lsStatus = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const seatStatus = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';
function config() {
  return {
    providers: [{ id: 'cpa', name: 'CPA', baseUrl: 'https://private.invalid/v1', apiKey: 'secret-test-value', apiFormat: 'openai',
      models: [
        { id: 'grok-4.6', label: 'Grok 4.6', efforts: ['medium', 'high'], contextWindow: 1000000, maxOutputTokens: 32768 },
        { id: 'ws-swe-2-max', label: 'SWE-2 Max', contextWindow: 200000, maxOutputTokens: 64000 },
      ] }, { id: 'other', name: 'Other', models: [{ id: 'some-model', label: 'Some Model', contextWindow: 32000, maxOutputTokens: 64000 }] }],
    sidekicks: [{ providerId: 'cpa', model: 'ws-swe-2-max' }, { nativeUid: 'swe-2-max', label: 'SWE-2 Max' }],
  };
}
const OBSERVED_SWE = [
  { uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6', 'swe-1p5'] },
  // Routeable but never selected: the picker can still ask for it, so it
  // exercises the uid-split fallback.
  { uid: 'swe-odd', label: 'SWE Odd', disabled: false, isModelRouter: false, harnessUids: ['swe-odd-harness'] },
  { uid: 'fusion-claude-fable-5-1-medium-sidekick-swe-2-max', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 3, name: 'SWE-2 Max' } },
];
const catalog = buildCatalog(config(), OBSERVED_SWE);
const familyEntry = (model, key) => model.json.modelFamilyMetadata.entries.find(entry => entry.key === key).value;
const getNested = (buffer, ...path) => path.reduce((message, number) => fields(message, number)[0].value, buffer);
const configs = buffer => fields(buffer, 1).filter(field => field.wire === 2).map(field => field.value);

function statusFixture() {
  const native = cat(s(1, 'Official SWE'), s(22, 'swe-2-max'), m(23, cat(s(17, 'swe-2-max'), s(18, 'https://official.invalid'), s(20, 'swe-1p6'), s(20, 'swe-1p5'))), v(101, 7));
  const sort = name => cat(s(1, name), m(2, cat(s(1, 'Official Group'), s(2, 'Official SWE'), v(90, 4))), v(91, 5));
  const list = cat(m(1, native), m(2, sort('Recommended')), m(2, sort('Alphabetical')), v(88, 6));
  const status = cat(s(1, 'opaque-user-value'), v(27, 33), m(33, list), m(98, cat(v(1, 456))));
  const body = cat(v(9, 4), m(1, status), s(99, 'response-extension'));
  return { native, list, status, body };
}

const dimEntry = (order, name, controlType = 3) => m(2, cat(s(1, 'Sidekick'), m(2, cat(v(1, order), s(2, name), v(3, controlType)))));
const fam = (...entries) => m(30, cat(s(1, 'Fusion'), ...entries));
const fusionRecord = (uid, order, name, disabled = 0) =>
  cat(s(1, 'Official'), s(22, uid), v(4, disabled), m(23, cat(s(20, 'fusion'), v(25, 1))), fam(dimEntry(order, name)));

module.exports = { cat, proto, json, lsStatus, seatStatus, config, OBSERVED_SWE, catalog, familyEntry, getNested, configs, statusFixture, dimEntry, fam, fusionRecord };
