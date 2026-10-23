import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { readFileDescriptorBoundedSync } from "./bounded-read.js";
import { FsSafeError } from "./errors.js";
import { stringifyJsonDocument } from "./json-stringify.js";
import { readRegularFile, readRegularFileSync, statRegularFile } from "./regular-file.js";
import { openRootFileSync } from "./root-file.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import { writeTempFile, syncDirectoryBestEffort } from "./replace-file-descriptor.js";
import { AtomicIo, runSync } from "./atomic-io.js";
import { AtomicTempOwner } from "./replace-file-temp-owner.js";
import { admitStandalonePublicationPath, assertNoWindowsPathAlias } from "./windows-path-alias.js";
import { writeTextAtomic } from "./text-atomic.js";
import { sleep } from "./timing.js";
const READ_RETRY_MAX_ATTEMPTS = 5;
const READ_RETRY_BASE_DELAY_MS = 50;
function isRetryableReadError(err) {
    if (err instanceof FsSafeError && err.code === "path-mismatch") {
        return true;
    }
    const code = getErrorCode(err);
    return code === "ENOENT" || code === "EPERM";
}
async function readRegularFileWithRetry(filePath, maxBytes) {
    let lastErr;
    for (let attempt = 0; attempt < READ_RETRY_MAX_ATTEMPTS; attempt++) {
        try {
            return (await readRegularFile({ filePath, maxBytes })).buffer;
        }
        catch (err) {
            lastErr = err;
            if (!isRetryableReadError(err) || attempt === READ_RETRY_MAX_ATTEMPTS - 1) {
                throw err;
            }
            await sleep(READ_RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
        }
    }
    throw lastErr;
}
async function readRegularFileIfExistsWithRetry(filePath, options = {}) {
    const initial = await statRegularFile(filePath);
    if (initial.missing) {
        return null;
    }
    return await readRegularFileWithRetry(filePath, options.maxBytes);
}
const JSON_FILE_MODE = 0o600;
const JSON_DIR_MODE = 0o700;
function getErrorCode(err) {
    return err instanceof Error ? err.code : undefined;
}
function trySetSecureMode(fd) {
    try {
        fsSync.fchmodSync(fd, JSON_FILE_MODE);
    }
    catch {
        // Best-effort mode application stays on the retained staging descriptor.
    }
}
function renameJsonFileWithFallback(owner, pathname) {
    runSync(owner.assertCurrent());
    try {
        fsSync.renameSync(owner.pathname, pathname);
        return;
    }
    catch (error) {
        const code = error?.code;
        if (code === "EPERM" || code === "EEXIST") {
            runSync(owner.assertCurrent());
            fsSync.rmSync(pathname, { force: true });
            runSync(owner.assertCurrent());
            fsSync.renameSync(owner.pathname, pathname);
            return;
        }
        throw error;
    }
}
export function tryReadJsonSync(pathname, options = {}) {
    try {
        const raw = readRegularFileSync({
            filePath: pathname,
            maxBytes: options.maxBytes,
        }).buffer.toString("utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export function writeJsonSync(pathname, data) {
    const filePath = admitStandalonePublicationPath(pathname);
    // Keep literal parent segments so staging follows the same symlinks as the target.
    const tmpPath = path.format({ ...path.parse(filePath), base: `.fs-safe-${randomUUID()}.tmp` });
    const payload = `${stringifyJsonDocument(data, null, 2)}\n`;
    fsSync.mkdirSync(recursiveMkdirPath(path.dirname(filePath)), { recursive: true, mode: JSON_DIR_MODE });
    const io = AtomicIo.sync(fsSync);
    const owner = new AtomicTempOwner(tmpPath, io);
    let originalFailure;
    try {
        owner.start();
        const temp = runSync(writeTempFile(io, {
            tempPath: tmpPath, content: payload, mode: JSON_FILE_MODE,
            sync: false, onIdentity: owner.onIdentity,
        }));
        owner.adopt(temp);
        runSync(owner.assertCurrent());
        trySetSecureMode(temp.file.fd);
        fsSync.fsyncSync(temp.file.fd);
        renameJsonFileWithFallback(owner, filePath);
        owner.markRenamed();
        runSync(owner.assertPublished(filePath));
        trySetSecureMode(temp.file.fd);
        runSync(syncDirectoryBestEffort(io, path.dirname(filePath)));
        runSync(owner.assertPublished(filePath));
    }
    catch (error) {
        originalFailure = { error };
        throw error;
    }
    finally {
        runSync(owner.finish({ originalFailure, throwOnCleanupError: false }));
    }
}
export class JsonFileReadError extends Error {
    filePath;
    reason;
    constructor(filePath, reason, cause) {
        super(`Failed to ${reason} JSON file: ${filePath}`, { cause });
        this.name = "JsonFileReadError";
        this.filePath = filePath;
        this.reason = reason;
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function resolveInvalidMessage(invalidMessage, relativePath) {
    if (typeof invalidMessage === "function") {
        return invalidMessage(relativePath);
    }
    return invalidMessage ?? `${relativePath} has an unexpected shape`;
}
export function readRootStructuredFileSync(options) {
    return readRootStructuredFileSyncInternal(options, options);
}
function readRootStructuredFileSyncInternal(options, parser) {
    let absolutePath;
    let relativePath;
    let rootDir;
    let rootRealPath;
    try {
        rootDir = options.rootDir;
        relativePath = options.relativePath;
        rootRealPath = options.rootRealPath;
        assertNoWindowsPathAlias(rootDir);
        assertNoWindowsPathAlias(relativePath, "relative");
        if (rootRealPath !== undefined) {
            assertNoWindowsPathAlias(rootRealPath);
        }
        absolutePath = path.resolve(rootDir, relativePath);
        assertNoWindowsPathAlias(absolutePath);
    }
    catch (error) {
        return {
            ok: false,
            reason: "open",
            failure: { ok: false, reason: "validation", error },
        };
    }
    const boundaryLabel = options.boundaryLabel;
    const rejectHardlinks = options.rejectHardlinks;
    const maxBytes = options.maxBytes;
    const opened = openRootFileSync({
        absolutePath,
        rootPath: rootDir,
        rootRealPath,
        boundaryLabel,
        rejectHardlinks,
        maxBytes,
        allowedType: "file",
    });
    if (!opened.ok) {
        return { ok: false, reason: "open", failure: opened };
    }
    try {
        const raw = maxBytes === undefined
            ? fsSync.readFileSync(opened.fd, "utf8")
            : readFileDescriptorBoundedSync(opened.fd, maxBytes).toString("utf8");
        const parse = parser.parse;
        const parsed = Reflect.apply(parse, parser, [raw]);
        const validate = parser.validate;
        if (validate && !Reflect.apply(validate, parser, [parsed])) {
            return {
                ok: false,
                reason: "invalid",
                error: resolveInvalidMessage(parser.invalidMessage, relativePath),
            };
        }
        return {
            ok: true,
            value: parsed,
            stat: opened.stat,
            path: opened.path,
            rootRealPath: opened.rootRealPath,
        };
    }
    catch (error) {
        return {
            ok: false,
            reason: "parse",
            error: `failed to parse ${relativePath}: ${String(error)}`,
        };
    }
    finally {
        fsSync.closeSync(opened.fd);
    }
}
export function readRootJsonSync(options) {
    return readRootStructuredFileSyncInternal(options, {
        parse: (raw) => JSON.parse(raw),
    });
}
export function readRootJsonObjectSync(options) {
    return readRootStructuredFileSyncInternal(options, {
        parse: (raw) => JSON.parse(raw),
        validate: isRecord,
        invalidMessage: (relativePath) => `${relativePath} must contain a JSON object`,
    });
}
export async function tryReadJson(filePath, options = {}) {
    try {
        const buffer = await readRegularFileIfExistsWithRetry(filePath, options);
        if (buffer === null) {
            return null;
        }
        const raw = buffer.toString("utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export async function readJson(filePath, options = {}) {
    let raw;
    try {
        raw = (await readRegularFileWithRetry(filePath, options.maxBytes)).toString("utf8");
    }
    catch (err) {
        throw new JsonFileReadError(filePath, "read", err);
    }
    try {
        return JSON.parse(raw);
    }
    catch (err) {
        throw new JsonFileReadError(filePath, "parse", err);
    }
}
export async function readJsonIfExists(filePath, options = {}) {
    let raw;
    try {
        const buffer = await readRegularFileIfExistsWithRetry(filePath, options);
        if (buffer === null) {
            return null;
        }
        raw = buffer.toString("utf8");
    }
    catch (err) {
        if (getErrorCode(err) === "ENOENT") {
            return null;
        }
        throw new JsonFileReadError(filePath, "read", err);
    }
    try {
        return JSON.parse(raw);
    }
    catch (err) {
        throw new JsonFileReadError(filePath, "parse", err);
    }
}
export function readJsonSync(filePath, options = {}) {
    let raw;
    try {
        raw = readRegularFileSync({ filePath, maxBytes: options.maxBytes }).buffer.toString("utf8");
    }
    catch (err) {
        throw new JsonFileReadError(filePath, "read", err);
    }
    try {
        return JSON.parse(raw);
    }
    catch (err) {
        throw new JsonFileReadError(filePath, "parse", err);
    }
}
export async function writeJson(filePath, value, options) {
    const admittedPath = admitStandalonePublicationPath(filePath);
    const text = stringifyJsonDocument(value, null, 2);
    await writeTextAtomic(admittedPath, text, {
        mode: options?.mode,
        dirMode: options?.dirMode,
        trailingNewline: options?.trailingNewline,
        durable: options?.durable,
    });
}
