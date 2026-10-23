import fsSync from "node:fs";
import { sameFileIdentityForCleanup } from "./file-identity.js";
const tempCleanupEntries = new Map();
let cleanupRegistered = false;
function pathStillMatchesReceipt(entry) {
    if (!entry.identity) {
        return false;
    }
    try {
        const current = fsSync.lstatSync(entry.path, { bigint: true });
        return (!entry.singleLinkFile || (current.isFile() && current.nlink === 1n)) &&
            sameFileIdentityForCleanup(current, entry.identity);
    }
    catch {
        // A missing pathname grants no authority over an entry created after this lookup.
        return false;
    }
}
function removeRegisteredPathSync(entry) {
    if (entry.singleLinkFile)
        fsSync.unlinkSync(entry.path);
    else
        fsSync.rmSync(entry.path, { force: true, recursive: entry.recursive });
}
function cleanupEntrySync(entry) {
    if (entry.cleanupSync) {
        entry.cleanupSync();
    }
    else if (pathStillMatchesReceipt(entry)) {
        removeRegisteredPathSync(entry);
    }
}
function cleanupRegisteredTempPathsSync() {
    for (const entry of tempCleanupEntries.values()) {
        try {
            cleanupEntrySync(entry);
        }
        catch {
            // Process-exit cleanup is best-effort.
        }
    }
    tempCleanupEntries.clear();
}
export function registerTempPathForExit(tempPath, options) {
    if (!cleanupRegistered) {
        cleanupRegistered = true;
        process.once("exit", cleanupRegisteredTempPathsSync);
    }
    const entry = {
        path: tempPath,
        recursive: options?.recursive === true,
        identity: options?.identity,
        singleLinkFile: options?.singleLinkFile,
        cleanupSync: options?.cleanupSync,
    };
    // Only the caller's receipt or cleanup callback grants removal authority.
    tempCleanupEntries.set(tempPath, entry);
    const unregister = (() => {
        if (tempCleanupEntries.get(tempPath) === entry)
            tempCleanupEntries.delete(tempPath);
    });
    unregister.setIdentity = (identity) => {
        entry.identity = identity;
    };
    return unregister;
}
export function __cleanupRegisteredTempPathsForTest() {
    cleanupRegisteredTempPathsSync();
}
export function __cleanupRegisteredTempPathForTest(tempPath) {
    const entry = tempCleanupEntries.get(tempPath);
    if (!entry) {
        return;
    }
    try {
        cleanupEntrySync(entry);
    }
    finally {
        tempCleanupEntries.delete(tempPath);
    }
}
