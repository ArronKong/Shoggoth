import { inspectAtomicIdentity } from "./atomic-io.js";
import { hasErrorCode } from "./file-cleanup.js";
import { FsSafeError } from "./errors.js";
function regular(stat, pathname, rejectHardlinks) {
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new FsSafeError("path-mismatch", `Atomic replace destination changed: ${pathname}`);
    }
    if (rejectHardlinks && stat.nlink !== 1n) {
        throw new FsSafeError("hardlink", `Hardlinked atomic replace destination not allowed: ${pathname}`);
    }
    return stat;
}
/** Borrows the writer's descriptor; no later pathname open can replace it. */
export class AtomicDestination {
    io;
    file;
    pathname;
    mutation;
    rejectHardlinks;
    identity;
    #writing = false;
    #restoreDescriptorOnly = false;
    constructor(io, file, pathname, mutation, rejectHardlinks, identity) {
        this.io = io;
        this.file = file;
        this.pathname = pathname;
        this.mutation = mutation;
        this.rejectHardlinks = rejectHardlinks;
        this.identity = identity;
    }
    *verify(restore = false) {
        let metadataFailure = false;
        const descriptorOnly = restore && this.#restoreDescriptorOnly;
        const owner = this;
        function readFailure(error) {
            metadataFailure = hasErrorCode(error, "EIO");
            throw error;
        }
        function read(pathname) {
            try {
                const stat = pathname
                    ? owner.io.lstatExact(owner.pathname, false) : owner.file.statExact();
                return owner.io.asynchronous ? Promise.resolve(stat).catch(readFailure) : stat;
            }
            catch (error) {
                return readFailure(error);
            }
        }
        const admit = (stat) => regular(stat, owner.pathname, owner.rejectHardlinks);
        try {
            const descriptorInspection = inspectAtomicIdentity(this.io, () => read(false), this.identity, false, admit);
            if (this.io.asynchronous)
                yield descriptorInspection;
            if (!descriptorOnly) {
                const pathnameInspection = inspectAtomicIdentity(this.io, () => read(true), this.identity, false, admit);
                if (this.io.asynchronous)
                    yield pathnameInspection;
            }
        }
        catch (error) {
            if (!descriptorOnly && this.#writing && metadataFailure) {
                // Restore through the retained descriptor after a fresh exact check.
                this.#restoreDescriptorOnly = true;
                throw error;
            }
            this.mutation.refuse(error);
        }
    }
    *beforeWrite(restore) {
        this.mutation.assert();
        yield* this.verify(restore);
        // Async identity observations may revoke authority before dispatch resumes.
        if (this.io.asynchronous)
            this.mutation.assert();
    }
    writing() {
        this.#writing = true;
        this.mutation.destination("writing", this.pathname, this.identity);
    }
    published() {
        this.mutation.destination("published", this.pathname, this.identity);
    }
}
export function* captureAtomicDestination(io, file, pathname, mutation, rejectHardlinks) {
    const inspection = inspectAtomicIdentity(io, () => file.statExact());
    const identity = (io.asynchronous ? (yield inspection) : inspection);
    regular(identity, pathname, rejectHardlinks);
    return new AtomicDestination(io, file, pathname, mutation, rejectHardlinks, identity);
}
