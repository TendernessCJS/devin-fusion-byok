'use strict';
// Single source for the local runtime address. The extension host and the
// backend process both derive the emitted inference URL from it, so the value
// that routes inference never exists as a second, independently persisted copy
// in config.json — a copy that could drift from the port being listened on.
const PORT = 39842;
const BACKEND_URL = 'http://127.0.0.1:' + PORT;
module.exports = { PORT, BACKEND_URL };
