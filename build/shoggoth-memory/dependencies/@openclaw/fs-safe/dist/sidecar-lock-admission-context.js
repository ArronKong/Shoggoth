import { AsyncLocalStorage } from "node:async_hooks";
const EMPTY_ANCESTRY = Object.freeze([]);
const GLOBAL_CONTEXT_KEY = Symbol.for("fsSafe.sidecarLockAdmissionAsyncContext");
function admissionContext() {
    const shared = globalThis;
    return shared[GLOBAL_CONTEXT_KEY] ??=
        new AsyncLocalStorage();
}
/** Capture active ancestry now; later lifecycle changes cannot reclassify this call. */
export function captureSidecarAdmissionAncestry() {
    const current = admissionContext().getStore();
    if (!current)
        return EMPTY_ANCESTRY;
    const active = current.ancestry.filter((entry) => entry.active);
    if (current.active)
        active.push(current);
    return active.length === 0 ? EMPTY_ANCESTRY : active;
}
export function ancestryHasSidecarAdmission(ancestry, admissions, normalizedTargetPath) {
    return ancestry.some((entry) => entry.admissions === admissions && entry.normalizedTargetPath === normalizedTargetPath);
}
function createSidecarAdmissionScope(ancestry, admissions, normalizedTargetPath, token) {
    return { active: false, admissions, ancestry, normalizedTargetPath, started: false, token };
}
function activateSidecarAdmissionScope(scope) {
    if (scope.started)
        throw new Error("sidecar admission scope cannot be reactivated");
    scope.started = true;
    scope.active = true;
}
function deactivateSidecarAdmissionScope(scope) {
    if (scope)
        scope.active = false;
}
function runInSidecarAdmissionScope(scope, callback) {
    return scope?.active ? admissionContext().run(scope, callback) : callback();
}
export function createSidecarAdmissionController(ancestry, admissions, normalizedTargetPath) {
    let scope;
    const hasToken = () => scope !== undefined && admissions.get(normalizedTargetPath) === scope.token;
    return {
        get owns() { return scope !== undefined; },
        hasToken,
        release() {
            deactivateSidecarAdmissionScope(scope);
            if (hasToken())
                admissions.delete(normalizedTargetPath);
            scope = undefined;
        },
        reserve() {
            const token = {};
            scope = createSidecarAdmissionScope(ancestry, admissions, normalizedTargetPath, token);
            admissions.set(normalizedTargetPath, token);
            activateSidecarAdmissionScope(scope);
        },
        run(callback) {
            return runInSidecarAdmissionScope(scope, callback);
        },
    };
}
