'use strict';
const http = require('node:http');
const https = require('node:https');
// @vscode/proxy-agent patches http(s).request/get in the extension host and can
// drop our CONNECT createConnection; ClientRequest stays public and unpatched.
// `_defaultAgent` mirrors what http.request/https.request inject: the agent
// protocol check compares the effective agent against it. The fallback only
// covers a future runtime renaming or revalidating the constructor.
const createRequest = (secure, options, callback) => {
  try { return new http.ClientRequest({ _defaultAgent: (secure ? https : http).globalAgent, ...options }, callback); }
  catch { return (secure ? https : http).request(options, callback); }
};
module.exports = { createRequest };
