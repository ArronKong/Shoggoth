import { sidecarLockSnapshotStillPresent, } from "./sidecar-lock-reclaim.js";
export function stopSidecarLockMonitoring(held) {
    const timer = held.compromiseTimer;
    held.compromiseTimer = undefined;
    if (timer)
        clearInterval(timer);
}
export function createSidecarLockHandle(params) {
    let released = false;
    let releasePromise;
    let releaseStarted = false;
    const release = async () => {
        if (released)
            return;
        if (!releasePromise) {
            const retry = releaseStarted;
            releaseStarted = true;
            releasePromise = (async () => {
                await params.release({ retry });
                released = true;
            })();
        }
        try {
            await releasePromise;
        }
        finally {
            releasePromise = undefined;
        }
    };
    return {
        lockPath: params.lockPath,
        normalizedTargetPath: params.normalizedTargetPath,
        verifyStillHeld: params.verifyStillHeld,
        release,
        [Symbol.asyncDispose]: release,
    };
}
export function createHeldSidecarLockHandle(params) {
    return createSidecarLockHandle({
        lockPath: params.held.lockPath,
        normalizedTargetPath: params.normalizedTargetPath,
        verifyStillHeld: async () => await sidecarLockSnapshotStillPresent(params.held.lockPath, params.held.snapshot, {
            lockRoot: params.held.lockRoot,
            parsePayload: params.held.parsePayload,
        }),
        release: (options) => params.release(options),
    });
}
