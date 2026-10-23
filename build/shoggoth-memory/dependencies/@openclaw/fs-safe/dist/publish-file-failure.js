import { FsSafeError } from "./errors.js";
export function rememberCreatedTarget(state, identity, phase) {
    state.targetCreated = true;
    state.targetIdentity = { dev: Number(identity.dev), ino: Number(identity.ino) };
    state.targetCleanupIdentity = { dev: identity.dev, ino: identity.ino };
    state.phase = phase;
}
export function publicationFailure(error, state, cleanup) {
    const cause = error instanceof Error ? error : new Error(String(error));
    const details = {
        phase: state.phase,
        targetCreated: state.targetCreated,
        ...(state.targetIdentity ? { targetIdentity: state.targetIdentity } : {}),
        ...(state.directorySync ? { directorySync: state.directorySync } : {}),
        cleanup,
    };
    return new FsSafeError(error instanceof FsSafeError ? error.code : "helper-failed", `exclusive file publication failed during ${state.phase}: ${cause.message}`, { cause, details });
}
export function directorySyncFailure(error) {
    const code = error?.code;
    return typeof code === "string" ? { status: "failed", code } : { status: "failed" };
}
