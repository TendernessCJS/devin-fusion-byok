'use strict';

// /models commonly reports IDs only. Keep provider-specific overrides explicit;
// use the standard GPT/o reasoning controls only for recognizable base IDs.
function modelEfforts(model) {
  if (model.effortMode === 'none') return [null];
  if (Array.isArray(model.efforts) && model.efforts.length) return [...new Set(model.efforts)];
  if (model.effortMode === 'manual') return [null];
  // A discovery-derived or explicitly set capability always wins; the id
  // heuristics below are only the last resort for providers whose /models
  // listing reports nothing but ids.
  if (model.reasoningEffort === false) return [null];
  if (model.reasoningEffort === true) return [null, 'low', 'medium', 'high', 'xhigh', 'max'];
  const id = String(model.id || '').split('/').at(-1);
  // Non-reasoning variants of a reasoning family (mini/nano/chat/...) never
  // gain efforts from the family-shaped id alone.
  if (/(?:^|[-. ])(?:mini|nano|chat|preview|instruct)(?:$|[-. ])/i.test(id)) return [null];
  if (/^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/i.test(id) &&
      !/(?:^|-)(?:none|minimal|low|medium|high|xhigh|max|ultra)(?:-|$)/i.test(id)) {
    // The null variant retains previously saved UIDs and provider-default behavior.
    return [null, 'low', 'medium', 'high', 'xhigh', 'max'];
  }
  // Claude Opus/Sonnet/Fable 4.6+ accept output_config.effort; Haiku does not.
  if (/^claude-(?:opus|sonnet|fable|mythos)-(?:[5-9]|4-[6-9])(?:[-.]|$)/i.test(id)) return [null, 'low', 'medium', 'high', 'xhigh', 'max'];
  return [null];
}

function modelSupportsImages(model) {
  return true;
}

module.exports = { modelEfforts, modelSupportsImages };
