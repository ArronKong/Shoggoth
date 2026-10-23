import { AsyncLocalStorage } from "node:async_hooks";
const active = new AsyncLocalStorage();
export function recordFileObservationFailure(error, kind) {
    const failures = active.getStore();
    if (!failures)
        return;
    let kinds = failures.get(error);
    if (!kinds)
        failures.set(error, kinds = new Set());
    kinds.add(kind);
}
export function isFileObservationFailure(error, kind) {
    return active.getStore()?.get(error)?.has(kind) === true;
}
// Each Root observation owns its receipts, including nested and concurrent reads.
export function fileObservation() {
    const failures = new Map();
    return {
        run(operation) { return active.run(failures, operation); },
        has(error, kind) { return failures.get(error)?.has(kind) === true; },
    };
}
