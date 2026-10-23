"use strict";

// Hermes v7 asks clients with JSON-RPC request IDs, not FIFO notifications.
// Keep UI projection and response validation together; neither trusts renderer
// supplied session/kind/choices over the captured server request.
const KINDS = new Set(["approval", "clarify", "sudo", "secret"]);
const WINDOW_REQUESTS = new Set(["terminal.read", "preview.read", "preview.act", "window.read", "tour"]);
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 65536) => typeof value === "string" && value.length <= max ? value : "";
function validRequest(frame) {
  return isRecord(frame) && /^srq-[a-f0-9]{12}$/u.test(frame.id)
    && typeof frame.method === "string" && frame.method.length <= 128
    && isRecord(frame.params) && Boolean(text(frame.params.session_id, 256))
    && Buffer.byteLength(JSON.stringify(frame)) <= 128 * 1024;
}
function approvalChoices(params) {
  return Array.isArray(params.choices) ? [...new Set(params.choices.filter(choice =>
    ["once", "session", "always", "deny"].includes(choice)
    && !(choice === "session" && (params.allow_session === false || params.smart_denied === true))
    && !(choice === "always" && (params.allow_permanent === false || params.smart_denied === true))))] : ["once", "deny"];
}
function questions(params) {
  if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 8) return null;
  const seen = new Set();
  for (const q of params.questions) {
    if (!isRecord(q) || !text(q.qid, 128) || seen.has(q.qid) || !text(q.question, 16384)) return null;
    seen.add(q.qid);
  }
  return params.questions;
}
function promptForRequest(frame) {
  const p = frame.params, base = { kind: frame.method, requestId: frame.id };
  if (frame.method === "approval") {
    if (p.command !== undefined && (typeof p.command !== "string" || p.command.length > 65536)
      || p.description !== undefined && (typeof p.description !== "string" || p.description.length > 65536)) return null;
    const choices = approvalChoices(p);
    return choices.length ? { ...base, command: text(p.command), description: text(p.description), choices } : null;
  }
  if (frame.method === "sudo") return base;
  if (frame.method === "secret") return { ...base, question: text(p.prompt) || text(p.env_var) };
  if (frame.method !== "clarify") return null;
  const qs = questions(p);
  if (!qs) return null;
  const unlocked = qs.filter(q => !Object.hasOwn(p.answers || {}, q.qid));
  if (!unlocked.length) return null;
  return { ...base, question: unlocked[0].question,
    ...(unlocked.length === 1 && Array.isArray(unlocked[0].choices) ? { choices: unlocked[0].choices.filter(v => typeof v === "string") } : {}),
    questions: unlocked.map(q => ({ id: q.qid, question: q.question,
      description: Array.isArray(q.choices) ? q.choices.filter(v => typeof v === "string").join(" / ") : "", required: true })) };
}
function responseForRequest(frame, data) {
  if (data.kind !== frame.method) throw new Error("Hermes 请求类型不匹配");
  const p = frame.params;
  if (frame.method === "approval") {
    if (!approvalChoices(p).includes(data.choice)) throw new Error("Hermes 审批选项不可用");
    // Each UI response answers this exact request, never all queued approvals.
    if (data.all === true) throw new Error("Hermes 审批需要逐项确认");
    return { choice: data.choice };
  }
  if (frame.method === "sudo" || frame.method === "secret") {
    if (typeof data.value !== "string" || data.value.length > 65536) throw new Error("Hermes 请求值无效");
    return { value: data.value };
  }
  const qs = questions(p);
  if (frame.method !== "clarify" || !qs) throw new Error("Hermes 请求不受支持");
  if (data.action === "cancel") return {};
  const unlocked = qs.filter(q => !Object.hasOwn(p.answers || {}, q.qid));
  const submitted = isRecord(data.answers) ? data.answers : unlocked.length === 1 && typeof data.value === "string"
    ? { [unlocked[0].qid]: data.value } : null;
  if (!submitted || Object.keys(submitted).some(id => !qs.some(q => q.qid === id))) throw new Error("Hermes 问题答案不匹配");
  const answers = Object.create(null);
  for (const q of qs) {
    if (Object.hasOwn(p.answers || {}, q.qid)) {
      if (Object.hasOwn(submitted, q.qid) && submitted[q.qid] !== p.answers[q.qid]) throw new Error("Hermes 已确认答案不能修改");
      answers[q.qid] = p.answers[q.qid];
    } else {
      if (typeof submitted[q.qid] !== "string" || submitted[q.qid].length > 65536) throw new Error("Hermes 问题答案不完整");
      answers[q.qid] = submitted[q.qid];
    }
  }
  return { answers };
}
module.exports = { KINDS, WINDOW_REQUESTS, validRequest, promptForRequest, responseForRequest };
