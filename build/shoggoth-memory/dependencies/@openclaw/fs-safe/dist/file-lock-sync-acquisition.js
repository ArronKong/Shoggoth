import { getSyncLockAdmissions } from "./file-lock-sync-admission.js";
import { isTransientLockFileDenial, maxTransientLockDenials, sidecarLockRetryDelay, sidecarLockTimeout, } from "./sidecar-lock-policy.js";
import { sleepSync } from "./timing.js";
/** Owns local arbitration and retry state, independently of filesystem authority. */
export class SyncLockAcquisition {
    lockPath;
    normalizedTargetPath;
    retry;
    timeoutMs;
    #admissions = getSyncLockAdmissions();
    #token = {};
    #owns = false;
    #startedAt = performance.now();
    #attempt = 0;
    #transientDenials = 0;
    constructor(lockPath, normalizedTargetPath, retry, timeoutMs) {
        this.lockPath = lockPath;
        this.normalizedTargetPath = normalizedTargetPath;
        this.retry = retry;
        this.timeoutMs = timeoutMs;
    }
    get owns() { return this.#owns; }
    hasToken() { return this.#admissions.get(this.normalizedTargetPath) === this.#token; }
    assert() {
        if (!this.hasToken())
            throw sidecarLockTimeout(this.lockPath, this.normalizedTargetPath);
    }
    reserve() {
        if (this.#owns)
            return;
        // An existing synchronous owner can finish only after this stack unwinds.
        if (this.#admissions.has(this.normalizedTargetPath)) {
            throw sidecarLockTimeout(this.lockPath, this.normalizedTargetPath);
        }
        this.#admissions.set(this.normalizedTargetPath, this.#token);
        this.#owns = true;
    }
    release() {
        if (this.#owns && this.hasToken())
            this.#admissions.delete(this.normalizedTargetPath);
        this.#owns = false;
    }
    run(callback) {
        this.assert();
        try {
            return callback();
        }
        finally {
            this.assert();
        }
    }
    waitForRetry() {
        this.release();
        const delay = sidecarLockRetryDelay(this.retry, this.timeoutMs, performance.now() - this.#startedAt, this.#attempt);
        if (delay === undefined)
            throw sidecarLockTimeout(this.lockPath, this.normalizedTargetPath);
        sleepSync(delay);
        this.#attempt += 1;
    }
    retryDenial(error) {
        if (!isTransientLockFileDenial(error, this.lockPath) ||
            ++this.#transientDenials > maxTransientLockDenials)
            return false;
        try {
            this.waitForRetry();
        }
        catch (waitError) {
            // Exhausted backoff must preserve the filesystem denial diagnosis.
            if (waitError?.code === "file_lock_timeout")
                throw error;
            throw waitError;
        }
        return true;
    }
    monitor(held, handle, callback, interval, receiver, recordTimer) {
        if (!callback || (interval ?? 0) <= 0)
            return;
        const { lockPath, normalizedTargetPath } = this;
        const timer = setInterval(() => {
            let stillHeld;
            try {
                stillHeld = handle.verifyStillHeld();
            }
            catch {
                stillHeld = false;
            }
            if (!stillHeld && held.timer) {
                clearInterval(held.timer);
                held.timer = undefined;
                Reflect.apply(callback, receiver, [{ lockPath, normalizedTargetPath }]);
            }
        }, interval);
        // Root cleanup retains a separate provisional receipt before unref can fail.
        recordTimer?.(timer);
        held.timer = timer;
        timer.unref();
    }
}
