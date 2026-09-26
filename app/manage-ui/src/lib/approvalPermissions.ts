type Translate = (key: string) => string;
type SummaryRow = [string, string];
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonObject, keys: string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function permissionPath(value: unknown, t: Translate): string | undefined {
  if (!isObject(value)) return undefined;
  if (value.type === "path" && hasOnlyKeys(value, ["type", "path"])) {
    return typeof value.path === "string" && value.path ? value.path : undefined;
  }
  if (value.type === "glob_pattern" && hasOnlyKeys(value, ["type", "pattern"])) {
    return typeof value.pattern === "string" && value.pattern
      ? `${t("chat.promptPermissions.matchingPaths")}: ${value.pattern}` : undefined;
  }
  if (value.type !== "special" || !hasOnlyKeys(value, ["type", "value"]) || !isObject(value.value)) return undefined;
  const special = value.value;
  if (!hasOnlyKeys(special, special.kind === "project_roots" ? ["kind", "subpath"] : ["kind"])) return undefined;
  if (!["root", "minimal", "project_roots", "tmpdir", "slash_tmp"].includes(String(special.kind))) return undefined;
  const label = t(`chat.promptPermissions.paths.${special.kind}`);
  if (special.subpath == null) return label;
  return typeof special.subpath === "string" ? `${label}: ${special.subpath}` : undefined;
}

/** Render the requested overlay, including unrecognized data so no scope is silently omitted. */
export function approvalPermissionSummary(value: string | undefined, t: Translate) {
  const rows: SummaryRow[] = [];
  let parsed: unknown;
  try {
    parsed = value ? JSON.parse(value) : undefined;
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
  } catch { /* The visible fallback below preserves an unreadable request. */ }
  if (!isObject(parsed)) {
    rows.push([t("chat.promptPermissions.scope"),
      t(value ? "chat.promptPermissions.unreadable" : "chat.promptPermissions.unspecified")]);
    if (value) rows.push([t("chat.promptPermissions.other"), value]);
    return { title: t("chat.promptRequestPermissions"), rows };
  }

  let unrecognized = !hasOnlyKeys(parsed, ["fileSystem", "network"]);
  const fileSystem = parsed.fileSystem;
  if (isObject(fileSystem)) {
    unrecognized ||= !hasOnlyKeys(fileSystem, ["read", "write", "entries", "globScanMaxDepth"]);
    for (const access of ["read", "write"]) {
      const paths = fileSystem[access];
      if (paths == null) continue;
      if (Array.isArray(paths) && paths.every((path) => typeof path === "string" && path.length > 0)) {
        if (paths.length) rows.push([t(`chat.promptPermissions.${access}`), paths.join("\n")]);
      } else unrecognized = true;
    }
    if (Array.isArray(fileSystem.entries)) {
      for (const entry of fileSystem.entries) {
        if (!isObject(entry) || !hasOnlyKeys(entry, ["access", "path"])
          || !["read", "write", "deny"].includes(String(entry.access))) {
          unrecognized = true;
          continue;
        }
        const path = permissionPath(entry.path, t);
        if (path) rows.push([t(`chat.promptPermissions.${entry.access}`), path]);
        else unrecognized = true;
      }
    } else if (fileSystem.entries != null) unrecognized = true;
    if (fileSystem.globScanMaxDepth != null) {
      if (typeof fileSystem.globScanMaxDepth === "number" && Number.isInteger(fileSystem.globScanMaxDepth)
        && fileSystem.globScanMaxDepth > 0) {
        rows.push([t("chat.promptPermissions.scanDepth"), String(fileSystem.globScanMaxDepth)]);
      } else unrecognized = true;
    }
  } else if (fileSystem != null) unrecognized = true;
  const hasFiles = rows.length > 0;

  const network = parsed.network;
  let hasNetwork = false;
  if (isObject(network)) {
    unrecognized ||= !hasOnlyKeys(network, ["enabled"]);
    if (typeof network.enabled === "boolean") {
      hasNetwork = true;
      rows.push([t("chat.promptPermissions.network"),
        t(network.enabled ? "chat.promptPermissions.networkEnabled" : "chat.promptPermissions.networkDisabled")]);
    } else if (network.enabled != null) unrecognized = true;
  } else if (network != null) unrecognized = true;

  if (unrecognized) rows.push([t("chat.promptPermissions.other"), JSON.stringify(parsed, null, 2)]);
  if (!rows.length) rows.push([t("chat.promptPermissions.scope"), t("chat.promptPermissions.unspecified")]);
  const titleKey = unrecognized ? "chat.promptRequestPermissions"
    : hasFiles && hasNetwork ? "chat.promptPermissions.filesAndNetworkTitle"
      : hasFiles ? "chat.promptPermissions.filesTitle"
        : hasNetwork ? "chat.promptPermissions.networkTitle" : "chat.promptRequestPermissions";
  return { title: t(titleKey), rows };
}
