import path from "node:path";
import { ArchiveSecurityError } from "./archive-errors.js";
import { isWindowsReservedDeviceName } from "./device-path.js";
import { formatErrorDetail } from "./error-detail.js";
import { resolveSafeBaseDir } from "./path.js";
import { lowerCaseNfc, maxNormalizedUtf8Bytes } from "./unicode-path.js";
export function isWindowsDrivePath(value) {
    return /(?:^|\/)[a-zA-Z]:/.test(normalizeArchiveEntryPath(value));
}
export function normalizeArchiveEntryPath(raw) {
    return raw.replaceAll("\\", "/");
}
export function validateArchiveEntryPath(entryPath, params) {
    if (!entryPath || entryPath === "." || entryPath === "./") {
        return;
    }
    if (isWindowsDrivePath(entryPath)) {
        throw new ArchiveSecurityError("entry-path", `archive entry uses a drive path: ${formatErrorDetail(entryPath)}`);
    }
    if (entryPath.includes("\0")) {
        throw new ArchiveSecurityError("entry-path", `archive entry contains a NUL byte: ${formatErrorDetail(entryPath)}`);
    }
    const slashNormalized = normalizeArchiveEntryPath(entryPath);
    const rawSegments = slashNormalized.split("/");
    if (process.platform === "win32" &&
        rawSegments.some((segment) => segment.includes(":"))) {
        throw new ArchiveSecurityError("entry-path", `archive entry uses a Windows alternate data stream path: ${formatErrorDetail(entryPath)}`);
    }
    if (process.platform === "win32" &&
        rawSegments.some((segment) => isWindowsReservedDeviceName(segment))) {
        throw new ArchiveSecurityError("entry-path", `archive entry uses a reserved device path: ${formatErrorDetail(entryPath)}`);
    }
    const normalized = path.posix.normalize(slashNormalized);
    if (normalized.split("/").some((segment) => maxNormalizedUtf8Bytes(segment) > 255)) {
        throw new ArchiveSecurityError("entry-path", `archive entry has an overlong path component: ${formatErrorDetail(entryPath)}`);
    }
    const escapeLabel = params?.escapeLabel ?? "destination";
    if (normalized === ".." || normalized.startsWith("../")) {
        throw new ArchiveSecurityError("entry-path", `archive entry escapes ${escapeLabel}: ${formatErrorDetail(entryPath)}`);
    }
    if (path.posix.isAbsolute(normalized) || normalized.startsWith("//")) {
        throw new ArchiveSecurityError("entry-path", `archive entry is absolute: ${formatErrorDetail(entryPath)}`);
    }
    if (rawSegments.includes("..")) {
        throw new ArchiveSecurityError("entry-path", `archive entry contains a parent segment: ${formatErrorDetail(entryPath)}`);
    }
}
// Validate raw paths first. Zero stripping gives the canonical policy identity.
export function stripArchivePath(entryPath, stripComponents) {
    const raw = normalizeArchiveEntryPath(entryPath);
    if (!raw || raw === "." || raw === "./") {
        return null;
    }
    const parts = raw.split("/").filter((part) => part.length > 0 && part !== ".");
    const strip = Math.max(0, Math.floor(stripComponents));
    const stripped = strip === 0 ? parts.join("/") : parts.slice(strip).join("/");
    const result = path.posix.normalize(stripped);
    if (!result || result === "." || result === "./") {
        return null;
    }
    return result;
}
export function createArchiveOutputPathTracker() {
    const seen = new Set();
    return (entryPath, originalPath) => {
        // Extraction passes stripArchivePath output. Native manifests and physical
        // admission pass raw names, and path.posix.normalize keeps a directory's
        // trailing slash, so "A/" and "a" would not share a key.
        const canonical = stripArchivePath(entryPath, 0)
            ?? path.posix.normalize(normalizeArchiveEntryPath(entryPath));
        // Archive policy must not depend on the destination volume's case or
        // Unicode-normalization behavior. Otherwise the JavaScript and native
        // writers can disagree about which of two colliding entries wins.
        const collisionKey = lowerCaseNfc(canonical);
        if (seen.has(collisionKey)) {
            throw new ArchiveSecurityError("entry-path", `archive entries collide at output path ${formatErrorDetail(canonical)}: ${formatErrorDetail(originalPath)}`);
        }
        seen.add(collisionKey);
    };
}
export function resolveArchiveOutputPath(params) {
    const safeBase = resolveSafeBaseDir(params.rootDir);
    const outPath = path.resolve(params.rootDir, params.relPath);
    const escapeLabel = params.escapeLabel ?? "destination";
    if (!outPath.startsWith(safeBase)) {
        throw new ArchiveSecurityError("entry-path", `archive entry escapes ${escapeLabel}: ${formatErrorDetail(params.originalPath)}`);
    }
    return outPath;
}
