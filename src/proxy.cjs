'use strict';
// Compatibility facade for already-installed copies and acceptance scripts
// that resolve these helpers from src/proxy.cjs; production code should
// require the new paths directly.
const { parseProxy, maskProxy } = require('./update/proxy-config.cjs');
const { tunnel, proxyRequestBytes } = require('./update/proxy-transport.cjs');
const { directFetch } = require('./network/direct-fetch.cjs');
module.exports = { parseProxy, maskProxy, tunnel, proxyRequestBytes, directFetch };
