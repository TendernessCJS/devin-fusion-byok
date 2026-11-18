'use strict';
const http = require('node:http');
const https = require('node:https');
// @vscode/proxy-agent patches http(s).request/get in the extension host and can
// drop our CONNECT createConnection; ClientRequest stays public and unpatched.
// `_defaultAgent` mirrors what http.request/https.request inject: the agent
// protocol check compares the effective agent against it. A constructor
// failure must not switch the request to the host's transport.
const createRequest = (secure, options, callback) =>
  new http.ClientRequest({ _defaultAgent: (secure ? https : http).globalAgent, ...options }, callback);
module.exports = { createRequest };
