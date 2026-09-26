"use strict";

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 3500;
// releaseNotesUrl 指向 GitHub releases 列表页而非具体 tag：Hermes 的 tag 是日期式
// （v2026.8.31），可读 semver 在 release name/body 中，不能按版本拼 tag URL。
const OFFICIAL_SOURCES = {
  openclaw: {
    url: "https://registry.npmjs.org/openclaw/latest",
    source: "npm",
    releaseNotesUrl: "https://github.com/openclaw/openclaw/releases",
  },
  hermes: {
    url: "https://api.github.com/repos/NousResearch/hermes-agent/releases/latest",
    source: "github",
    releaseNotesUrl: "https://github.com/NousResearch/hermes-agent/releases",
  },
};

let latestCache = null;

// 从任意版本字符串中提取数字段；无法识别时返回 null，避免误报更新。
function versionParts(input) {
  const text = String(input || "").trim();
  const match = text.match(/(?:^|[^0-9])v?(\d+(?:[.-]\d+)*)/i) || text.match(/^v?(\d+(?:[.-]\d+)*)/i);
  if (!match) return null;
  const parts = match[1].split(/[.-]/).map((part) => Number(part));
  return parts.every((part) => Number.isFinite(part)) ? parts : null;
}

// OpenClaw 使用日期版本，Hermes 使用 semver；这里统一按数字段逐段比较。
function compareVersions(current, latest) {
  const a = versionParts(current);
  const b = versionParts(latest);
  if (!a || !b) return null;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

// 构造前端可直接渲染的版本摘要；比较失败时只展示版本，不给更新判断。
function buildVersionSummary({ current, latest, currentSource, latestSource, releaseNotesUrl, error } = {}) {
  const summary = {};
  if (current) summary.current = String(current).trim();
  if (latest) summary.latest = String(latest).trim();
  if (currentSource) summary.currentSource = currentSource;
  if (latestSource) summary.latestSource = latestSource;
  if (releaseNotesUrl) summary.releaseNotesUrl = String(releaseNotesUrl);
  if (error) summary.error = String(error);
  const cmp = summary.current && summary.latest ? compareVersions(summary.current, summary.latest) : null;
  if (cmp != null) summary.updateAvailable = cmp < 0;
  return summary;
}

// 给 fetch 增加短超时；版本检查失败只能降级，不能拖慢设置页。
async function fetchJsonWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res || !res.ok) throw new Error(`HTTP ${res?.status || 0}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function hermesReleaseVersion(json) {
  for (const value of [json?.name, json?.body]) {
    const match = String(value || "").match(/Hermes Agent\s+v(\d+\.\d+\.\d+)/i);
    if (match) return match[1];
  }
  return undefined;
}

// 查询单个官方版本源，并把 npm/GitHub 的不同 JSON 形态收敛为 { latest, source }。
async function fetchPackageLatest(id, sourceSpec, opts) {
  try {
    const json = await fetchJsonWithTimeout(opts.fetchImpl, sourceSpec.url, opts.timeoutMs);
    const latest = id === "hermes" ? hermesReleaseVersion(json) : json?.version;
    if (!latest) throw new Error("missing version");
    return { latest: String(latest), source: sourceSpec.source, releaseNotesUrl: sourceSpec.releaseNotesUrl };
  } catch (err) {
    return { source: sourceSpec.source, releaseNotesUrl: sourceSpec.releaseNotesUrl, error: err?.message || String(err) };
  }
}

// 查询 OpenClaw/Hermes 官方最新版本。默认 fetch 结果缓存一段时间，避免频繁打外网。
async function fetchOfficialLatestVersions(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const useCache = fetchImpl === globalThis.fetch && cacheTtlMs > 0;
  const now = Date.now();
  if (useCache && latestCache && now - latestCache.at < cacheTtlMs) {
    return latestCache.data;
  }
  const opts = { fetchImpl, timeoutMs };
  const entries = await Promise.all(
    Object.entries(OFFICIAL_SOURCES).map(async ([id, sourceSpec]) => [
      id,
      await fetchPackageLatest(id, sourceSpec, opts),
    ]),
  );
  const data = Object.fromEntries(entries);
  // Only cache a fully-successful lookup. Caching a failure (offline, source
  // down) would pin "无法检查" for the whole TTL even after connectivity is
  // back — the 设置 page refresh could not break out of it.
  const anyError = Object.values(data).some((entry) => entry && entry.error);
  if (useCache && !anyError) latestCache = { at: now, data };
  return data;
}

module.exports = {
  compareVersions,
  buildVersionSummary,
  fetchOfficialLatestVersions,
};
