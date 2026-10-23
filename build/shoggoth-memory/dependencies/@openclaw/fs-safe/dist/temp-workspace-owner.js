import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { assertNoWindowsPathAlias, resolvePathPreservingWindowsRoot } from "./windows-path-alias.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { getNativeBinding } from "./native.js";
import { openTempWorkspaceCleanupParent, TempWorkspaceRetainedChild, } from "./temp-workspace-descriptor.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { isFsSafeNativeRequired } from "./native-config.js";
import { cachedNoReplaceUnavailable, noReplaceUnavailable, rememberNoReplaceUnavailable } from "./native-noreplace.js";
function isNativeCleanupBinding(binding) {
    return typeof binding?.renameNoReplace === "function" &&
        typeof binding.removeOwnedTree === "function" &&
        typeof binding.removeOwnedTreeSync === "function" &&
        typeof binding.ownedTreeRemovalAvailable === "function";
}
export class TempWorkspaceCleanupCapability {
    binding;
    parent;
    #admission;
    #safety;
    #ownedTreeRemovalAvailable;
    #phase = "new";
    constructor(root, safety, admission, dirMode) {
        assertNoWindowsPathAlias(root, "filesystem");
        const admittedRoot = admission.dir;
        assertNoWindowsPathAlias(admittedRoot, "filesystem");
        const resolvedRoot = resolvePathPreservingWindowsRoot(root);
        assertNoWindowsPathAlias(resolvedRoot, "filesystem");
        if (resolvedRoot !== resolvePathPreservingWindowsRoot(admittedRoot)) {
            throw new FsSafeError("path-mismatch", "temp workspace cleanup parent differs from admitted root");
        }
        this.#admission = admission;
        this.#safety = safety;
        // POSIX enumeration reopens fd-relative ".", so retaining O_RDONLY before
        // chmod cannot supply read/search authority that the final mode removes.
        const childModeAllowsRemoval = process.platform === "win32" || (dirMode & 0o500) === 0o500;
        if (safety === "require-bounded" && !childModeAllowsRemoval) {
            throw new FsSafeError("helper-unavailable", "temp workspace owned-tree cleanup requires owner read and search in dirMode");
        }
        let binding;
        try {
            binding = getNativeBinding();
        }
        catch (error) {
            if (safety === "require-bounded")
                throw error;
        }
        this.binding = binding;
        let parent;
        try {
            parent = openTempWorkspaceCleanupParent(root, admission);
        }
        catch (error) {
            // Failed descriptor closure must retain the original admission failure too.
            if (error instanceof AggregateError)
                throw error;
        }
        let available = false;
        if (childModeAllowsRemoval && parent?.access === "read" && isNativeCleanupBinding(binding)) {
            let probeReady = false;
            try {
                admission.prepareCleanupProbe(parent.fd);
                probeReady = true;
            }
            catch (error) {
                // A descriptor that cannot be associated even provisionally must not
                // reach native code or remain available to compatible cleanup.
                try {
                    fsSync.closeSync(parent.fd);
                }
                catch (closeError) {
                    throw new AggregateError([error, closeError], "temp workspace cleanup parent probe admission and close failed");
                }
                parent = undefined;
            }
            try {
                if (probeReady && parent) {
                    available = binding.ownedTreeRemovalAvailable(parent.fd) === true;
                }
            }
            catch {
                // Runtime denial must select fallback or reject before child creation.
            }
        }
        this.parent = parent;
        this.#ownedTreeRemovalAvailable = available;
        if (safety === "require-bounded" && !this.#ownedTreeRemovalAvailable) {
            this.close();
            throw new FsSafeError("helper-unavailable", "temp workspace owned-tree cleanup is unavailable");
        }
    }
    get canRemoveOwnedTree() {
        return (this.#phase === "ready" || this.#phase === "sealed") &&
            this.#ownedTreeRemovalAvailable;
    }
    get canUseCompatibleCleanup() {
        return this.#safety === "compatible" && !isFsSafeNativeRequired();
    }
    prepareChildCreation() {
        const replay = this.#phase === "ready";
        if (this.#phase !== "new" && !replay) {
            throw new FsSafeError("path-mismatch", "temp workspace cleanup parent is unavailable");
        }
        // A failed initial admission or receipt replay is terminal: no earlier
        // authority may survive a partial revalidation.
        this.#phase = "failed";
        if (replay) {
            if (this.parent)
                this.#admission.associateAncestry(this.parent.fd);
            else
                this.#admission.assertAncestry();
        }
        else {
            this.#admission.prepareChildCreation(this.parent?.fd);
        }
        // The retained descriptor cannot authorize cleanup until the complete
        // ancestry and its exact descriptor association succeeded together.
        this.#phase = "ready";
    }
    #assertCurrent(ancestry) {
        if ((this.#phase !== "ready" && this.#phase !== "sealed") || !this.parent) {
            throw new FsSafeError("path-mismatch", "temp workspace cleanup parent is unavailable");
        }
        if (ancestry)
            this.#admission.associateAncestry(this.parent.fd);
        else
            this.#admission.associateCurrent(this.parent.fd);
    }
    admitChildDescriptor(canEnumerate) {
        if (this.#phase !== "ready") {
            throw new FsSafeError("path-mismatch", "temp workspace cleanup parent is unavailable");
        }
        // From this point the capability belongs to this successfully created
        // child. Collision retries and further preparation must remain impossible.
        this.#phase = "sealed";
        const bounded = this.canRemoveOwnedTree && canEnumerate;
        if (this.#safety === "require-bounded" && !bounded) {
            throw new FsSafeError("helper-unavailable", "temp workspace owned-tree cleanup requires a readable child descriptor");
        }
        return bounded;
    }
    assertCurrent() {
        this.#assertCurrent(false);
    }
    assertAncestryCurrent() {
        this.#assertCurrent(true);
    }
    close() {
        if (this.#phase === "closed")
            return;
        this.#phase = "closed";
        if (this.parent)
            fsSync.closeSync(this.parent.fd);
    }
}
export function throwTempWorkspaceCreationFailure(error, retainedChild, capability, owner, label = "temp workspace") {
    try {
        if (owner)
            owner.cleanupSync();
        else {
            const closeErrors = [];
            try {
                retainedChild?.close();
            }
            catch (closeError) {
                closeErrors.push(closeError);
            }
            try {
                capability.close();
            }
            catch (closeError) {
                closeErrors.push(closeError);
            }
            if (closeErrors.length === 1)
                throw closeErrors[0];
            if (closeErrors.length > 1) {
                throw new AggregateError(closeErrors, `${label} admission descriptor close failed`);
            }
        }
    }
    catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `${label} creation and cleanup both failed`);
    }
    throw error;
}
export class TempWorkspaceCleanupOwner {
    #dir;
    #identity;
    #capability;
    #directory;
    #closed = false;
    #running = false;
    #exitInterrupted = false;
    #result;
    #pending;
    constructor(retained, capability, retainDescriptor) {
        const child = retained.transfer(retainDescriptor);
        this.#dir = child.dir;
        this.#identity = child.identity;
        this.#capability = capability;
        this.#directory = child.directory;
    }
    #repeat() {
        return this.#result === "removed" ? "missing" : this.#result;
    }
    #close() {
        if (this.#closed)
            return;
        this.#closed = true;
        const errors = [];
        if (this.#directory) {
            try {
                fsSync.closeSync(this.#directory.fd);
            }
            catch (error) {
                errors.push(error);
            }
        }
        try {
            this.#capability.close();
        }
        catch (error) {
            errors.push(error);
        }
        if (errors.length === 1)
            throw errors[0];
        if (errors.length > 1)
            throw new AggregateError(errors, "temp workspace cleanup descriptor close failed");
    }
    #finish(result) {
        this.#result ??= this.#exitInterrupted ? "indeterminate" : result;
        try {
            this.#close();
        }
        catch (error) {
            this.#result = "indeterminate";
            throw error;
        }
        return this.#result;
    }
    #fallbackResult() {
        try {
            const current = fsSync.lstatSync(this.#dir, { bigint: true });
            return current.isDirectory() && !current.isSymbolicLink() &&
                sameFileIdentityForCleanup(current, this.#identity)
                ? "indeterminate"
                : "identity-mismatch";
        }
        catch (error) {
            return error.code === "ENOENT" ? "missing" : "indeterminate";
        }
    }
    #prepare() {
        const parent = this.#capability.parent;
        if (!parent)
            return this.#fallbackResult();
        try {
            this.#capability.assertCurrent();
            let current;
            try {
                current = fsSync.lstatSync(this.#dir, { bigint: true });
            }
            catch (error) {
                this.#capability.assertCurrent();
                return error.code === "ENOENT" ? "missing" : "indeterminate";
            }
            this.#capability.assertCurrent();
            if (!current.isDirectory() || current.isSymbolicLink() ||
                !sameFileIdentityForCleanup(current, this.#identity)) {
                return "identity-mismatch";
            }
            const name = `.fs-safe-workspace-cleanup-${randomUUID()}`;
            const quarantinePath = path.join(parent.receipt.path, name);
            let nativeRemoval = this.#capability.canRemoveOwnedTree && this.#directory !== undefined;
            if (nativeRemoval) {
                const binding = this.#capability.binding;
                try {
                    const cached = cachedNoReplaceUnavailable(binding, parent.fd, "workspace quarantine");
                    if (cached)
                        throw cached;
                    binding.renameNoReplace(parent.fd, path.basename(this.#dir), parent.fd, name);
                }
                catch (error) {
                    const unavailable = error instanceof FsSafeError && error.code === "helper-unavailable"
                        ? error : noReplaceUnavailable(error, "workspace quarantine", true);
                    if (!unavailable)
                        throw error;
                    rememberNoReplaceUnavailable(binding, parent.fd, unavailable);
                    if (!this.#capability.canUseCompatibleCleanup)
                        throw unavailable;
                    nativeRemoval = false;
                }
            }
            if (!nativeRemoval) {
                // The admitted receipt is exact and descriptor-associated. Reuse it as
                // the pre/post parent fence instead of layering a numeric guard over it.
                this.#capability.assertCurrent();
                fsSync.renameSync(this.#dir, quarantinePath);
            }
            this.#capability.assertCurrent();
            const quarantined = fsSync.lstatSync(quarantinePath, { bigint: true });
            this.#capability.assertCurrent();
            if (!quarantined.isDirectory() || quarantined.isSymbolicLink() ||
                !sameFileIdentityForCleanup(quarantined, this.#identity)) {
                return "indeterminate";
            }
            return { name, path: quarantinePath, nativeRemoval };
        }
        catch (error) {
            if (error instanceof FsSafeError && error.code === "helper-unavailable")
                throw error;
            // A failed rename can still have committed on a remote filesystem.
            return "indeterminate";
        }
    }
    #assertQuarantine(quarantine) {
        const current = fsSync.lstatSync(quarantine.path, { bigint: true });
        if (!current.isDirectory() || current.isSymbolicLink() ||
            !sameFileIdentityForCleanup(current, this.#identity)) {
            throw new FsSafeError("path-mismatch", "temp workspace quarantine changed");
        }
        this.#capability.assertCurrent();
    }
    #mapRemoval(result) {
        if (result.errorCode) {
            const error = Object.assign(new Error(result.errorMessage ?? "native owned-tree cleanup failed"), {
                code: result.errorCode,
            });
            if (error.code === "path-mismatch")
                return "indeterminate";
            throw error;
        }
        return result.outcome === "removed" ? "removed" : "indeterminate";
    }
    async #remove(quarantine) {
        if (quarantine.nativeRemoval) {
            const beforeNativeRemoval = getFsSafeTestHooks()?.beforeTempWorkspaceNativeRemoval;
            if (beforeNativeRemoval)
                await beforeNativeRemoval(quarantine.path);
            return this.#mapRemoval(await this.#capability.binding.removeOwnedTree(this.#capability.parent.fd, quarantine.name, this.#directory.fd));
        }
        try {
            this.#assertQuarantine(quarantine);
        }
        catch {
            return "indeterminate";
        }
        // Removal failures propagate unchanged; only authority uncertainty becomes a receipt.
        await fs.rm(quarantine.path, { recursive: true, force: true });
        try {
            this.#capability.assertCurrent();
            return "removed";
        }
        catch {
            return "indeterminate";
        }
    }
    #removeSync(quarantine) {
        if (quarantine.nativeRemoval) {
            getFsSafeTestHooks()?.beforeTempWorkspaceNativeRemovalSync?.(quarantine.path);
            return this.#mapRemoval(this.#capability.binding.removeOwnedTreeSync(this.#capability.parent.fd, quarantine.name, this.#directory.fd));
        }
        try {
            this.#assertQuarantine(quarantine);
        }
        catch {
            return "indeterminate";
        }
        fsSync.rmSync(quarantine.path, { recursive: true, force: true });
        try {
            this.#capability.assertCurrent();
            return "removed";
        }
        catch {
            return "indeterminate";
        }
    }
    async #run() {
        let result = "indeterminate";
        try {
            const prepared = this.#prepare();
            result = typeof prepared === "string" ? prepared : await this.#remove(prepared);
            return this.#finish(result);
        }
        finally {
            if (!this.#closed)
                this.#finish(result);
        }
    }
    cleanup() {
        if (this.#result)
            return Promise.resolve(this.#repeat());
        if (this.#pending)
            return this.#pending.then(() => this.#repeat());
        this.#running = true;
        this.#pending = this.#run();
        return this.#pending;
    }
    cleanupSync() {
        if (this.#result)
            return this.#repeat();
        if (this.#running) {
            this.#exitInterrupted = true;
            return "indeterminate";
        }
        this.#running = true;
        let result = "indeterminate";
        try {
            const prepared = this.#prepare();
            result = typeof prepared === "string" ? prepared : this.#removeSync(prepared);
            return this.#finish(result);
        }
        finally {
            if (!this.#closed)
                this.#finish(result);
        }
    }
}
