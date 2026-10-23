const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
export function scheduleTimeout(callback, ms) {
    let timer;
    if (Number.isFinite(ms) && ms > MAX_TIMER_DELAY_MS) {
        const startedAt = performance.now();
        const tick = () => {
            const remaining = ms - (performance.now() - startedAt);
            if (remaining <= 0)
                callback();
            else
                timer = setTimeout(tick, Math.min(remaining, MAX_TIMER_DELAY_MS));
        };
        // Node clamps overflowing delays to 1 ms. Rearm bounded timers against a
        // monotonic clock so clock changes and event-loop stalls cannot shorten them.
        timer = setTimeout(tick, MAX_TIMER_DELAY_MS);
    }
    else {
        timer = setTimeout(callback, ms);
    }
    return () => clearTimeout(timer);
}
export function sleep(ms) {
    return new Promise((resolve) => { scheduleTimeout(resolve, ms); });
}
export function sleepSync(ms) {
    if (ms <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
export async function withTimeout(promise, timeoutMs, labelOrOptions = {
    message: "timeout",
}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return await promise;
    }
    const options = typeof labelOrOptions === "string" ? { label: labelOrOptions } : labelOrOptions;
    const createError = options.createError ??
        (() => new Error(options.message ?? `${options.label ?? "operation"} timed out after ${timeoutMs}ms`));
    let cancelTimeout;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                cancelTimeout = scheduleTimeout(() => {
                    try {
                        reject(createError());
                    }
                    catch (error) {
                        reject(error);
                    }
                }, timeoutMs);
            }),
        ]);
    }
    finally {
        cancelTimeout?.();
    }
}
