const warnedFeatures = new Set();
/** Warn once per capability, without including caller paths or native error text. */
export function warnNativeFallback(feature, limitation) {
    if (warnedFeatures.has(feature))
        return;
    warnedFeatures.add(feature);
    process.emitWarning(`${feature} is using its portable fallback because native support is unavailable or disabled. ${limitation}`, { code: "FS_SAFE_NATIVE_FALLBACK", type: "FsSafeWarning" });
}
export function __resetNativeFallbackWarningsForTest() {
    warnedFeatures.clear();
}
