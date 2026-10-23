import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.js";
import { hasWindowsPathAlias } from "./windows-path-alias.js";
import { isWindowsSeparator, rootedWindowsDriveColonIndex, windowsNamespaceMarker, } from "./windows-path-syntax.js";
const ENCODED_FILE_URL_SEPARATOR_RE = /%(?:2f|5c)/i;
const FILE_URL_PREFIX_RE = /^file:\/\//i;
export function isFileUrl(input) {
    return FILE_URL_PREFIX_RE.test(input);
}
export function hasEncodedFileUrlSeparator(pathname) {
    return ENCODED_FILE_URL_SEPARATOR_RE.test(pathname);
}
export function isWindowsNetworkPath(filePath, platform = process.platform) {
    if (platform !== "win32") {
        return false;
    }
    return isWindowsSeparator(filePath, 0) && isWindowsSeparator(filePath, 1) &&
        !(windowsNamespaceMarker(filePath) === "?" && rootedWindowsDriveColonIndex(filePath) === 5);
}
export function isWindowsDriveLetterPath(filePath, platform = process.platform) {
    return platform === "win32" && /^[A-Za-z]:[\\/]/.test(filePath);
}
export function assertNoWindowsNetworkPath(filePath, label = "Path") {
    if (isWindowsNetworkPath(filePath)) {
        throw new Error(`${label} cannot use Windows network paths: ${filePath}`);
    }
}
export function safeFileURLToPath(fileUrl, platform = process.platform) {
    let parsed;
    try {
        parsed = new URL(fileUrl);
    }
    catch {
        throw new Error(`Invalid file:// URL: ${fileUrl}`);
    }
    if (parsed.protocol !== "file:") {
        throw new Error(`Invalid file:// URL: ${fileUrl}`);
    }
    const normalizedHost = normalizeLowercaseStringOrEmpty(parsed.hostname);
    if (!(normalizedHost === "" || normalizedHost === "localhost")) {
        throw new Error(`file:// URLs with remote hosts are not allowed: ${fileUrl}`);
    }
    if (hasEncodedFileUrlSeparator(parsed.pathname)) {
        throw new Error(`file:// URLs cannot encode path separators: ${fileUrl}`);
    }
    const filePath = fileURLToPath(parsed, { windows: platform === "win32" });
    if (hasWindowsPathAlias(filePath, "filesystem", platform)) {
        throw new Error(`Local file URL cannot use Windows filesystem namespace aliases: ${filePath}`);
    }
    if (isWindowsNetworkPath(filePath, platform)) {
        throw new Error(`Local file URL cannot use Windows network paths: ${filePath}`);
    }
    return filePath;
}
export function trySafeFileURLToPath(fileUrl, platform = process.platform) {
    try {
        return safeFileURLToPath(fileUrl, platform);
    }
    catch {
        return undefined;
    }
}
export function basenameFromMediaSource(source) {
    if (!source) {
        return undefined;
    }
    if (isFileUrl(source)) {
        const filePath = trySafeFileURLToPath(source);
        return filePath ? path.basename(filePath) || undefined : undefined;
    }
    if (/^https?:\/\//i.test(source)) {
        try {
            return path.basename(new URL(source).pathname) || undefined;
        }
        catch {
            return undefined;
        }
    }
    return path.basename(source) || undefined;
}
