"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");

const MAX_EVENT_BYTES = 48 * 1024;
const MAX_EVENT_COUNT = 1024;
const MAX_EVENT_TOTAL_BYTES = 4 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function jsonlBytes(payload) {
  return Buffer.byteLength(`${JSON.stringify(payload)}\n`);
}

function invalidEvent(message) {
  return serviceError("INVALID_EVENT", message);
}

function cloneJsonValue(value, ancestors = new Set(), location = "payload") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidEvent(`${location} 含非有限数字`);
    return value;
  }
  if (typeof value !== "object") throw invalidEvent(`${location} 含不可 JSON 编码的值`);
  if (ancestors.has(value)) throw invalidEvent(`${location} 含 circular 引用`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      let keys;
      let lengthDescriptor;
      try {
        keys = Reflect.ownKeys(value);
        lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      } catch {
        throw invalidEvent(`${location} 数组描述符不可读取`);
      }
      const length = lengthDescriptor
        && Object.prototype.hasOwnProperty.call(lengthDescriptor, "value")
        ? lengthDescriptor.value : -1;
      if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1
        || keys.some((key) => key !== "length"
          && !(typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)))) {
        throw invalidEvent(`${location} 含 sparse/额外数组项`);
      }
      const clone = [];
      for (let index = 0; index < length; index += 1) {
        let descriptor;
        try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); } catch {
          throw invalidEvent(`${location}[${index}] 描述符不可读取`);
        }
        if (!descriptor || descriptor.enumerable !== true
          || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          throw invalidEvent(`${location}[${index}] 使用 accessor 或 sparse 项`);
        }
        clone.push(cloneJsonValue(descriptor.value, ancestors, `${location}[${index}]`));
      }
      return clone;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidEvent(`${location} 不是普通 JSON 对象`);
    }
    if (Object.getOwnPropertySymbols(value).some((symbol) => (
      Object.prototype.propertyIsEnumerable.call(value, symbol)
    ))) {
      throw invalidEvent(`${location} 含 symbol key`);
    }
    const clone = Object.create(null);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) {
        throw invalidEvent(`${location}.${key} 使用 accessor，无法稳定快照`);
      }
      clone[key] = cloneJsonValue(descriptor.value, ancestors, `${location}.${key}`);
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalJsonSnapshot(payload) {
  const clone = cloneJsonValue(payload);
  return deepFreeze(JSON.parse(JSON.stringify(clone)));
}

function createEventBuffer(maxFrameBytes, options = {}) {
  const maxEvents = options.maxEvents ?? MAX_EVENT_COUNT;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_EVENT_TOTAL_BYTES;
  const streamId = options.streamId ?? crypto.randomUUID();
  if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0
    || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new TypeError("Event ring 上限必须是正安全整数");
  }
  if (typeof streamId !== "string" || !UUID_PATTERN.test(streamId)) {
    throw new TypeError("Event ring streamId 必须是 UUID");
  }
  let sequence = 0;
  let baseSeq = 0;
  let totalBytes = 0;
  const items = [];

  function stats() {
    return {
      count: items.length,
      totalBytes,
      oldestSeq: items[0]?.event.seq ?? sequence + 1,
      baseSeq,
      latestSeq: sequence,
      maxEvents,
      maxTotalBytes,
    };
  }

  return {
    append(type, payload) {
      const event = Object.freeze({
        seq: sequence + 1,
        type: String(type),
        payload: canonicalJsonSnapshot(payload),
      });
      const encodedBytes = jsonlBytes(event);
      if (encodedBytes > MAX_EVENT_BYTES || encodedBytes > maxTotalBytes) {
        throw serviceError("EVENT_TOO_LARGE", "事件编码超过本地协议上限");
      }
      sequence += 1;
      items.push({ event, encodedBytes });
      totalBytes += encodedBytes;
      while (items.length > maxEvents || totalBytes > maxTotalBytes) {
        const removed = items.shift();
        totalBytes -= removed.encodedBytes;
        baseSeq = removed.event.seq;
      }
      return event;
    },

    page(afterSeq, id) {
      const current = stats();
      if (afterSeq < baseSeq) {
        return {
          streamId,
          events: [],
          cursor: baseSeq,
          nextCursor: baseSeq,
          hasMore: items.length > 0,
          oldestSeq: current.oldestSeq,
          baseSeq,
          latestSeq: sequence,
          gap: { code: "CURSOR_GAP", requestedAfterSeq: afterSeq, baseSeq, oldestSeq: current.oldestSeq },
          snapshot: { kind: "cursor-reset", baseSeq, latestSeq: sequence },
        };
      }
      const pending = items.map((item) => item.event).filter((event) => event.seq > afterSeq);
      const selected = [];
      for (let index = 0; index < pending.length; index += 1) {
        const candidate = [...selected, pending[index]];
        const cursor = candidate[candidate.length - 1].seq;
        const payload = {
          id,
          ok: true,
          result: {
            streamId,
            events: candidate,
            cursor,
            nextCursor: cursor,
            hasMore: index < pending.length - 1,
            oldestSeq: current.oldestSeq,
            baseSeq,
            latestSeq: sequence,
            gap: null,
            snapshot: null,
          },
        };
        if (jsonlBytes(payload) > maxFrameBytes) break;
        selected.push(pending[index]);
      }
      if (pending.length > 0 && selected.length === 0) {
        throw serviceError("EVENT_PAGE_BUDGET", "事件页无法在协议预算内取得进展");
      }
      const cursor = selected.length > 0 ? selected[selected.length - 1].seq : afterSeq;
      return {
        streamId,
        events: selected,
        cursor,
        nextCursor: cursor,
        hasMore: pending.length > selected.length,
        oldestSeq: current.oldestSeq,
        baseSeq,
        latestSeq: sequence,
        gap: null,
        snapshot: null,
      };
    },

    stats,
  };
}

module.exports = {
  MAX_EVENT_BYTES,
  MAX_EVENT_COUNT,
  MAX_EVENT_TOTAL_BYTES,
  canonicalJsonSnapshot,
  createEventBuffer,
  jsonlBytes,
};
