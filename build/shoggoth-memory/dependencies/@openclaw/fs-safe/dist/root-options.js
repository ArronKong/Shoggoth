import { normalizeMaxBytes } from "./byte-budget.js";
export const DEFAULT_ROOT_MAX_BYTES = 16 * 1024 * 1024;
export function readDefaults(defaults) {
    return {
        hardlinks: defaults.hardlinks,
        maxBytes: normalizeMaxBytes(defaults.maxBytes, { defaultValue: DEFAULT_ROOT_MAX_BYTES }),
        symlinks: defaults.symlinks,
    };
}
export function mergeReadOptions(defaults, options) {
    const merged = readDefaults(defaults);
    if (options.hardlinks !== undefined)
        merged.hardlinks = options.hardlinks;
    merged.maxBytes = normalizeMaxBytes(options.maxBytes, { defaultValue: merged.maxBytes });
    if (options.symlinks !== undefined)
        merged.symlinks = options.symlinks;
    return merged;
}
