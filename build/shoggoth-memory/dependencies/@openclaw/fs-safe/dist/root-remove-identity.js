import fsSync from "node:fs";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { realpathSync } from "./realpath.js";
import { directoryComponentNotDirectoryError, errorCauseOptions } from "./root-errors.js";
const MAX_SAFE_DIRECTORY_IDENTITY = BigInt(Number.MAX_SAFE_INTEGER);
function identityMismatch(cause) {
    return new FsSafeError("path-mismatch", "removal ancestor identity changed or could not be verified", errorCauseOptions(cause));
}
function safeIdentityNumber(value) {
    if (value < 0n || value > MAX_SAFE_DIRECTORY_IDENTITY)
        return undefined;
    return Number(value);
}
export function createRemovalDirectoryAssertion(path, identity, realPath, platform = process.platform) {
    const dev = safeIdentityNumber(identity.dev);
    const ino = safeIdentityNumber(identity.ino);
    const numeric = dev !== undefined && ino !== undefined &&
        (platform !== "win32" || (dev !== 0 && ino !== 0));
    return Object.freeze({
        path,
        dev: identity.dev,
        ino: identity.ino,
        numericDev: numeric ? dev : undefined,
        numericIno: numeric ? ino : undefined,
        platform,
        realPath,
    });
}
function assertDirectoryType(stat) {
    if (typeof stat?.isDirectory !== "function" || typeof stat.isSymbolicLink !== "function") {
        throw identityMismatch();
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
        throw directoryComponentNotDirectoryError();
}
function assertExactObservation(stat, expected, platform) {
    assertDirectoryType(stat);
    if (typeof stat.dev !== "bigint" || typeof stat.ino !== "bigint")
        throw identityMismatch();
    if (platform === "win32" && (stat.dev === 0n || stat.ino === 0n))
        throw identityMismatch();
    if (stat.dev !== expected.dev || stat.ino !== expected.ino)
        throw identityMismatch();
}
function assertNumericObservation(assertion) {
    const stat = fsSync.lstatSync(assertion.path);
    assertDirectoryType(stat);
    if (!Number.isSafeInteger(stat.dev) || stat.dev < 0 ||
        !Number.isSafeInteger(stat.ino) || stat.ino < 0) {
        throw identityMismatch();
    }
    let unknown = false;
    const observedDev = stat.dev;
    const expectedDev = assertion.numericDev;
    if (assertion.platform === "win32" && observedDev === 0) {
        unknown = true;
    }
    else if (observedDev !== expectedDev) {
        // Reject a known mismatch before considering an unknown companion field.
        throw identityMismatch();
    }
    const observedIno = stat.ino;
    const expectedIno = assertion.numericIno;
    if (assertion.platform === "win32" && observedIno === 0) {
        unknown = true;
    }
    else if (observedIno !== expectedIno) {
        throw identityMismatch();
    }
    if (unknown) {
        // The numeric lstat is the first observation. Permit one exact retry only,
        // retaining every known component and the original exact admission receipt.
        assertExactObservation(fsSync.lstatSync(assertion.path, { bigint: true }), assertion, assertion.platform);
    }
}
export function assertRemovalDirectoryCurrent(assertion) {
    if (assertion.numericDev !== undefined && assertion.numericIno !== undefined) {
        assertNumericObservation(assertion);
    }
    else {
        inspectDirectoryIdentitySync(assertion.path, assertion, undefined, assertion.platform);
    }
    if (assertion.realPath !== undefined && realpathSync.native(assertion.path) !== assertion.realPath) {
        throw identityMismatch();
    }
}
