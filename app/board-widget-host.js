"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const { isUtf8 } = require("node:buffer");

const BOARD_WIDGET_TICKET_TTL_MS = 30_000;
const BOARD_WIDGET_READY_TTL_MS = 10_000;
const BOARD_WIDGET_MAX_TICKETS = 128;
const BOARD_WIDGET_MAX_HTML_BYTES = 262_144;
const BOARD_WIDGET_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const BOARD_WIDGET_PATH_PREFIX = "/v1/board-widget/";
const BOARD_WIDGET_BRIDGE_TYPES = Object.freeze({
  bootstrap: "shoggoth:board-widget-bootstrap",
  connect: "shoggoth:board-widget-connect",
  ready: "ready",
  height: "height",
  theme: "theme",
});
const INNER_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "clipboard-read=()",
  "clipboard-write=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=()",
  "gamepad=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "idle-detection=()",
  "local-fonts=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "storage-access=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

function hostError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, required, optional = []) {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function safeText(value, maxBytes) {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && value.isWellFormed()
    && !/[\p{Cc}\p{Cf}]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : null;
}

function normalizeUiOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return value === parsed.origin
      && parsed.protocol === "http:"
      && parsed.hostname === "127.0.0.1"
      && /^[1-9]\d{0,4}$/u.test(parsed.port)
      && Number(parsed.port) <= 65_535
      && !parsed.username
      && !parsed.password
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

function normalizeOwner(value) {
  if (Number.isSafeInteger(value) && value > 0) return `number:${value}`;
  const text = safeText(value, 1024);
  return text ? `string:${text}` : null;
}

function normalizeScope(value) {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && value.isWellFormed()
    && !/[\u0001-\u001f\u007f-\u009f\p{Cf}]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= 8192
    ? value
    : null;
}

function normalizeIdentity(value) {
  if (!hasExactKeys(value, [
    "backend", "agentId", "sessionKey", "boardRevision", "viewGeneration",
    "name", "revision", "instanceId",
  ])) return null;
  const backend = typeof value.backend === "string"
    && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value.backend) ? value.backend : null;
  const agentId = safeText(value.agentId, 256);
  const sessionKey = safeText(value.sessionKey, 4096);
  const boardRevision = Number.isSafeInteger(value.boardRevision) && value.boardRevision >= 0
    ? value.boardRevision : null;
  const viewGeneration = typeof value.viewGeneration === "string"
    && /^[a-f0-9]{32}$/u.test(value.viewGeneration) ? value.viewGeneration : null;
  const name = typeof value.name === "string"
    && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value.name) ? value.name : null;
  const revision = Number.isSafeInteger(value.revision) && value.revision >= 1
    ? value.revision : null;
  const instanceId = safeText(value.instanceId, 1024);
  if (!backend || !agentId || /[:\\/]/u.test(agentId) || !sessionKey
    || boardRevision === null || !viewGeneration || viewGeneration !== instanceId
    || !name || revision === null || !instanceId) {
    return null;
  }
  return Object.freeze({
    backend,
    agentId,
    sessionKey,
    boardRevision,
    viewGeneration,
    name,
    revision,
    instanceId,
  });
}

function decodeCanonicalBase64url(value, bytes) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === bytes && decoded.toString("base64url") === value ? decoded : null;
  } catch {
    return null;
  }
}

function secureNonceEqual(expected, supplied) {
  const decoded = decodeCanonicalBase64url(supplied, 24);
  if (!decoded) return false;
  try {
    return crypto.timingSafeEqual(expected, decoded);
  } finally {
    decoded.fill(0);
  }
}

function rawHeaderValues(req, name) {
  const values = [];
  const wanted = name.toLowerCase();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (String(req.rawHeaders[index]).toLowerCase() === wanted) {
      values.push(String(req.rawHeaders[index + 1] || ""));
    }
  }
  return values;
}

function exactHeader(req, name) {
  const values = rawHeaderValues(req, name);
  return values.length === 1 ? values[0] : null;
}

function hasHeader(req, name) {
  return rawHeaderValues(req, name).length > 0;
}

function referrerMatches(value, uiOrigin) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.origin === uiOrigin && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function buildOuterShell(html, nonce, uiOrigin) {
  const encodedHtml = html.toString("base64");
  const bridge = JSON.stringify(BOARD_WIDGET_BRIDGE_TYPES);
  const innerCsp = JSON.stringify(INNER_CONTENT_SECURITY_POLICY);
  const innerCspMeta = JSON.stringify(
    `<meta http-equiv="Content-Security-Policy" content="${INNER_CONTENT_SECURITY_POLICY}">`,
  );
  return Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body,#root{box-sizing:border-box;width:100%;height:100%;margin:0;overflow:hidden;background:transparent}*,*::before,*::after{box-sizing:inherit}iframe{display:block;width:100%;height:100%;border:0;background:transparent}</style></head>
<body><div id="root"></div>
<script>"use strict";(()=>{
const nonce=${JSON.stringify(nonce)};
const uiOrigin=${JSON.stringify(uiOrigin)};
const types=${bridge};
const innerCsp=${innerCsp};
const innerCspMeta=${innerCspMeta};
const root=document.getElementById("root");
const frame=document.createElement("iframe");
frame.id="widget";
frame.title="Session Board widget";
frame.setAttribute("sandbox","");
frame.setAttribute("allow","");
frame.setAttribute("csp",innerCsp);
frame.referrerPolicy="no-referrer";
let armed=false;
let loaded=false;
let ready=false;
let control=null;
let theme={mode:"light",tokens:{}};
let pendingHeight=null;
const closePorts=(event)=>{for(const port of event.ports||[]){try{port.close();}catch{}}};
const exact=(value,keys)=>{if(!value||typeof value!=="object"||Array.isArray(value))return false;const own=Object.keys(value).sort();return own.length===keys.length&&own.every((key,index)=>key===keys[index]);};
const validTheme=(value)=>{
  if(!exact(value,["mode","tokens"])||(value.mode!=="light"&&value.mode!=="dark")||!value.tokens||typeof value.tokens!=="object"||Array.isArray(value.tokens))return false;
  const entries=Object.entries(value.tokens);
  return entries.length<=32&&entries.every(([key,item])=>/^[a-z][a-z0-9-]{0,63}$/.test(key)&&typeof item==="string"&&item.length<=256&&!Array.from(item).some((char)=>{const code=char.codePointAt(0);return code<=31||code===127;}));
};
const sendTheme=()=>{if(!loaded)return;try{frame.contentWindow.postMessage({type:types.theme,mode:theme.mode,tokens:theme.tokens},"*");}catch{}};
const sendReady=()=>{if(!loaded||!control||ready)return;ready=true;sendTheme();control.postMessage({type:types.ready,nonce});if(pendingHeight!==null){control.postMessage({type:types.height,height:pendingHeight});pendingHeight=null;}};
const connect=(event)=>{
  const value=event.data;
  const valid=event.source===window.parent&&event.origin===uiOrigin&&event.ports.length===1&&exact(value,["nonce","theme","type"])&&value.type===types.connect&&value.nonce===nonce&&validTheme(value.theme);
  if(!valid||control){closePorts(event);return;}
  control=event.ports[0];
  theme={mode:value.theme.mode,tokens:{...value.theme.tokens}};
  document.documentElement.dataset.theme=theme.mode;
  control.onmessage=(portEvent)=>{
    closePorts(portEvent);
    const next=portEvent.data;
    if(!exact(next,["mode","tokens","type"])||next.type!==types.theme||!validTheme({mode:next.mode,tokens:next.tokens}))return;
    theme={mode:next.mode,tokens:{...next.tokens}};
    document.documentElement.dataset.theme=theme.mode;
    sendTheme();
  };
  control.start();
  sendReady();
};
window.addEventListener("message",(event)=>{
  if(event.source===window.parent){connect(event);return;}
  closePorts(event);
  const value=event.data;
  if(event.source!==frame.contentWindow||event.origin!=="null"||!exact(value,["height","type"])||value.type!==types.height)return;
  if(!Number.isSafeInteger(value.height)||value.height<1||value.height>8192)return;
  if(ready&&control)control.postMessage({type:types.height,height:value.height});
  else pendingHeight=value.height;
});
frame.addEventListener("load",()=>{
  if(!armed)return;
  loaded=true;
  sendReady();
},{once:true});
window.addEventListener("pagehide",()=>{try{control?.close();}catch{}},{once:true});
try{
  let encoded=${JSON.stringify(encodedHtml)};
  const binary=atob(encoded);
  const bytes=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index+=1)bytes[index]=binary.charCodeAt(index);
  frame.srcdoc=innerCspMeta+new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  bytes.fill(0);
  encoded="";
  armed=true;
  root.append(frame);
  window.parent.postMessage({type:types.bootstrap,nonce},uiOrigin);
}catch{
  try{control?.close();}catch{}
  try{frame.remove();}catch{}
}
})();</script></body></html>`, "utf8");
}

class BoardWidgetHost {
  constructor(options = {}) {
    const uiOrigin = normalizeUiOrigin(options.uiOrigin);
    if (!uiOrigin) {
      throw hostError("BOARD_WIDGET_HOST_OPTIONS_INVALID", "Board Widget host UI origin is invalid");
    }
    this.uiOrigin = uiOrigin;
    this.now = options.now || Date.now;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    if (typeof this.now !== "function" || typeof this.randomBytes !== "function"
      || typeof this.setTimer !== "function" || typeof this.clearTimer !== "function") {
      throw hostError("BOARD_WIDGET_HOST_OPTIONS_INVALID", "Board Widget host options are invalid");
    }
    this.records = new Map();
    this.totalBytes = 0;
    this.server = null;
    this.port = null;
    this.origin = null;
    this.startPromise = null;
    this.closePromise = null;
    this.closed = false;
  }

  start() {
    if (this.closed) {
      return Promise.reject(hostError("BOARD_WIDGET_HOST_CLOSED", "Board Widget host is closed"));
    }
    if (this.startPromise) return this.startPromise;
    const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
      this.#handleRequest(req, res);
    });
    server.maxHeadersCount = 32;
    server.headersTimeout = 5_000;
    server.requestTimeout = 5_000;
    server.keepAliveTimeout = 1_000;
    server.on("clientError", (_error, socket) => {
      try {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      } catch {
        try { socket.destroy(); } catch {}
      }
    });
    this.server = server;
    this.startPromise = new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener("listening", onListening);
        this.server = null;
        this.startPromise = null;
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        const address = server.address();
        if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
          server.close();
          this.server = null;
          this.startPromise = null;
          reject(hostError("BOARD_WIDGET_HOST_LISTEN_FAILED", "Board Widget host did not bind loopback"));
          return;
        }
        this.port = address.port;
        this.origin = `http://127.0.0.1:${address.port}`;
        resolve(Object.freeze({ origin: this.origin, port: this.port }));
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    return this.startPromise;
  }

  issue(input = {}) {
    if (!this.server?.listening || !this.origin || this.closed) {
      throw hostError("BOARD_WIDGET_HOST_NOT_READY", "Board Widget host is not ready");
    }
    if (!hasExactKeys(input, ["owner", "scope", "html", "identity"])) {
      throw hostError("BOARD_WIDGET_HOST_INPUT_INVALID", "Board Widget ticket input is invalid");
    }
    const ownerKey = normalizeOwner(input.owner);
    const scope = normalizeScope(input.scope);
    const identity = normalizeIdentity(input.identity);
    if (!ownerKey || !scope || !identity || !Buffer.isBuffer(input.html)) {
      throw hostError("BOARD_WIDGET_HOST_INPUT_INVALID", "Board Widget ticket input is invalid");
    }
    const html = Buffer.from(input.html);
    if (html.length > BOARD_WIDGET_MAX_HTML_BYTES || !isUtf8(html)) {
      html.fill(0);
      throw hostError("BOARD_WIDGET_HOST_INPUT_INVALID", "Board Widget HTML is invalid");
    }
    if (this.records.size >= BOARD_WIDGET_MAX_TICKETS
      || this.totalBytes + html.length > BOARD_WIDGET_MAX_TOTAL_BYTES) {
      html.fill(0);
      throw hostError("BOARD_WIDGET_HOST_CAPACITY", "Board Widget host is at capacity");
    }

    let ticketBytes;
    let nonceBytes;
    try {
      ticketBytes = this.randomBytes(32);
      nonceBytes = this.randomBytes(24);
      if (!Buffer.isBuffer(ticketBytes) || ticketBytes.length !== 32
        || !Buffer.isBuffer(nonceBytes) || nonceBytes.length !== 24) {
        throw new Error("invalid randomness");
      }
      const ticket = ticketBytes.toString("base64url");
      const nonce = nonceBytes.toString("base64url");
      ticketBytes.fill(0);
      ticketBytes = null;
      if (this.records.has(ticket)) {
        throw hostError("BOARD_WIDGET_HOST_COLLISION", "Board Widget ticket collision");
      }
      const expiresAt = this.now() + BOARD_WIDGET_TICKET_TTL_MS;
      if (!Number.isSafeInteger(expiresAt)) {
        throw hostError("BOARD_WIDGET_HOST_CLOCK_INVALID", "Board Widget host clock is invalid");
      }
      const record = {
        state: "issued",
        ownerKey,
        scope,
        html,
        htmlBytes: html.length,
        nonce: nonceBytes,
        identity,
        expiresAt,
        timer: null,
      };
      record.timer = this.setTimer(() => this.#revokeRecord(ticket), BOARD_WIDGET_TICKET_TTL_MS);
      record.timer?.unref?.();
      this.records.set(ticket, record);
      this.totalBytes += html.length;
      return Object.freeze({
        ticket,
        nonce,
        url: `${this.origin}${BOARD_WIDGET_PATH_PREFIX}${ticket}`,
        expiresAt,
        identity,
      });
    } catch (error) {
      ticketBytes?.fill?.(0);
      nonceBytes?.fill?.(0);
      html.fill(0);
      if (error?.code?.startsWith?.("BOARD_WIDGET_HOST_")) throw error;
      throw hostError("BOARD_WIDGET_HOST_RANDOM_FAILED", "Board Widget ticket issuance failed");
    }
  }

  markReady(input = {}) {
    if (!hasExactKeys(input, ["ticket", "nonce", "owner", "scope"])) return false;
    const ticketBytes = decodeCanonicalBase64url(input.ticket, 32);
    const ownerKey = normalizeOwner(input.owner);
    const scope = normalizeScope(input.scope);
    if (!ticketBytes || !ownerKey || !scope) {
      ticketBytes?.fill(0);
      return false;
    }
    ticketBytes.fill(0);
    const record = this.records.get(input.ticket);
    if (!record || record.state !== "claimed" || record.ownerKey !== ownerKey
      || record.scope !== scope || this.now() >= record.expiresAt
      || !secureNonceEqual(record.nonce, input.nonce)) {
      if (record?.state === "claimed" && this.now() >= record.expiresAt) {
        this.#revokeRecord(input.ticket);
      }
      return false;
    }
    this.clearTimer(record.timer);
    record.timer = null;
    this.#releasePayload(record);
    record.state = "active";
    record.identity = null;
    delete record.expiresAt;
    return true;
  }

  revokeTicket(ticket) {
    const decoded = decodeCanonicalBase64url(ticket, 32);
    if (!decoded) return 0;
    decoded.fill(0);
    return this.#revokeRecord(ticket) ? 1 : 0;
  }

  revokeOwner(owner) {
    const ownerKey = normalizeOwner(owner);
    if (!ownerKey) return 0;
    let revoked = 0;
    for (const [ticket, record] of this.records) {
      if (record.ownerKey === ownerKey && this.#revokeRecord(ticket)) revoked += 1;
    }
    return revoked;
  }

  revokeScope(owner, scope) {
    const ownerKey = normalizeOwner(owner);
    const normalizedScope = normalizeScope(scope);
    if (!ownerKey || !normalizedScope) return 0;
    let revoked = 0;
    for (const [ticket, record] of this.records) {
      if (record.ownerKey === ownerKey && record.scope === normalizedScope
        && this.#revokeRecord(ticket)) revoked += 1;
    }
    return revoked;
  }

  revokeAll() {
    let revoked = 0;
    for (const ticket of [...this.records.keys()]) {
      if (this.#revokeRecord(ticket)) revoked += 1;
    }
    return revoked;
  }

  stats() {
    const states = { issued: 0, claimed: 0, active: 0 };
    for (const record of this.records.values()) states[record.state] += 1;
    return Object.freeze({ tickets: this.records.size, bytes: this.totalBytes, ...states });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.revokeAll();
    const server = this.server;
    this.server = null;
    this.port = null;
    this.origin = null;
    if (!server?.listening) {
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    this.closePromise = new Promise((resolve) => {
      server.close(() => resolve());
      try { server.closeAllConnections(); } catch {}
    });
    return this.closePromise;
  }

  #contentSecurityPolicy() {
    return [
      "sandbox allow-scripts",
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src data:",
      "connect-src 'none'",
      "font-src 'none'",
      "media-src 'none'",
      "worker-src 'none'",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${this.uiOrigin}`,
    ].join("; ");
  }

  #responseHeaders(contentType, contentLength, cors = false) {
    return {
      "Content-Type": contentType,
      "Content-Length": contentLength,
      "Cache-Control": "no-store, max-age=0",
      "Content-Security-Policy": this.#contentSecurityPolicy(),
      "Permissions-Policy": PERMISSIONS_POLICY,
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-site",
      "Origin-Agent-Cluster": "?1",
      "X-Content-Type-Options": "nosniff",
      "X-DNS-Prefetch-Control": "off",
      Connection: "close",
      ...(cors ? { "Access-Control-Allow-Origin": this.uiOrigin, Vary: "Origin" } : {}),
    };
  }

  #sendNotFound(req, res) {
    const body = Buffer.from("Not Found", "utf8");
    res.writeHead(404, this.#responseHeaders("text/plain; charset=utf-8", body.length));
    if (req.method === "HEAD") {
      body.fill(0);
      res.end();
    } else {
      let scrubbed = false;
      const scrub = () => {
        if (scrubbed) return;
        scrubbed = true;
        body.fill(0);
      };
      res.once("finish", scrub);
      res.once("close", scrub);
      res.end(body);
    }
  }

  #sendMethodNotAllowed(req, res) {
    const body = Buffer.from("Method Not Allowed", "utf8");
    res.writeHead(405, {
      ...this.#responseHeaders("text/plain; charset=utf-8", body.length),
      Allow: "GET, HEAD",
    });
    let scrubbed = false;
    const scrub = () => {
      if (scrubbed) return;
      scrubbed = true;
      body.fill(0);
    };
    res.once("finish", scrub);
    res.once("close", scrub);
    res.end(body);
  }

  #requestTicket(req) {
    if (req.socket?.remoteAddress !== "127.0.0.1"
      || exactHeader(req, "host") !== `127.0.0.1:${this.port}`
      || hasHeader(req, "cookie")
      || hasHeader(req, "authorization")
      || hasHeader(req, "proxy-authorization")
      || hasHeader(req, "range")
      || hasHeader(req, "transfer-encoding")
      || hasHeader(req, "content-length")) return null;
    const match = new RegExp(`^${BOARD_WIDGET_PATH_PREFIX}([A-Za-z0-9_-]{43})$`, "u").exec(req.url || "");
    if (!match) return null;
    const decodedTicket = decodeCanonicalBase64url(match[1], 32);
    if (!decodedTicket) return null;
    decodedTicket.fill(0);
    if (exactHeader(req, "sec-fetch-site") !== "same-site") return null;
    const referrer = exactHeader(req, "referer");
    if (req.method === "GET") {
      if (exactHeader(req, "sec-fetch-mode") !== "navigate"
        || exactHeader(req, "sec-fetch-dest") !== "iframe"
        || !referrerMatches(referrer, this.uiOrigin)) return null;
      const origin = exactHeader(req, "origin");
      if (origin !== null && origin !== this.uiOrigin) return null;
    } else if (req.method === "HEAD") {
      if (exactHeader(req, "sec-fetch-mode") !== "cors"
        || exactHeader(req, "sec-fetch-dest") !== "empty"
        || exactHeader(req, "origin") !== this.uiOrigin
        || (referrer !== null && !referrerMatches(referrer, this.uiOrigin))) return null;
    } else {
      return null;
    }
    return match[1];
  }

  #handleRequest(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      this.#sendMethodNotAllowed(req, res);
      return;
    }
    const ticket = this.#requestTicket(req);
    if (!ticket) {
      this.#sendNotFound(req, res);
      return;
    }
    const record = this.records.get(ticket);
    if (!record || record.state !== "issued" || this.now() >= record.expiresAt) {
      if (record?.state === "issued" && this.now() >= record.expiresAt) this.#revokeRecord(ticket);
      this.#sendNotFound(req, res);
      return;
    }
    let body;
    try {
      body = buildOuterShell(record.html, record.nonce.toString("base64url"), this.uiOrigin);
    } catch {
      this.#revokeRecord(ticket);
      this.#sendNotFound(req, res);
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, this.#responseHeaders("text/html; charset=utf-8", body.length, true));
      body.fill(0);
      res.end();
      return;
    }

    this.clearTimer(record.timer);
    record.state = "claimed";
    record.expiresAt = this.now() + BOARD_WIDGET_READY_TTL_MS;
    record.timer = this.setTimer(() => this.#revokeRecord(ticket), BOARD_WIDGET_READY_TTL_MS);
    record.timer?.unref?.();
    let scrubbed = false;
    const scrub = () => {
      if (scrubbed) return;
      scrubbed = true;
      body.fill(0);
    };
    res.once("finish", scrub);
    res.once("close", () => {
      scrub();
      if (!res.writableFinished) this.#revokeRecord(ticket);
    });
    res.writeHead(200, this.#responseHeaders("text/html; charset=utf-8", body.length));
    res.end(body);
  }

  #releasePayload(record) {
    if (record.html) {
      record.html.fill(0);
      this.totalBytes -= record.htmlBytes;
      record.html = null;
      record.htmlBytes = 0;
    }
    if (record.nonce) {
      record.nonce.fill(0);
      record.nonce = null;
    }
  }

  #revokeRecord(ticket) {
    const record = this.records.get(ticket);
    if (!record) return false;
    this.records.delete(ticket);
    this.clearTimer(record.timer);
    record.timer = null;
    this.#releasePayload(record);
    record.identity = null;
    record.state = "revoked";
    return true;
  }
}

function createBoardWidgetHost(options) {
  return new BoardWidgetHost(options);
}

module.exports = {
  BOARD_WIDGET_BRIDGE_TYPES,
  BOARD_WIDGET_MAX_HTML_BYTES,
  BOARD_WIDGET_MAX_TICKETS,
  BOARD_WIDGET_MAX_TOTAL_BYTES,
  BOARD_WIDGET_READY_TTL_MS,
  BOARD_WIDGET_TICKET_TTL_MS,
  createBoardWidgetHost,
};
