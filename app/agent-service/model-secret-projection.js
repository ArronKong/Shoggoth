"use strict";

// Local request transformation. This module performs no network IO, reads
// no provider credential and chooses no endpoint. Runtime integrations keep
// their existing model transport and authentication unchanged.
const { serviceError } = require("./security");
const { verifiedAttachmentTextRanges } = require("./chat-attachments");
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const fail = code => { throw serviceError(code, "模型输入的本地凭据处理未完成，内容未发送"); };
const FIXED_STRING = new Set(["role", "type", "id", "call_id", "tool_call_id", "item_id", "model", "name",
  "status", "object", "finish_reason", "reasoning_effort", "service_tier", "encoding_format", "detail"]);
const OPAQUE = new Set(["signature", "encrypted_content", "thoughtSignature", "thought_signature"]);
const CONTENT_FIELDS = new Set(["input", "messages", "contents", "system", "systemInstruction", "instructions",
  "prompt", "text", "content", "output", "arguments", "args", "parts", "description", "summary", "thinking",
  "function_call", "functionCall", "functionResponse", "tool_calls", "tools", "parameters", "input_schema", "response"]);
const DATA_FIELDS = new Set(["arguments", "args", "output", "response", "metadata", "extra_body"]);
for (const key of ["metadata", "extra_body", "response_format"]) CONTENT_FIELDS.add(key);
const MEDIA_TYPES = new Set(["image_url", "input_image", "image", "input_audio", "audio", "input_file", "document", "file"]);
const MESSAGE_LIST_FIELDS = new Set(["input", "messages", "contents"]);
const ATTACHMENT_ROLES = new Set(["user", "assistant", "model"]);

class ModelSecretProjection {
  constructor({ secrets, media, stateDir }) { this.secrets = secrets; this.media = media; this.stateDir = stateDir; }
  async project(scope, input, { signal, assertCurrent = () => {}, isTrustedOpaque = () => false } = {}) {
    if (!plain(input) || Buffer.byteLength(JSON.stringify(input)) > 64 * 1024 * 1024) fail("SECRET_MODEL_INPUT_INVALID");
    let nodes = 0;
    const redact = async text => {
      assertCurrent(); if (signal?.aborted) fail("SECRET_MODEL_CANCELED");
      const result = await this.secrets.project(scope, text);
      assertCurrent(); return result;
    };
    const projectText = async (text, attachmentPart = false) => {
      if (!attachmentPart) return redact(text);
      const ranges = verifiedAttachmentTextRanges(text, this.stateDir, scope.sessionId);
      if (!ranges.length) return redact(text);
      let offset = 0, result = "";
      for (const { start, end } of ranges) {
        result += await redact(text.slice(offset, start));
        result += text.slice(start, end);
        offset = end;
      }
      return result + await redact(text.slice(offset));
    };
    const walk = async (value, depth = 0, business = false, field = null, data = false, attachmentPart = false) => {
      if (++nodes > 100000 || depth > 48) fail("SECRET_MODEL_INPUT_INVALID");
      data ||= DATA_FIELDS.has(field);
      if (typeof value === "string") return business || data ? projectText(value, attachmentPart) : value;
      if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
      if (Array.isArray(value)) {
        const result = [];
        for (const child of value) result.push(await walk(child, depth + 1, business, field, data, attachmentPart && depth === 3));
        return result;
      }
      if (!plain(value)) fail("SECRET_MODEL_INPUT_INVALID");
      // An opaque block from old native history cannot prove it was created
      // from protected input. Do not rewrite its signature or assume that its
      // visible summary represents the encrypted contents.
      if (Object.keys(value).some(key => OPAQUE.has(key))) {
        const fields = Object.keys(value).filter(key => OPAQUE.has(key));
        if (fields.some(key => !isTrustedOpaque(key, value[key]))) fail("SECRET_MODEL_SIGNED_CONTEXT_UNSAFE");
        const visible = Object.fromEntries(Object.entries(value).filter(([key]) => !OPAQUE.has(key)));
        const projected = await walk(visible, depth + 1, business, field, data, attachmentPart);
        if (JSON.stringify(projected) !== JSON.stringify(visible)) fail("SECRET_MODEL_SIGNED_CONTEXT_UNSAFE");
        return structuredClone(value);
      }
      const typedMedia = MEDIA_TYPES.has(value.type);
      if (typedMedia || value.inlineData || value.inline_data || value.fileData || value.file_data) {
        if (attachmentPart && (typedMedia || !Object.hasOwn(value, "type"))) return structuredClone(value);
        return this.mediaBlock(scope, value, { signal, assertCurrent, projectText });
      }
      // Wire identifiers are structure; properties of tool arguments/results
      // remain user data even if a property is named role, type or name.
      if (data) {
        // Project scalar properties together so labelled numeric credentials
        // are detected. Recurse through containers to keep nested images and
        // signed blocks on their own mandatory processing path.
        const scalars = Object.fromEntries(Object.entries(value).filter(([, child]) => child === null || typeof child !== "object"));
        const result = await this.secrets.project(scope, scalars, { keys: true });
        for (const [key, child] of Object.entries(value)) {
          if (child === null || typeof child !== "object") continue;
          const projectedKey = await projectText(key);
          if (Object.hasOwn(result, projectedKey)) fail("SECRET_MODEL_INPUT_INVALID");
          Object.defineProperty(result, projectedKey, { enumerable: true, configurable: true, writable: true,
            value: await walk(child, depth + 1, true, key, true) });
        }
        return result;
      }
      const result = {};
      // Only first-class message parts carry file attachments. Tool arguments
      // and results cannot opt out by declaring a message role or media type.
      const attachmentMessage = depth === 2 && MESSAGE_LIST_FIELDS.has(field) && ATTACHMENT_ROLES.has(value.role);
      for (const [key, child] of Object.entries(value)) {
        const fixed = FIXED_STRING.has(key) && typeof child === "string";
        const selected = !fixed && (business || CONTENT_FIELDS.has(key));
        const fileContent = attachmentMessage && (key === "content" || key === "parts");
        const fileText = attachmentPart && key === "text" && [undefined, "text", "input_text", "output_text"].includes(value.type);
        Object.defineProperty(result, key, { enumerable: true, configurable: true, writable: true,
          value: await walk(child, depth + 1, selected, key, false, fileContent || fileText) });
      }
      return result;
    };
    const first = await walk(input);
    nodes = 0;
    const result = await walk(first);
    assertCurrent(); if (signal?.aborted) fail("SECRET_MODEL_CANCELED");
    return result;
  }
  async mediaBlock(scope, value, { signal, assertCurrent, projectText }) {
    const type = value.type;
    const url = typeof value.image_url === "string" ? value.image_url : value.image_url?.url;
    const dataUrl = typeof url === "string" ? /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/u.exec(url) : null;
    const inline = value.inlineData || value.inline_data;
    const fileDataUrl = typeof value.file_data === "string" ? /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/u.exec(value.file_data) : null;
    const audio = value.input_audio;
    const mimeType = dataUrl?.[1] || fileDataUrl?.[1] || inline?.mimeType || inline?.mime_type || value.source?.media_type
      || value.mimeType || (audio?.format ? `audio/${audio.format}` : undefined);
    const data = dataUrl?.[2] || fileDataUrl?.[2] || inline?.data || value.source?.data || audio?.data || value.data;
    let safe;
    if (this.media && mimeType && data) safe = await this.media.projectInline(scope, { mimeType, data }, { signal });
    assertCurrent();
    if (!safe) fail("SECRET_MEDIA_UNAVAILABLE");
    const message = safe.text || "Media attachment";
    const text = await projectText(message);
    if (safe.mimeType !== "image/png") {
      if (inline || value.fileData || value.file_data) return { text };
      return { type: ["input_image", "input_file"].includes(type) ? "input_text" : "text", text };
    }
    const encoded = safe.data.toString("base64");
    if (inline) return { inlineData: { mimeType: "image/png", data: encoded } };
    if (type === "image") return { type: "image", source: { type: "base64", media_type: "image/png", data: encoded } };
    if (type === "input_image") return { type: "input_image", image_url: `data:image/png;base64,${encoded}`, detail: value.detail || "auto" };
    return { type: "image_url", image_url: { url: `data:image/png;base64,${encoded}`, detail: value.image_url?.detail || "auto" } };
  }
}

module.exports = { ModelSecretProjection };
