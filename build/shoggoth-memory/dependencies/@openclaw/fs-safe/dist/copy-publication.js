import { FsSafeError } from "./errors.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
export function createCopyPublicationObserver(path, notify) {
    let rejected;
    return {
        onPublished(identity) {
            const receipt = Object.freeze({ path, dev: identity.dev, ino: identity.ino });
            try {
                assertSynchronousCallbackResult(notify?.(receipt), "onDestinationPublished");
            }
            catch (error) {
                rejected = { error };
                throw error;
            }
        },
        rethrowObserverFailure(error) {
            if (rejected && (error === rejected.error ||
                (error instanceof FsSafeError && error.cause === rejected.error && error.details?.phase === "publish"))) {
                throw rejected.error;
            }
        },
    };
}
// Internal composition hook; the descriptor is borrowed until the callback returns.
// Kept off RootCopyOptions and all public package exports.
export const onCopyPublication = Symbol("onCopyPublication");
// Reuse the copy's admitted descriptor identity before any bytes are staged.
// Internal callers can bind prior observations and select its publication mode.
export const onCopySourceAdmission = Symbol("onCopySourceAdmission");
