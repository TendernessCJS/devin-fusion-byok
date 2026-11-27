'use strict';

// /models commonly reports IDs only. Keep provider-specific overrides explicit;
// use the standard GPT/o reasoning controls only for recognizable base IDs.
// The mode alone decides where tiers come from, so each refinement is only
// read by the mode that shows it in the panel. A config without the key keeps
// the legacy "a list means manual" reading so older entries stay intact.
function modelEfforts(model) {
  const mode = model.effortMode || (Array.isArray(model.efforts) && model.efforts.length ? 'manual' : 'auto');
  if (mode === 'none') return [null];
  if (mode === 'manual') {
    const list = Array.isArray(model.efforts) ? [...new Set(model.efforts)] : [];
    return list.length ? list : [null];
  }
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
