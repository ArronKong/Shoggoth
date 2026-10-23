import { FsSafeError } from "./errors.js";
export function captureNativeFdClose(binding) {
    if (typeof binding.closeOwnedFd !== "function") {
        throw new FsSafeError("helper-unavailable", "native descriptor ownership is unavailable");
    }
    // Retained descriptors must remain disposable after native configuration changes.
    return binding.closeOwnedFd.bind(binding);
}
