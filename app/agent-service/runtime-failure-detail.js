"use strict";

const { redactDiagnostic } = require("./codex-rpc-safety");

// Only call with a protocol/native error field, never assistant/tool prose or a
// whole request/log. This small display record carries no stack, headers or body.
function runtimeFailureDetail(value, registeredSecrets = []) {
  try {
    if (typeof value === "string") value = { message: value };
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const own = (object, key) => Object.getOwnPropertyDescriptor(object || {}, key)?.value;
    let message = own(value, "message");
    let status = own(value, "httpStatus") ?? own(value, "statusCode") ?? own(value, "status");
    const codexErrorInfo = own(value, "codexErrorInfo");
    for (const variant of ["httpConnectionFailed", "responseStreamConnectionFailed",
      "responseStreamDisconnected", "responseTooManyFailedAttempts"]) {
      status ??= own(own(codexErrorInfo, variant), "httpStatusCode");
    }
    let code = own(value, "upstreamCode") ?? own(value, "code");
    const nested = own(value, "error");
    if (nested && typeof nested === "object") {
      message = own(nested, "message") ?? message;
      code = own(nested, "code") ?? own(nested, "status") ?? code;
    }
    if (typeof message !== "string" || !message.isWellFormed() || message.includes("\0")
      || Buffer.byteLength(message) > 64 * 1024) return null;
    // Some providers put the JSON error envelope in the message string. Select
    // its error fields; do not display the rest of the response/request object.
    if (/^\s*\{/u.test(message)) {
      try {
        const parsed = JSON.parse(message), error = parsed.error ?? parsed;
        if (typeof error?.message !== "string") return null;
        message = error.message;
        status = status ?? error.statusCode ?? (typeof error.code === "number" ? error.code : undefined);
        code = error.status ?? error.code ?? code;
      } catch { return null; }
    }
    const api = /\bError (\d{3}), Message: ([\s\S]*?), Status: ([A-Z][A-Z_]+)(?:,|$)/u.exec(message);
    if (api) { status = Number(api[1]); message = api[2]; code = api[3]; }
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      const match = /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?: code)?)\s*[:=]?\s*([45]\d\d)\b/iu.exec(message);
      status = match ? Number(match[1]) : undefined;
    }
    message = message.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu, "[已隐藏]")
      .split(/\r?\n\s*(?:Traceback\b|Stack trace\b|at\s+\S+|File\s+")/u)[0]
      .replace(/\bhttps?:\/\/[^\s<>"']+/giu, url => {
        try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}${parsed.pathname}`; }
        catch { return "[地址已隐藏]"; }
      })
      .replace(/(?:\b(?:[\w-]*token|api[_-]?key|secret|password|authorization|cookie|set-cookie)\b["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\n,;}]+)/giu, "[已隐藏]")
      .replace(/\b(?:Bearer|Basic)\s+\S+/giu, "[已隐藏]")
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, "[邮箱已隐藏]")
      .replace(/\/(?:Users|home)\/[^\s,;)'"<>]+/gu, "[路径已隐藏]")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "")
      .trim();
    message = redactDiagnostic(message, registeredSecrets);
    if (!message) return null;
    if (Buffer.byteLength(message) > 1200) message = Buffer.from(message).subarray(0, 1190).toString("utf8").replace(/\uFFFD+$/u, "") + "…";
    const safeCode = typeof code === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(code)
      && redactDiagnostic(code, registeredSecrets) === code ? code : undefined;
    return { message, ...(status ? { httpStatus: status } : {}), ...(safeCode ? { upstreamCode: safeCode } : {}) };
  } catch { return null; }
}

function failureDetailText(value, label = "上游原因") {
  const detail = runtimeFailureDetail(value);
  if (!detail) return "";
  const codes = [detail.httpStatus ? `HTTP ${detail.httpStatus}` : null, detail.upstreamCode].filter(Boolean);
  return `${label}：${detail.message}${codes.length ? `\n${codes.join(" · ")}` : ""}`;
}

function runtimeFailureFromError(error) {
  try {
    for (let depth = 0; error && typeof error === "object" && depth < 8; depth++) {
      const detail = runtimeFailureDetail(Object.getOwnPropertyDescriptor(error, "failure")?.value);
      if (detail) return detail;
      error = Object.getOwnPropertyDescriptor(error, "cause")?.value;
    }
  } catch { /* Diagnostics must not replace the actual operational error. */ }
  return null;
}

module.exports = { runtimeFailureDetail, runtimeFailureFromError, failureDetailText };
