import fsSync, {} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectDirectoryIdentitySync, observeDirectoryIdentitySync, } from "./directory-guard.js";
import { admitTempWorkspaceChild, admitTempWorkspaceChildSync, assertTrustedTempWorkspaceDirectory, inspectTempWorkspaceDescriptorIdentitySync, projectTempWorkspaceNumericIdentity, TEMP_WORKSPACE_NUMERIC_IDENTITY_REPLAY, } from "./temp-workspace-child-admission.js";
import { FsSafeError } from "./errors.js";
import { realpathSync } from "./realpath.js";
import { assertNoWindowsPathAlias, pathForWindowsFilesystem, resolvePathPreservingWindowsRoot, } from "./windows-path-alias.js";
import { fileIdentityMismatchError, inspectFileIdentitySync } from "./strict-file-identity.js";
const WINDOWS = process.platform === "win32";
function effectiveOwner() {
    // Windows mode/uid fields do not describe ACL authority. The supplied root's
    // ACL remains a caller trust requirement, independently of cleanup safety.
    if (WINDOWS)
        return undefined;
    let uid;
    try {
        uid = process.geteuid?.();
    }
    catch (cause) {
        throw new FsSafeError("permission-unverified", "temp workspace requires effective owner identity", { cause });
    }
    if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) {
        throw new FsSafeError("permission-unverified", "temp workspace requires effective owner identity");
    }
    return uid;
}
function safeNumericIdentity(stat) {
    const numeric = projectTempWorkspaceNumericIdentity(stat);
    return numeric && (!WINDOWS || (numeric.dev !== 0 && numeric.ino !== 0))
        ? numeric
        : undefined;
}
function copyExactDirectoryObservation(stat) {
    return Object.freeze({
        dev: stat.dev,
        ino: stat.ino,
        uid: stat.uid,
        gid: stat.gid,
        mode: stat.mode,
        directory: stat.isDirectory(),
        symbolicLink: stat.isSymbolicLink(),
    });
}
function snapshotFromExactObservation(dir, uid, realPath, stat, privateDirectory = false) {
    if (stat.symbolicLink || !stat.directory) {
        throw new FsSafeError("not-file", "temp workspace root component must be a real directory");
    }
    assertTrustedTempWorkspaceDirectory(stat, uid, privateDirectory);
    const identity = Object.freeze({ dev: stat.dev, ino: stat.ino });
    // Retain copied immutable scalars, never a mutable Stats object supplied by
    // an observation hook. Every later permission check uses a fresh snapshot.
    return Object.freeze({ dir, identity, numericIdentity: safeNumericIdentity(stat), realPath, privateDirectory });
}
function canonicalTempWorkspacePath(dir) {
    assertNoWindowsPathAlias(dir, "filesystem");
    const canonical = realpathSync.native(pathForWindowsFilesystem(dir));
    assertNoWindowsPathAlias(canonical, "filesystem");
    return canonical;
}
function snapshot(dir, uid, realPath = canonicalTempWorkspacePath(dir), privateDirectory = false) {
    const stat = inspectDirectoryIdentitySync(dir);
    const observation = copyExactDirectoryObservation(stat);
    return { entry: snapshotFromExactObservation(dir, uid, realPath, observation, privateDirectory), stat };
}
function hasCompleteExactIdentity(stat) {
    return typeof stat.dev === "bigint" && typeof stat.ino === "bigint" &&
        (!WINDOWS || (stat.dev !== 0n && stat.ino !== 0n));
}
function assertCanonicalRoot(entry) {
    if (canonicalTempWorkspacePath(entry.dir) !== entry.realPath) {
        throw new FsSafeError("path-mismatch", "temp workspace root ancestry changed");
    }
}
function inspectSnapshotIdentity(entry) {
    const expected = entry.numericIdentity;
    if (!expected) {
        return inspectDirectoryIdentitySync(entry.dir, entry.identity);
    }
    const stat = observeDirectoryIdentitySync(entry.dir);
    let requiresExactRetry = false;
    const devKnown = Number.isSafeInteger(stat.dev) && stat.dev >= 0 && (!WINDOWS || stat.dev !== 0);
    if (devKnown) {
        if (stat.dev !== expected.dev)
            throw fileIdentityMismatchError();
    }
    else if (WINDOWS)
        requiresExactRetry = true;
    else
        throw fileIdentityMismatchError();
    const inoKnown = Number.isSafeInteger(stat.ino) && stat.ino >= 0 && (!WINDOWS || stat.ino !== 0);
    if (inoKnown) {
        if (stat.ino !== expected.ino)
            throw fileIdentityMismatchError();
    }
    else if (WINDOWS)
        requiresExactRetry = true;
    else
        throw fileIdentityMismatchError();
    if (!requiresExactRetry)
        return stat;
    // Read exact identity only once. The strict helper may re-check this constant
    // receipt in memory when Windows still reports an unknown component.
    const exact = observeDirectoryIdentitySync(entry.dir, { bigint: true });
    return inspectFileIdentitySync(() => exact, entry.identity);
}
function assertSnapshot(entry, uid) {
    const stat = inspectSnapshotIdentity(entry);
    assertTrustedTempWorkspaceDirectory(stat, uid, entry.privateDirectory);
    assertCanonicalRoot(entry);
}
function snapshotMissingRootComponent(parent, dir, ownerUid, privateDirectory) {
    if (parent.dir !== parent.realPath) {
        assertSnapshot(parent, ownerUid);
        return snapshot(dir, ownerUid, undefined, privateDirectory);
    }
    const current = inspectSnapshotIdentity(parent);
    assertTrustedTempWorkspaceDirectory(current, ownerUid, parent.privateDirectory);
    let realPath;
    try {
        realPath = canonicalTempWorkspacePath(dir);
    }
    catch (error) {
        // Keep parent resolution failures ahead of a missing or unreadable child.
        assertCanonicalRoot(parent);
        throw error;
    }
    if (path.dirname(realPath) !== parent.realPath) {
        assertCanonicalRoot(parent);
        return snapshot(dir, ownerUid, undefined, privateDirectory);
    }
    // The child's canonical parent confirms the same parent name at this phase.
    // Its exact non-symlink/owner observation still precedes mode initialization.
    return snapshot(dir, ownerUid, realPath, privateDirectory);
}
function assertChain(chain, uid) {
    for (const entry of chain) {
        const current = inspectSnapshotIdentity(entry);
        assertTrustedTempWorkspaceDirectory(current, uid, entry.privateDirectory);
    }
    const last = chain[chain.length - 1];
    assertCanonicalRoot(last);
}
function canonicalAncestry(root) {
    const ancestry = [];
    for (let current = root;; current = path.dirname(current)) {
        ancestry.push(current);
        if (path.dirname(current) === current)
            break;
    }
    return ancestry.reverse();
}
function exactIdentityMatches(current, expected) {
    if (current.dev !== expected.dev || current.ino !== expected.ino)
        throw fileIdentityMismatchError();
}
function associateTempWorkspaceRoot(entry, ownerUid, descriptorFd) {
    const stat = inspectTempWorkspaceDescriptorIdentitySync(descriptorFd, entry.identity, entry.numericIdentity);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new FsSafeError("not-file", "temp workspace cleanup parent must be a real directory");
    }
    assertTrustedTempWorkspaceDirectory(stat, ownerUid, entry.privateDirectory);
}
function discoverMissingTempWorkspaceAncestor(ancestor, missing, missingError) {
    // The caller already classified the first ENOENT. Keep this handoff out of
    // the probe catch so neither it nor a later failure is classified twice.
    const initialParent = path.dirname(ancestor);
    if (initialParent === ancestor)
        throw missingError;
    missing.push(path.basename(ancestor));
    ancestor = initialParent;
    for (;;) {
        try {
            // Only subsequent non-volume-root probes may return a missing receipt.
            const parent = path.dirname(ancestor);
            const allowMissing = parent !== ancestor;
            assertNoWindowsPathAlias(ancestor, "filesystem");
            const operationPath = pathForWindowsFilesystem(ancestor);
            const stat = allowMissing
                ? fsSync.lstatSync(operationPath, { bigint: true, throwIfNoEntry: false })
                : fsSync.lstatSync(operationPath, { bigint: true });
            if (allowMissing && stat === undefined) {
                missing.push(path.basename(ancestor));
                ancestor = parent;
                continue;
            }
            return { ancestor, initial: copyExactDirectoryObservation(stat) };
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            const parent = path.dirname(ancestor);
            if (parent === ancestor)
                throw error;
            missing.push(path.basename(ancestor));
            ancestor = parent;
        }
    }
}
function rootPlan(rootDir) {
    assertNoWindowsPathAlias(rootDir, "filesystem");
    const ownerUid = effectiveOwner();
    let ancestor = resolvePathPreservingWindowsRoot(rootDir);
    assertNoWindowsPathAlias(ancestor, "filesystem");
    const missing = [];
    let initial;
    try {
        initial = copyExactDirectoryObservation(fsSync.lstatSync(pathForWindowsFilesystem(ancestor), { bigint: true }));
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        ({ ancestor, initial } = discoverMissingTempWorkspaceAncestor(ancestor, missing, error));
    }
    missing.reverse();
    // Keep the historical support for a caller-approved root alias and standard
    // system aliases such as macOS /var. A dangling alias fails canonicalization.
    const observedAncestor = ancestor;
    ancestor = canonicalTempWorkspacePath(observedAncestor);
    const existingCanonicalRoot = missing.length === 0 && observedAncestor === ancestor &&
        !initial.symbolicLink && initial.directory && hasCompleteExactIdentity(initial);
    if (existingCanonicalRoot) {
        const discovery = snapshotFromExactObservation(ancestor, ownerUid, ancestor, initial, true);
        return {
            admission: canonicalRootAdmission(discovery, ownerUid),
            missing,
            ownerUid,
        };
    }
    const chain = canonicalAncestry(ancestor).map((dir) => snapshot(dir, ownerUid, dir, missing.length === 0 && dir === ancestor).entry);
    // Missing-component creation needs a replay before its first mutation. When
    // the complete root already exists through an alias, retain the historical
    // guarded route because discovery and mutation use different path spellings.
    if (missing.length > 0)
        assertChain(chain, ownerUid);
    return { chain, missing, ownerUid };
}
function rootAdmission(chain, ownerUid) {
    // Bind the immediate parent now: missing-component creation appends to chain.
    const current = chain[chain.length - 1];
    return {
        dir: current.dir,
        ownerUid,
        retainCleanupParent: (descriptorFd) => {
            assertSnapshot(current, ownerUid);
            associateTempWorkspaceRoot(current, ownerUid, descriptorFd);
        },
        // The guarded route associated the cleanup parent while retaining it.
        // A native capability probe therefore needs no additional observation.
        prepareCleanupProbe: () => { },
        prepareChildCreation: () => { assertChain(chain, ownerUid); },
        assertCurrent: () => { assertSnapshot(current, ownerUid); },
        assertAncestry: () => { assertChain(chain, ownerUid); },
        associateCurrent: (descriptorFd) => {
            assertSnapshot(current, ownerUid);
            associateTempWorkspaceRoot(current, ownerUid, descriptorFd);
        },
        associateAncestry: (descriptorFd) => {
            assertChain(chain, ownerUid);
            associateTempWorkspaceRoot(current, ownerUid, descriptorFd);
        },
    };
}
function canonicalRootAdmission(discovery, ownerUid) {
    let admittedChain;
    const chain = () => {
        if (!admittedChain) {
            throw new FsSafeError("path-mismatch", "temp workspace root has not completed creation admission");
        }
        return admittedChain;
    };
    return {
        dir: discovery.dir,
        ownerUid,
        // Merely opening the cleanup-parent descriptor grants no authority. The
        // exact association is completed only at a bounded probe or the mutation
        // boundary below.
        retainCleanupParent: () => { },
        prepareCleanupProbe: (descriptorFd) => {
            // A native feature probe may inspect only a descriptor associated with
            // the originally discovered root. This remains provisional: the named
            // root and complete ancestry are freshly admitted before mutation.
            assertCanonicalRoot(discovery);
            associateTempWorkspaceRoot(discovery, ownerUid, descriptorFd);
        },
        prepareChildCreation: (descriptorFd) => {
            const ancestry = canonicalAncestry(discovery.dir);
            const candidate = ancestry.map((dir, index) => {
                if (!TEMP_WORKSPACE_NUMERIC_IDENTITY_REPLAY || index !== ancestry.length - 1) {
                    return snapshot(dir, ownerUid, dir, index === ancestry.length - 1 && discovery.privateDirectory).entry;
                }
                const current = inspectSnapshotIdentity(discovery);
                assertTrustedTempWorkspaceDirectory(current, ownerUid, discovery.privateDirectory);
                return discovery;
            });
            const current = candidate[candidate.length - 1];
            exactIdentityMatches(current.identity, discovery.identity);
            assertCanonicalRoot(current);
            if (descriptorFd !== undefined) {
                associateTempWorkspaceRoot(current, ownerUid, descriptorFd);
            }
            // Do not expose even the ancestry receipts until every named and
            // descriptor association at this pre-mutation boundary has succeeded.
            admittedChain = candidate;
        },
        assertCurrent: () => {
            const currentChain = chain();
            assertSnapshot(currentChain[currentChain.length - 1], ownerUid);
        },
        assertAncestry: () => { assertChain(chain(), ownerUid); },
        associateCurrent: (descriptorFd) => {
            const currentChain = chain();
            const current = currentChain[currentChain.length - 1];
            assertSnapshot(current, ownerUid);
            associateTempWorkspaceRoot(current, ownerUid, descriptorFd);
        },
        associateAncestry: (descriptorFd) => {
            const currentChain = chain();
            assertChain(currentChain, ownerUid);
            associateTempWorkspaceRoot(currentChain[currentChain.length - 1], ownerUid, descriptorFd);
        },
    };
}
export function admitExistingTempWorkspaceRoot(rootDir) {
    const { admission, chain, missing, ownerUid } = rootPlan(rootDir);
    if (missing.length > 0) {
        throw new FsSafeError("helper-unavailable", "temp file cleanup parent is unavailable");
    }
    return admission ?? rootAdmission(chain, ownerUid);
}
export async function admitTempWorkspaceRoot(rootDir) {
    const { admission, chain, missing, ownerUid } = rootPlan(rootDir);
    if (admission)
        return admission;
    const guardedChain = chain;
    for (const [index, segment] of missing.entries()) {
        const parentEntry = guardedChain[guardedChain.length - 1];
        const parent = rootAdmission(guardedChain, ownerUid);
        const dir = path.join(parent.dir, segment);
        assertNoWindowsPathAlias(dir, "filesystem");
        parent.assertCurrent();
        let created = false;
        try {
            await fs.mkdir(dir, { mode: 0o700 });
            created = true;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
        const observed = snapshotMissingRootComponent(parentEntry, dir, ownerUid, index === missing.length - 1);
        if (created) {
            const modeInitialization = admitTempWorkspaceChild(dir, observed.stat, parent, 0o700);
            if (modeInitialization)
                await modeInitialization;
        }
        guardedChain.push(observed.entry);
    }
    return rootAdmission(guardedChain, ownerUid);
}
export function admitTempWorkspaceRootSync(rootDir) {
    const { admission, chain, missing, ownerUid } = rootPlan(rootDir);
    if (admission)
        return admission;
    const guardedChain = chain;
    for (const [index, segment] of missing.entries()) {
        const parentEntry = guardedChain[guardedChain.length - 1];
        const parent = rootAdmission(guardedChain, ownerUid);
        const dir = path.join(parent.dir, segment);
        assertNoWindowsPathAlias(dir, "filesystem");
        parent.assertCurrent();
        let created = false;
        try {
            fsSync.mkdirSync(dir, { mode: 0o700 });
            created = true;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
        const observed = snapshotMissingRootComponent(parentEntry, dir, ownerUid, index === missing.length - 1);
        if (created)
            admitTempWorkspaceChildSync(dir, observed.stat, parent, 0o700);
        guardedChain.push(observed.entry);
    }
    return rootAdmission(guardedChain, ownerUid);
}
