"use strict";

const crypto = require("node:crypto");
const {
  MAX_EVENT_BYTES,
  MAX_EVENT_COUNT,
  MAX_EVENT_TOTAL_BYTES,
  jsonlBytes,
} = require("./event-buffer");
const { serviceError } = require("./security");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const MAX_RUN_EVENT_COUNT = MAX_EVENT_COUNT;
const MAX_RUN_EVENT_TOTAL_BYTES = MAX_EVENT_TOTAL_BYTES;
const MAX_RUN_EVENT_BYTES = MAX_EVENT_BYTES;
const MAX_CANONICAL_DEPTH = 128;

function streamError(code, message) {
  return serviceError(code, message);
}

function validOpaqueId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function requirePositiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} 必须是正安全整数`);
  }
  return value;
}

function canonicalJsonSnapshotBounded(payload, maxBytes, tooLargeCode) {
  let usedBytes = 0;
  const ancestors = new Set();
  const tooLarge = () => {
    throw streamError(tooLargeCode, "Run event canonical 快照超过容量或深度限制");
  };
  const invalid = () => {
    throw streamError("RUN_EVENT_INVALID", "Run event 不是稳定 JSON 快照");
  };
  const charge = (bytes) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || usedBytes > maxBytes - bytes) tooLarge();
    usedBytes += bytes;
  };
  const chargeString = (value) => {
    const rawBytes = Buffer.byteLength(value, "utf8");
    // JSON string 至少包含原始 UTF-8 大小与两个引号；先挡住巨大单字段再编码转义。
    if (rawBytes > maxBytes - usedBytes - 2) tooLarge();
    charge(Buffer.byteLength(JSON.stringify(value), "utf8"));
  };

  function visit(value, depth) {
    if (depth > MAX_CANONICAL_DEPTH) tooLarge();
    if (value === null) { charge(4); return null; }
    if (typeof value === "string") { chargeString(value); return value; }
    if (typeof value === "boolean") { charge(value ? 4 : 5); return value; }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) invalid();
      const encoded = JSON.stringify(value);
      charge(Buffer.byteLength(encoded, "utf8"));
      return value;
    }
    if (typeof value !== "object") invalid();
    if (ancestors.has(value)) invalid();
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        charge(2 + Math.max(0, value.length - 1));
        for (const key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          if (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) invalid();
        }
        for (let index = 0; index < value.length; index += 1) {
          if (!(index in value)) invalid();
        }
        const clone = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || descriptor.get || descriptor.set) invalid();
          clone.push(visit(descriptor.value, depth + 1));
        }
        return clone;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) invalid();
      if (Object.getOwnPropertySymbols(value).some((symbol) => (
        Object.prototype.propertyIsEnumerable.call(value, symbol)
      ))) invalid();
      charge(2);
      const clone = Object.create(null);
      let keyCount = 0;
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (keyCount > 0) charge(1);
        chargeString(key);
        charge(1);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || descriptor.get || descriptor.set) invalid();
        clone[key] = visit(descriptor.value, depth + 1);
        keyCount += 1;
      }
      return clone;
    } finally {
      ancestors.delete(value);
    }
  }

  const clone = visit(payload, 0);
  // 此时 clone 的 JSON 大小已被 maxBytes 约束，最终规范化不会产生无界分配。
  const serialized = JSON.stringify(clone);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) tooLarge();
  const canonical = JSON.parse(serialized);
  const freeze = (value) => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freeze(child);
    return Object.freeze(value);
  };
  return freeze(canonical);
}

function createRunEventStream(options = {}) {
  if (!validOpaqueId(options.runId)) {
    throw streamError("RUN_EVENT_STREAM_INVALID", "runId 无效");
  }
  if (typeof options.getSnapshot !== "function"
    || typeof options.assertSecretSafe !== "function") {
    throw streamError(
      "RUN_EVENT_STREAM_CALLBACK_REQUIRED",
      "RunEventStream 需要 snapshot 与 secret-safe callback",
    );
  }
  if (options.onSubscriberError !== undefined
    && typeof options.onSubscriberError !== "function") {
    throw streamError("RUN_EVENT_STREAM_INVALID", "onSubscriberError 必须是函数");
  }
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const streamId = randomUUID();
  if (!UUID_PATTERN.test(streamId)) {
    throw streamError("RUN_EVENT_STREAM_INVALID", "streamId 无效");
  }
  const runId = options.runId;
  const maxEvents = requirePositiveLimit(options.maxEvents ?? MAX_EVENT_COUNT, "maxEvents");
  const maxTotalBytes = requirePositiveLimit(
    options.maxTotalBytes ?? MAX_EVENT_TOTAL_BYTES,
    "maxTotalBytes",
  );
  const maxEventBytes = requirePositiveLimit(options.maxEventBytes ?? MAX_EVENT_BYTES, "maxEventBytes");
  const maxSnapshotBytes = requirePositiveLimit(
    options.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES,
    "maxSnapshotBytes",
  );
  if (maxSnapshotBytes > MAX_SNAPSHOT_BYTES) {
    throw streamError("RUN_EVENT_STREAM_INVALID", "maxSnapshotBytes 超过协议上限");
  }
  if (maxEvents > MAX_RUN_EVENT_COUNT
    || maxTotalBytes > MAX_RUN_EVENT_TOTAL_BYTES
    || maxEventBytes > MAX_RUN_EVENT_BYTES
    || maxEventBytes > maxTotalBytes) {
    throw streamError("RUN_EVENT_STREAM_INVALID", "Run event ring 容量配置无效");
  }
  let sequence = 0;
  let baseSeq = 0;
  let totalBytes = 0;
  let closed = false;
  const items = [];
  const subscribers = new Set();
  const pendingNotifications = [];
  let notifying = false;
  let mutationCallbackDepth = 0;

  function consumeThenable(value, onReject = () => {}) {
    if ((value === null || (typeof value !== "object" && typeof value !== "function"))) {
      return false;
    }
    let then;
    try {
      then = value.then;
    } catch (error) {
      onReject(error);
      return true;
    }
    if (typeof then !== "function") return false;
    Promise.resolve(value).catch(onReject);
    return true;
  }

  function callMutationCallback(callback) {
    mutationCallbackDepth += 1;
    try {
      return callback();
    } finally {
      mutationCallbackDepth -= 1;
    }
  }

  function secretSafeSnapshot(value, context, byteLimit, tooLargeCode) {
    let snapshot;
    try {
      snapshot = canonicalJsonSnapshotBounded(value, byteLimit, tooLargeCode);
    } catch (error) {
      if (["RUN_EVENT_TOO_LARGE", "RUN_EVENT_SNAPSHOT_TOO_LARGE"].includes(error?.code)) {
        throw error;
      }
      throw streamError("RUN_EVENT_INVALID", "Run event 不是稳定 JSON 快照");
    }
    let accepted;
    try {
      accepted = callMutationCallback(
        () => options.assertSecretSafe(snapshot, Object.freeze({ ...context })),
      );
    } catch (error) {
      if (error?.code === "RUN_EVENT_REENTRANT") throw error;
      throw streamError("RUN_EVENT_SECRET_REJECTED", "Run event 未通过敏感信息检查");
    }
    if (accepted === false || consumeThenable(accepted)) {
      throw streamError("RUN_EVENT_SECRET_REJECTED", "Run event 未通过敏感信息检查");
    }
    return snapshot;
  }

  function currentSnapshot(context) {
    let rawSnapshot;
    try {
      rawSnapshot = callMutationCallback(() => options.getSnapshot());
    } catch (error) {
      if (error?.code === "RUN_EVENT_REENTRANT") throw error;
      throw streamError("RUN_EVENT_INVALID", "Run snapshot callback 失败");
    }
    if (consumeThenable(rawSnapshot)) {
      throw streamError("RUN_EVENT_SNAPSHOT_ASYNC", "Run snapshot callback 必须同步");
    }
    return secretSafeSnapshot(
      rawSnapshot,
      context,
      maxSnapshotBytes,
      "RUN_EVENT_SNAPSHOT_TOO_LARGE",
    );
  }

  function stats() {
    return {
      runId,
      streamId,
      count: items.length,
      totalBytes,
      baseSeq,
      latestSeq: sequence,
      nextSeq: sequence + 1,
      subscriberCount: subscribers.size,
      closed,
      maxEvents,
      maxTotalBytes,
      maxEventBytes,
      maxSnapshotBytes,
    };
  }

  function assertOpen() {
    if (closed) throw streamError("RUN_EVENT_STREAM_CLOSED", "RunEventStream 已关闭");
  }

  function notifySubscribers(event) {
    pendingNotifications.push(event);
    if (notifying) return;
    notifying = true;
    try {
      while (pendingNotifications.length > 0) {
        const pending = pendingNotifications.shift();
        for (const subscriber of [...subscribers]) {
          if (!subscribers.has(subscriber)) continue;
          try {
            const result = subscriber.listener(pending);
            consumeThenable(result, (error) => reportSubscriberError(error, pending));
          } catch (error) {
            reportSubscriberError(error, pending);
          }
        }
      }
    } finally {
      notifying = false;
    }
  }

  function reportSubscriberError(error, event) {
    if (!options.onSubscriberError) return;
    try {
      const result = options.onSubscriberError(error, Object.freeze({
        runId,
        streamId,
        seq: event.seq,
      }));
      consumeThenable(result);
    } catch {}
  }

  const api = {
    runId,
    streamId,

    append(type, payload) {
      if (mutationCallbackDepth > 0) {
        throw streamError("RUN_EVENT_REENTRANT", "mutation callback 禁止重入 append");
      }
      assertOpen();
      if (typeof type !== "string" || type.length === 0 || type.length > 128
        || !/^[a-z][a-z0-9._-]*$/u.test(type)) {
        throw streamError("RUN_EVENT_INVALID", "Run event type 无效");
      }
      const envelope = {
        runId,
        streamId,
        seq: sequence + 1,
        type,
        payload: null,
      };
      const payloadBudget = maxEventBytes - (jsonlBytes(envelope) - 4);
      if (payloadBudget <= 0) {
        throw streamError("RUN_EVENT_TOO_LARGE", "Run event envelope 超过容量限制");
      }
      const event = Object.freeze({
        ...envelope,
        payload: secretSafeSnapshot(
          payload,
          { kind: "event", runId, streamId, type },
          payloadBudget,
          "RUN_EVENT_TOO_LARGE",
        ),
      });
      const encodedBytes = jsonlBytes(event);
      if (encodedBytes > maxEventBytes || encodedBytes > maxTotalBytes) {
        throw streamError("RUN_EVENT_TOO_LARGE", "Run event 超过容量限制");
      }
      sequence += 1;
      items.push({ event, encodedBytes });
      totalBytes += encodedBytes;
      while (items.length > maxEvents || totalBytes > maxTotalBytes) {
        const removed = items.shift();
        totalBytes -= removed.encodedBytes;
        baseSeq = removed.event.seq;
      }
      notifySubscribers(event);
      return event;
    },

    subscribe(cursor, listener) {
      assertOpen();
      if (!exactObject(cursor, ["streamId", "afterSeq"])
        || (cursor.streamId !== null && !UUID_PATTERN.test(cursor.streamId))
        || !Number.isSafeInteger(cursor.afterSeq) || cursor.afterSeq < 0) {
        throw streamError("RUN_EVENT_CURSOR_INVALID", "Run event cursor 无效");
      }
      if (typeof listener !== "function") {
        throw streamError("RUN_EVENT_SUBSCRIBER_INVALID", "subscriber 必须是函数");
      }
      const reset = cursor.streamId !== null && cursor.streamId !== streamId;
      if (!reset && cursor.afterSeq > sequence) {
        throw streamError("RUN_EVENT_CURSOR_INVALID", "afterSeq 超过当前 stream 游标");
      }
      const gap = reset
        ? {
          code: "STREAM_RESET",
          requestedStreamId: cursor.streamId,
          currentStreamId: streamId,
          requestedAfterSeq: cursor.afterSeq,
          baseSeq,
          latestSeq: sequence,
        }
        : cursor.afterSeq < baseSeq
          ? { code: "CURSOR_GAP", requestedAfterSeq: cursor.afterSeq, baseSeq }
          : null;
      const snapshot = gap
        ? currentSnapshot({
          kind: "snapshot",
          runId,
          streamId,
          baseSeq,
          latestSeq: sequence,
        })
        : null;
      const events = gap
        ? []
        : items.filter((item) => item.event.seq > cursor.afterSeq).map((item) => item.event);
      const subscriber = { listener };
      subscribers.add(subscriber);
      let subscribed = true;
      const unsubscribe = () => {
        if (!subscribed) return false;
        subscribed = false;
        return subscribers.delete(subscriber);
      };
      return Object.freeze({
        runId,
        streamId,
        events: Object.freeze(events),
        gap: gap ? Object.freeze(gap) : null,
        snapshot,
        baseSeq,
        latestSeq: sequence,
        nextSeq: sequence + 1,
        unsubscribe,
      });
    },

    close() {
      if (closed) return false;
      closed = true;
      subscribers.clear();
      pendingNotifications.length = 0;
      return true;
    },

    stats,
  };

  return Object.freeze(api);
}

module.exports = {
  MAX_RUN_EVENT_BYTES,
  MAX_RUN_EVENT_COUNT,
  MAX_RUN_EVENT_TOTAL_BYTES,
  MAX_SNAPSHOT_BYTES,
  createRunEventStream,
  streamError,
};
