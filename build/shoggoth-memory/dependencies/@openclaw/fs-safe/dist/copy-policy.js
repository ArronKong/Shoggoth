import { FsSafeError } from "./errors.js";
export function resolveCopyCloneMode(mode, defaultMode) {
    const policy = mode === undefined ? defaultMode : mode;
    if (policy !== "auto" && policy !== "always" && policy !== "never") {
        throw new FsSafeError("invalid-path", "copy clone policy must be auto, always, or never");
    }
    return policy;
}
