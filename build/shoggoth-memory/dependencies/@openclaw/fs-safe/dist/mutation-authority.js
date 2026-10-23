import { types } from "node:util";
import { FsSafeError } from "./errors.js";
export class MutationAuthorityError extends FsSafeError {
    rejection;
    constructor(rejection) {
        super("denied-path", "mutation authority rejected the operation", { cause: rejection });
        this.rejection = rejection;
    }
}
export function isMutationAuthorityError(error) {
    try {
        return error instanceof MutationAuthorityError;
    }
    catch {
        return false;
    }
}
export function assertSynchronousCallbackResult(returned, name) {
    if (returned !== null &&
        (typeof returned === "object" || typeof returned === "function") &&
        typeof returned.then === "function") {
        // TypeScript permits async functions for () => void. Do not admit their work.
        void Promise.resolve(returned).catch(() => undefined);
        throw new TypeError(`${name} must be synchronous`);
    }
    // A generator returns its iterator before running the callback body.
    if (types.isGeneratorObject(returned)) {
        throw new TypeError(`${name} must be synchronous`);
    }
}
export function composeMutationAssertions(defaultAssertion, callAssertion) {
    if (!defaultAssertion && !callAssertion)
        return undefined;
    return () => {
        try {
            assertSynchronousCallbackResult(defaultAssertion?.(), "assertBeforeMutation");
            assertSynchronousCallbackResult(callAssertion?.(), "assertBeforeMutation");
        }
        catch (error) {
            throw new MutationAuthorityError(error);
        }
    };
}
export function rethrowMutationAuthorityError(error) {
    if (isMutationAuthorityError(error))
        throw error.rejection;
    // Cleanup failures and indeterminate publication receipts must retain their context.
    throw error;
}
