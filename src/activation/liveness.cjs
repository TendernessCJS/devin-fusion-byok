'use strict';
// Two different questions, deliberately kept apart: `live` asks whether the
// activation is still usable at all, while `superseded` asks whether work
// started under one generation must be abandoned. `superseded` does not imply
// `!live` — a disabled extension supersedes in-flight work without the
// activation being disposed — so callers that need both compose them.

function live(lifecycle, config) {
  return !lifecycle.activationDisposed && config().enabled !== false;
}

function superseded(lifecycle, config, generation) {
  return generation !== lifecycle.activationGeneration || config().enabled === false;
}

module.exports = { live, superseded };
