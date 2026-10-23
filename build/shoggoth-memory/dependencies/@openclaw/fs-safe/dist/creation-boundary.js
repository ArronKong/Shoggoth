import fs, {} from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { assertDirectoryIdentitySync, inspectDirectoryIdentitySync, } from "./directory-guard.js";
import { nodeDarwinDirectoryMetadataFlags, nodeDirectorySearchOnlyFlags } from "./directory-mode-node.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import { getNativeBinding } from "./native.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import { assertNoNulPathInput } from "./path.js";
import { realpathSync } from "./realpath.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { assertNoWindowsPathAlias, resolvePathPreservingWindowsRoot } from "./windows-path-alias.js";
import { inspectWindowsDirectoryCommand, inspectWindowsDirectoryCommandSync, protectPrivateWindowsFileCommand, protectPrivateWindowsFileCommandSync, verifyPrivateWindowsFileCommand, verifyPrivateWindowsFileCommandSync, hasUnsettledWindowsSecurityCommand, } from "./windows-security-command.js";
export function resolveCreationPermissions(options, directory) {
    const privatePath = options.private;
    const mode = options.mode;
    if (privatePath !== undefined && typeof privatePath !== "boolean") {
        throw new TypeError("private must be a boolean");
    }
    if (mode !== undefined && (!Number.isInteger(mode) || mode < 0 || mode > 0o7777)) {
        throw new RangeError("mode must contain only permission bits");
    }
    if (privatePath && mode !== undefined && (mode & 0o7077) !== 0) {
        throw new FsSafeError("insecure-permissions", "private creation requires owner-only permission bits");
    }
    if (privatePath)
        assertDarwinPrivateCreationAvailable();
    if (privatePath && directory)
        assertDarwinPrivateDirectoryMode(mode ?? 0o700);
    return { private: privatePath === true, mode: mode ?? (privatePath ? directory ? 0o700 : 0o600 : undefined) };
}
function assertPrivatePosixDirectory(stat) {
    if (typeof process.getuid !== "function" || stat.uid !== BigInt(process.getuid())) {
        throw new FsSafeError("not-owned", "private directory must belong to the current user");
    }
    if ((stat.mode & 3647n) !== 0n) {
        throw new FsSafeError("insecure-permissions", "existing directory is not private");
    }
}
function unavailable() {
    throw new FsSafeError("helper-unavailable", "private Windows creation requires an up-to-date native helper");
}
export function assertPrivateFileCreationAvailable() {
    const native = getNativeBinding();
    if (process.platform !== "win32" || getFsSafeNativeConfig().mode !== "require")
        return;
    if (typeof native?.createPrivateDirectoryWithParentIdentity !== "function" ||
        typeof native.inspectWindowsDirectory !== "function" ||
        typeof native.protectPrivateWindowsFile !== "function" ||
        typeof native.verifyPrivateWindowsFile !== "function")
        unavailable();
}
function commandFallback() {
    if (getFsSafeNativeConfig().mode === "require")
        unavailable();
    warnNativeFallback("windows-private-creation", "Private Windows creation uses a slower built-in system command.");
}
function creationOperation(name) {
    const native = getNativeBinding();
    const operation = native?.[name];
    if (typeof operation === "function")
        return operation.bind(native);
    commandFallback();
    return undefined;
}
/** Full Windows identity, with security validation when requested; no repairs. */
export function inspectCreationDirectorySync(targetPath, privatePath) {
    assertNoWindowsPathAlias(targetPath, "filesystem");
    const inspect = creationOperation("inspectWindowsDirectory");
    return (inspect ? inspect(targetPath, privatePath) : inspectWindowsDirectoryCommandSync(targetPath, privatePath)).identity;
}
export async function inspectCreationDirectory(targetPath, privatePath) {
    assertNoWindowsPathAlias(targetPath, "filesystem");
    const inspect = creationOperation("inspectWindowsDirectory");
    return (inspect ? inspect(targetPath, privatePath) : await inspectWindowsDirectoryCommand(targetPath, privatePath)).identity;
}
export function assertPrivateDirectorySync(targetPath) {
    const stat = inspectDirectoryIdentitySync(targetPath);
    if (process.platform === "win32")
        inspectCreationDirectorySync(targetPath, true);
    else {
        assertPrivatePosixDirectory(stat);
        assertDarwinCreationDirectoryAcl(targetPath, stat);
    }
    inspectDirectoryIdentitySync(targetPath, stat);
}
export async function assertPrivateDirectory(targetPath) {
    const stat = inspectDirectoryIdentitySync(targetPath);
    if (process.platform === "win32")
        await inspectCreationDirectory(targetPath, true);
    else {
        assertPrivatePosixDirectory(stat);
        assertDarwinCreationDirectoryAcl(targetPath, stat);
    }
    inspectDirectoryIdentitySync(targetPath, stat);
}
export function protectCreatedFileSync(fd, targetPath, parentIdentity) {
    const protect = creationOperation("protectPrivateWindowsFile");
    return (protect ? protect(fd, targetPath, parentIdentity)
        : protectPrivateWindowsFileCommandSync(fd, targetPath, parentIdentity)).identity;
}
export async function protectCreatedFile(fd, targetPath, parentIdentity) {
    const protect = creationOperation("protectPrivateWindowsFile");
    return (protect ? protect(fd, targetPath, parentIdentity)
        : await protectPrivateWindowsFileCommand(fd, targetPath, parentIdentity)).identity;
}
export function verifyCreatedFileSync(fd, targetPath, identity, parentIdentity, links = 1) {
    const verify = creationOperation("verifyPrivateWindowsFile");
    if (verify)
        verify(fd, targetPath, identity, parentIdentity, links);
    else
        verifyPrivateWindowsFileCommandSync(fd, targetPath, identity, parentIdentity, links);
}
export async function verifyCreatedFile(fd, targetPath, identity, parentIdentity, links = 1) {
    const verify = creationOperation("verifyPrivateWindowsFile");
    if (verify)
        verify(fd, targetPath, identity, parentIdentity, links);
    else
        await verifyPrivateWindowsFileCommand(fd, targetPath, identity, parentIdentity, links);
}
function inspector() {
    const native = getNativeBinding();
    if (typeof native?.inspectDarwinAcl !== "function") {
        throw new FsSafeError("helper-unavailable", "private Darwin creation requires native descriptor ACL inspection");
    }
    return native.inspectDarwinAcl.bind(native);
}
export function assertDarwinPrivateCreationAvailable() {
    if (process.platform === "darwin")
        inspector();
}
export function assertDarwinPrivateDirectoryMode(mode) {
    if (process.platform === "darwin" && ((mode & ~process.umask()) & 0o500) === 0) {
        throw new FsSafeError("helper-unavailable", "private Darwin directory ACL inspection requires owner read or search permission");
    }
}
export function assertDarwinCreationAcl(fd, inheritanceTarget) {
    if (process.platform !== "darwin")
        return;
    const inspect = inspector();
    const state = inspect(fd, inheritanceTarget)?.state;
    if (state === "present") {
        throw new FsSafeError("insecure-permissions", inheritanceTarget
            ? "private creation parent has inheritable Darwin ACL entries"
            : "private creation object has Darwin ACL entries");
    }
    if (state !== "absent" && state !== "empty") {
        throw new FsSafeError("helper-unavailable", "native Darwin ACL inspection returned incomplete facts");
    }
}
export function assertDarwinCreationDirectoryAcl(pathname, expected, inheritanceTarget) {
    if (process.platform !== "darwin")
        return;
    assertDarwinPrivateCreationAvailable();
    let fd;
    try {
        fd = fs.openSync(pathname, nodeDarwinDirectoryMetadataFlags());
    }
    catch (error) {
        if (error.code !== "EACCES")
            throw error;
        const search = nodeDirectorySearchOnlyFlags();
        if (!search)
            throw error;
        try {
            fd = fs.openSync(pathname, search.flags | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        }
        catch (cause) {
            if (cause.code !== "EACCES")
                throw cause;
            throw new FsSafeError("helper-unavailable", "private Darwin directory ACL inspection requires owner read or search permission", { cause });
        }
    }
    try {
        const opened = inspectFileIdentitySync(() => fs.fstatSync(fd, { bigint: true }), expected);
        if (!opened.isDirectory())
            throw new FsSafeError("path-mismatch", "ACL target is not the admitted directory");
        assertDarwinCreationAcl(fd, inheritanceTarget);
        inspectDirectoryIdentitySync(pathname, expected);
    }
    finally {
        fs.closeSync(fd);
    }
}
export function assertCreationFile(fd, pathname, expected) {
    const opened = inspectFileIdentitySync(() => fs.fstatSync(fd, { bigint: true }), expected);
    const named = inspectFileIdentitySync(() => fs.lstatSync(pathname, { bigint: true }), opened);
    if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() || opened.nlink !== 1n || named.nlink !== 1n) {
        throw new FsSafeError("path-mismatch", "created file is not the expected single-linked regular file");
    }
    return opened;
}
export function assertPrivateCreationFile(stat, fd) {
    if (process.platform === "win32")
        return;
    if (typeof process.getuid !== "function" || stat.uid !== BigInt(process.getuid())) {
        throw new FsSafeError("not-owned", "created private file must belong to the current user");
    }
    if ((stat.mode & 3647n) !== 0n) {
        throw new FsSafeError("insecure-permissions", "created private file is not owner-only");
    }
    assertDarwinCreationAcl(fd);
}
function assertRecordedFile(current, identity) {
    if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentityForCleanup(current, identity)) {
        throw new FsSafeError("path-mismatch", "created file cleanup preserved a replacement");
    }
}
export function removeRecordedCreationFileSync(pathname, identity, assertParent) {
    assertParent();
    let current;
    try {
        current = fs.lstatSync(pathname, { bigint: true });
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return;
        throw error;
    }
    assertRecordedFile(current, identity);
    fs.unlinkSync(pathname);
}
export async function removeRecordedCreationFile(pathname, identity, assertParent) {
    assertParent();
    let current;
    try {
        current = await fsAsync.lstat(pathname, { bigint: true });
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return;
        throw error;
    }
    assertParent();
    assertRecordedFile(current, identity);
    // Recheck after the awaited observation before dispatching the unlink.
    assertRecordedFile(fs.lstatSync(pathname, { bigint: true }), identity);
    await fsAsync.unlink(pathname);
}
export function creationPublicationAfterFailure(error, recorded) {
    if (error instanceof FsSafeError) {
        const publication = error.details?.publication;
        if (publication && typeof publication === "object" && "status" in publication &&
            publication.status === "indeterminate")
            return "indeterminate";
    }
    return recorded;
}
export function hasPreservedCreationArtifacts(error) {
    if (!(error instanceof FsSafeError))
        return false;
    if (error.details?.cleanup === "preserved" || error.details?.cleanup === "failed")
        return true;
    const publication = error.details?.publication;
    return publication !== null && typeof publication === "object" && "status" in publication &&
        (publication.status === "published" || publication.status === "indeterminate");
}
export function rethrowPrivateStageCreationFailure(error, path, stageDirectory) {
    if (error instanceof FsSafeError && error.code === "already-exists") {
        throw new FsSafeError("helper-failed", "private file staging path already exists", {
            cause: error, details: { publication: { status: "not-published" }, path, stageDirectory },
        });
    }
    const publication = error instanceof FsSafeError ? error.details?.publication : undefined;
    const created = error instanceof FsSafeError && error.details?.path === stageDirectory &&
        publication !== null && typeof publication === "object" && "status" in publication &&
        publication.status === "published";
    let unconfirmed = hasUnsettledWindowsSecurityCommand(error);
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
        try {
            const outcome = Object.getOwnPropertyDescriptor(error, "creationOutcome");
            unconfirmed ||= Boolean(outcome && "value" in outcome && outcome.value === "unconfirmed");
        }
        catch {
            unconfirmed = true;
        }
    }
    if (created || unconfirmed) {
        throw privateFileSettlementFailure({
            primary: error, cleanup: [], publication: "not-published", path, stageDirectory, preserved: true,
        });
    }
    throw error;
}
export function privateFileSettlementFailure(params) {
    return new FsSafeError("helper-failed", "file creation or staging settlement failed", {
        cause: params.cleanup.length
            ? new AggregateError([params.primary, ...params.cleanup], "file creation and cleanup failed")
            : params.primary,
        details: {
            publication: { status: params.publication }, path: params.path, stageDirectory: params.stageDirectory,
            cleanup: params.preserved || params.publication === "indeterminate" ? "preserved" : params.cleanup.length ? "failed" : "removed",
        },
    });
}
export function assertBeforeCreation(selected, permissions, assertion, kind) {
    if (permissions.private)
        assertDarwinCreationDirectoryAcl(selected.parent.dir, selected.parent.stat, kind);
    assertSynchronousCallbackResult(assertion?.(), "assertBeforeMutation");
    selected.assertParent();
    if (permissions.private && kind === "directory")
        assertDarwinPrivateDirectoryMode(permissions.mode);
    if (permissions.private)
        assertDarwinCreationDirectoryAcl(selected.parent.dir, selected.parent.stat, kind);
}
export function creationAdmissionFromParent(parent) {
    const { dev, ino } = parent.stat;
    if (typeof dev !== "bigint" || typeof ino !== "bigint") {
        throw new FsSafeError("path-mismatch", "private creation requires an exact parent identity");
    }
    const identity = inspectDirectoryIdentitySync(parent.dir, { dev, ino });
    return { expectedParentIdentity: { dev: identity.dev, ino: identity.ino, realPath: parent.realPath } };
}
export function prepareCreationPath(input, expectedParent) {
    expectedParent = expectedParent && { dev: expectedParent.dev, ino: expectedParent.ino, realPath: expectedParent.realPath };
    assertNoNulPathInput(input);
    assertNoWindowsPathAlias(input, "filesystem");
    if (process.platform === "win32" && input.replaceAll("/", "\\").split("\\")
        .some(component => component.endsWith(".") || component.endsWith(" "))) {
        throw new FsSafeError("invalid-path", "creation path contains an ambiguous Windows component");
    }
    const target = resolvePathPreservingWindowsRoot(input);
    const directory = path.dirname(target);
    if (target === directory || input.length === 0) {
        throw new FsSafeError("invalid-path", "creation requires a child name");
    }
    if (expectedParent)
        assertDirectoryIdentitySync(directory, expectedParent);
    const stat = inspectDirectoryIdentitySync(directory);
    const realPath = realpathSync.native(directory);
    const parent = { dir: directory, realPath, stat };
    const assertParent = () => {
        assertDirectoryIdentitySync(directory, { dev: stat.dev, ino: stat.ino, realPath });
        if (expectedParent)
            assertDirectoryIdentitySync(directory, expectedParent);
    };
    assertParent();
    return { target, parent, assertParent };
}
export function creationCollision(error) {
    if (error?.code === "EEXIST") {
        return new FsSafeError("already-exists", "creation target already exists", { cause: error });
    }
    return error;
}
/** Remove only the recorded empty stage; never traverse a replaced directory. */
export function removeCreationDirectory(directory, identity, assertParent) {
    assertParent();
    try {
        assertDirectoryIdentitySync(directory, identity);
        fs.rmdirSync(directory);
    }
    catch (error) {
        if (error?.code !== "ENOENT")
            throw error;
    }
}
export async function removeCreationDirectoryAsync(directory, identity, assertParent) {
    assertParent();
    try {
        assertDirectoryIdentitySync(directory, identity);
        await fsAsync.rmdir(directory);
    }
    catch (error) {
        if (error?.code !== "ENOENT")
            throw error;
    }
}
