export function createSuppressedError(error, suppressed, message) {
    const constructor = globalThis.SuppressedError;
    if (constructor) {
        return new constructor(error, suppressed, message);
    }
    const combined = new Error(message, {
        cause: error instanceof Error ? error : undefined,
    });
    combined.name = "SuppressedError";
    Object.defineProperties(combined, {
        error: { configurable: true, value: error },
        suppressed: { configurable: true, value: suppressed },
    });
    return combined;
}
