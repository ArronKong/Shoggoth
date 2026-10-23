import { FsSafeError } from "./errors.js";
import { noReplaceUnavailable } from "./native-noreplace.js";
export function createStagedFileReceipt(directory, temporaryBasename, stat) {
    return Object.freeze({
        directory,
        temporaryBasename,
        identity: Object.freeze({
            dev: stat.dev, ino: stat.ino, mode: Number(stat.mode & 4095n),
            nlink: stat.nlink, size: stat.size, uid: Number(stat.uid), gid: Number(stat.gid),
            mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
        }),
    });
}
export function stagedFailure(kind, error, details) {
    error = noReplaceUnavailable(error, `${kind} publication`) ?? error;
    let code = "helper-failed";
    try {
        code = error instanceof FsSafeError ? error.code
            : error?.code === "EEXIST" ? "already-exists" : "helper-failed";
    }
    catch {
        // Uninspectable error metadata must not interrupt terminal settlement.
    }
    return new FsSafeError(code, code === "helper-unavailable" && error instanceof FsSafeError
        ? error.message : `staged ${kind} ${details.phase} failed`, { cause: error, details });
}
/** Finish owned cleanup and every close before surfacing publication evidence. */
export async function settleStagedFile(params) {
    const errors = params.failure ? [params.failure.error] : [];
    let status;
    try {
        status = await params.cleanup();
    }
    catch (error) {
        status = "failed";
        errors.push(error);
    }
    let resources = "closed";
    for (const close of params.close) {
        try {
            await close();
        }
        catch (error) {
            resources = "close-failed";
            errors.push(error);
        }
    }
    const incomplete = status === "failed" || status === "preserved" || resources === "close-failed";
    // A settled pre-publication failure retains the producer/authority rejection exactly.
    if (!incomplete && (!params.failure || params.publication.status === "not-published"))
        return;
    const error = errors.length > 1 ? new AggregateError(errors, "staged operation and settlement failed")
        : errors.length === 1 ? errors[0] : new FsSafeError("not-removable", "staged cleanup preserved an unverified entry");
    const cleanup = Object.freeze({
        temporaryBasename: params.temporaryBasename,
        publication: params.publication,
        status,
        resources,
    });
    throw stagedFailure("file", error, {
        phase: params.failure ? params.phase : "cleanup",
        publication: params.publication,
        cleanup,
    });
}
