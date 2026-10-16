'use strict';
const { token, usageIsInconsistent, identifier } = require('../monitor-stats.cjs');

function usageOf(data, chat) {
  const u = chat ? data?.usage : data?.response?.usage;
  if (!u || typeof u !== 'object') return null;
  return {
    inputTokens: token(chat ? u.prompt_tokens : u.input_tokens),
    outputTokens: token(chat ? u.completion_tokens : u.output_tokens),
    cachedTokens: token((chat ? u.prompt_tokens_details : u.input_tokens_details)?.cached_tokens ?? u.prompt_cache_hit_tokens),
    reasoningTokens: token((chat ? u.completion_tokens_details : u.output_tokens_details)?.reasoning_tokens)
  };
}
function semanticOutput(event, chat) {
  const d = event.data;
  if (!d) return { output: false, text: false };
  if (chat) {
    const choice = (d.choices || []).find(c => (c.index ?? 0) === 0);
    const delta = choice?.delta || choice?.message;
    const text = (typeof delta?.content === 'string' && delta.content.length > 0)
      || (typeof delta?.refusal === 'string' && delta.refusal.length > 0);
    const thinking = [delta?.reasoning_content, delta?.reasoning].some(v => typeof v === 'string' && v.length > 0);
    const tool = delta?.tool_calls?.some(v => v.function?.name || v.function?.arguments);
    return { output: Boolean(text || thinking || tool), text };
  }
  const items = event.type === 'response.completed' ? d.response?.output || [] : event.type === 'response.output_item.done' ? [d.item] : [];
  const text = (event.type === 'response.output_text.delta' && typeof d.delta === 'string' && d.delta.length > 0) ||
    (event.type === 'response.output_text.done' && typeof d.text === 'string' && d.text.length > 0) ||
    (event.type === 'response.refusal.delta' && typeof d.delta === 'string' && d.delta.length > 0) ||
    (event.type === 'response.refusal.done' && typeof d.refusal === 'string' && d.refusal.length > 0) ||
    items.some(item => item?.type === 'message' && item.content?.some(part => part.type === 'output_text' && part.text));
  const delta = (['response.reasoning.delta', 'response.reasoning_summary_text.delta', 'response.reasoning_text.delta', 'response.function_call_arguments.delta'].includes(event.type) && typeof d.delta === 'string' && d.delta.length > 0)
    || (['response.reasoning_text.done', 'response.reasoning_summary_text.done'].includes(event.type) && typeof d.text === 'string' && d.text.length > 0);
  const tool = (event.type === 'response.output_item.added' && d.item?.type === 'function_call' && Boolean(d.item.name || d.item.arguments)) ||
    items.some(item => item?.type === 'function_call' && (item.name || item.arguments));
  return { output: Boolean(text || delta || tool), text: Boolean(text) };
}
function createTracker({ id, route, provider, now = () => performance.now(), startedAt = new Date().toISOString() }) {
  const start = now();
  let firstOutput = null, firstText = null, firstResponse = null, lastOutput = null, usage = null, complete = false;
  let hasTools = false, hasReasoning = false, terminalAt = null;
  const chatToolIds = new Map(), responseToolIds = new Map(), itemIndexes = new Map();
  const rememberResponseTool = (item, index) => {
    if (item?.type !== 'function_call') return;
    const key = index ?? itemIndexes.get(item.id) ?? item.id;
    if (key === undefined) return;
    if (item.id) itemIndexes.set(item.id, key);
    const next = item.call_id || item.id;
    if (next) responseToolIds.set(key, identifier(next));
  };
  return {
    event(event, chat) {
      const elapsed = now() - start;
      const data = event.data;
      if (data && event.type !== 'done') firstResponse ??= elapsed;
      const choices = chat ? data?.choices || [] : [];
      const choice = choices.find(c => (c.index ?? 0) === 0);
      const delta = choice?.delta || choice?.message;
      const items = chat ? [] : data?.response?.output || (data?.item ? [data.item] : []);
      if (delta?.tool_calls?.length || items.some(item => item?.type === 'function_call') || event.type?.startsWith('response.function_call_arguments.')) hasTools = true;
      for (const call of delta?.tool_calls || []) {
        const key = call.index ?? 0;
        if (typeof call.id !== 'string' || !call.id || chatToolIds.get(key) === null) continue;
        const joined = (chatToolIds.get(key) || '') + call.id;
        chatToolIds.set(key, identifier(joined));
      }
      if (!chat && data?.response?.output) items.forEach((item, index) => rememberResponseTool(item, index));
      else if (!chat && data?.item) rememberResponseTool(data.item, data.output_index);
      if (delta?.reasoning_content || delta?.reasoning || items.some(item => item?.type === 'reasoning') || event.type?.startsWith('response.reasoning')) hasReasoning = true;
      if (choice?.finish_reason || ['response.completed', 'response.incomplete'].includes(event.type)) terminalAt ??= elapsed;
      const semantic = semanticOutput(event, chat);
      if (semantic.output) { firstOutput ??= elapsed; lastOutput = elapsed; }
      const textDelta = chat ? typeof delta?.content === 'string' && delta.content.length > 0 : event.type === 'response.output_text.delta' && typeof data?.delta === 'string' && data.delta.length > 0;
      if (textDelta) firstText ??= elapsed;
      const next = usageOf(event.data, chat);
      if (next) {
        usage = next;
        if (usage.reasoningTokens > 0) hasReasoning = true;
        complete = usage.inputTokens !== null && usage.outputTokens !== null && !usageIsInconsistent(usage);
      }
    },
    finish(status, httpStatus, code = null) {
      const durationMs = Math.max(0, now() - start);
      const inconsistent = usageIsInconsistent(usage);
      const visibleTokens = !inconsistent && usage?.outputTokens != null && (!hasReasoning || usage?.reasoningTokens != null)
        ? usage.outputTokens - (usage.reasoningTokens ?? 0) : null;
      const decodeMs = firstText !== null && terminalAt > firstText ? terminalAt - firstText : null;
      const tps = status === 'success' && !hasTools && visibleTokens > 0 && decodeMs > 0 ? visibleTokens * 1000 / decodeMs : null;
      return { schemaVersion: 3, firstResponseMs: firstResponse, id, startedAt, model: route.model, providerId: provider.id || route.providerId || '', effort: route.effort || null,
        status, code, httpStatus, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
        cachedTokens: usage?.cachedTokens ?? null, reasoningTokens: usage?.reasoningTokens ?? null,
        firstOutputMs: firstOutput, firstTextMs: firstText, durationMs,
        outputSpanMs: firstOutput !== null && lastOutput > firstOutput ? lastOutput - firstOutput : null,
        tps, decodeMs, visibleTokens, hasTools, hasReasoning,
        throughputTps: !inconsistent && usage?.outputTokens != null && durationMs > 0 ? usage.outputTokens * 1000 / durationMs : null,
        toolIds: [...new Set([...chatToolIds.values(), ...responseToolIds.values()].map(identifier).filter(Boolean))].slice(-32),
        usageComplete: complete };
    }
  };
}
module.exports = { createTracker, usageOf, semanticOutput };
