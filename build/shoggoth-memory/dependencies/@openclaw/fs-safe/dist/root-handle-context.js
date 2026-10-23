import { FsSafeError } from "./errors.js";
const contexts = new WeakMap();
/** Internal registration; never reconstruct authority from public pathname fields. */
export function registerRootHandleContext(handle, context) {
    contexts.set(handle, context);
}
export function rootHandleContext(handle) {
    const context = contexts.get(handle);
    if (!context)
        throw new FsSafeError("invalid-path", "watch requires a genuine fs-safe Root");
    return context;
}
