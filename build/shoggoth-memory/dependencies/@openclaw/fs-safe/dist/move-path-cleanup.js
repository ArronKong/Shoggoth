import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
export function entryIdentity(stat) {
    return {
        ctimeNs: stat.ctimeNs,
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        mtimeNs: stat.mtimeNs,
        nlink: stat.nlink,
        size: stat.size,
    };
}
export function sameIdentity(a, b) {
    return (a.dev === b.dev &&
        a.ino === b.ino &&
        a.mode === b.mode &&
        a.nlink === b.nlink &&
        a.size === b.size &&
        a.mtimeNs === b.mtimeNs &&
        a.ctimeNs === b.ctimeNs);
}
export function sourceChangedError(sourcePath) {
    return Object.assign(new Error(`Source changed during move fallback: ${sourcePath}`), {
        code: "ESTALE",
    });
}
export function inspectSourceEntry(sourcePath, observe) {
    return inspectFileIdentitySync(observe, undefined, process.platform, () => sourceChangedError(sourcePath));
}
export function inspectSourceDirectory(sourcePath, expected) {
    try {
        return inspectDirectoryIdentitySync(sourcePath, expected);
    }
    catch (error) {
        const code = error?.code;
        if (code === "ENOENT" || code === "ENOTDIR" ||
            (error instanceof FsSafeError && (error.code === "path-mismatch" || error.code === "not-file"))) {
            throw sourceChangedError(sourcePath);
        }
        throw error;
    }
}
export async function assertSourceStillMatches(sourcePath, identity) {
    if (!sameIdentity(identity, inspectSourceEntry(sourcePath, () => fsSync.lstatSync(sourcePath, { bigint: true })))) {
        throw sourceChangedError(sourcePath);
    }
}
function identityKey(identity) {
    return `${identity.dev}:${identity.ino}`;
}
function collectAliasCandidates(sourcePath, manifest, candidates) {
    if (manifest.kind === "directory") {
        for (const child of manifest.children) {
            collectAliasCandidates(path.join(sourcePath, child.name), child.manifest, candidates);
        }
        return;
    }
    if (manifest.nlink <= 1n) {
        return;
    }
    const key = identityKey(manifest);
    const entries = candidates.get(key) ?? [];
    entries.push({ manifest, path: sourcePath });
    candidates.set(key, entries);
}
export function createCleanupCopiedEntryState(sourcePath, manifest) {
    const candidates = new Map();
    collectAliasCandidates(sourcePath, manifest, candidates);
    const aliasGroups = new Map();
    for (const [key, entries] of candidates) {
        if (entries.length < 2) {
            continue;
        }
        const first = entries[0];
        if (!first || entries.some((entry) => !sameIdentity(first.manifest, entry.manifest))) {
            throw sourceChangedError(sourcePath);
        }
        aliasGroups.set(key, {
            expected: first.manifest,
            remainingPaths: new Set(entries.map((entry) => entry.path)),
            stale: false,
        });
    }
    return { aliasGroups };
}
function sameOwnedUnlinkTransition(before, after) {
    return (before.dev === after.dev &&
        before.ino === after.ino &&
        before.mode === after.mode &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.nlink > 0n &&
        after.nlink === before.nlink - 1n &&
        after.ctimeNs >= before.ctimeNs);
}
function poisonAliasGroup(group) {
    group.stale = true;
    return "stale";
}
function inspectCleanupLeaf(sourcePath, expected) {
    let mismatch;
    try {
        return inspectFileIdentitySync(() => fsSync.lstatSync(sourcePath, { bigint: true }), expected, process.platform, () => mismatch = sourceChangedError(sourcePath));
    }
    catch (error) {
        if (mismatch !== undefined && error === mismatch)
            return undefined;
        throw error;
    }
}
async function observeOwnedAliasUnlink(sourcePath, group) {
    group.remainingPaths.delete(sourcePath);
    const remainingPath = group.remainingPaths.values().next().value;
    if (!remainingPath) {
        return "removed";
    }
    let observed;
    try {
        observed = inspectCleanupLeaf(remainingPath, group.expected);
    }
    catch (error) {
        if (error?.code === "ENOENT") {
            return poisonAliasGroup(group);
        }
        throw error;
    }
    if (!observed || !sameOwnedUnlinkTransition(group.expected, observed)) {
        return poisonAliasGroup(group);
    }
    group.expected = entryIdentity(observed);
    return "removed";
}
export async function cleanupCopiedEntry(sourcePath, manifest, state, assertBeforeMutation) {
    if (manifest.kind === "directory") {
        let currentStat;
        try {
            currentStat = inspectFileIdentitySync(() => fsSync.lstatSync(sourcePath, { bigint: true }), manifest.directoryIdentity);
        }
        catch (error) {
            if (error?.code === "ENOENT")
                return "removed";
            if (error instanceof FsSafeError && error.code === "path-mismatch")
                return "stale";
            throw error;
        }
        if (!currentStat.isDirectory()) {
            return "stale";
        }
        // A same-inode directory can gain unrelated children after commit. Still
        // clean manifest children so the fallback does not duplicate copied files.
        let result = "removed";
        const assertBeforeChildMutation = assertBeforeMutation ? () => {
            assertBeforeMutation();
            inspectSourceDirectory(sourcePath, manifest.directoryIdentity);
        } : undefined;
        for (const child of manifest.children) {
            const childResult = await cleanupCopiedEntry(path.join(sourcePath, child.name), child.manifest, state, assertBeforeChildMutation);
            if (childResult === "stale") {
                result = "stale";
            }
        }
        // Child cleanup and the caller's authority check can replace the directory.
        // Keep the final exact observation after both, immediately before removal.
        assertBeforeMutation?.();
        try {
            currentStat = inspectFileIdentitySync(() => fsSync.lstatSync(sourcePath, { bigint: true }), manifest.directoryIdentity);
        }
        catch (error) {
            if (error?.code === "ENOENT") {
                return "stale";
            }
            if (error instanceof FsSafeError && error.code === "path-mismatch")
                return "stale";
            throw error;
        }
        if (!currentStat.isDirectory()) {
            return "stale";
        }
        try {
            await fs.rmdir(sourcePath);
        }
        catch (error) {
            const code = error?.code;
            if (code === "ENOTEMPTY" || code === "EEXIST") {
                return "stale";
            }
            throw error;
        }
        return result;
    }
    const aliasGroup = state.aliasGroups.get(identityKey(manifest));
    if (aliasGroup?.stale) {
        return "stale";
    }
    const expected = aliasGroup?.expected ?? manifest;
    let currentStat;
    try {
        currentStat = inspectCleanupLeaf(sourcePath, expected);
    }
    catch (error) {
        if (error?.code === "ENOENT") {
            return aliasGroup ? poisonAliasGroup(aliasGroup) : "removed";
        }
        throw error;
    }
    for (let observation = 0;; observation++) {
        if (!currentStat || !sameIdentity(expected, currentStat)) {
            return aliasGroup ? poisonAliasGroup(aliasGroup) : "stale";
        }
        if (observation || !assertBeforeMutation)
            break;
        assertBeforeMutation();
        currentStat = inspectCleanupLeaf(sourcePath, expected);
    }
    await fs.unlink(sourcePath);
    return aliasGroup
        ? await observeOwnedAliasUnlink(sourcePath, aliasGroup)
        : "removed";
}
