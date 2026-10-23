const OPERATIONAL_CODE_VALUES = [
    "helper-failed",
    "helper-unavailable",
    "not-empty",
    "not-found",
    "not-removable",
    "permission-unverified",
    "read-failed",
    "timeout",
    "unsupported-platform",
];
const OPERATIONAL_CODES = new Set(OPERATIONAL_CODE_VALUES);
export function categorizeFsSafeError(code) {
    return OPERATIONAL_CODES.has(code) ? "operational" : "policy";
}
export class FsSafeError extends Error {
    code;
    category;
    details;
    constructor(code, message, options = {}) {
        super(message, options);
        this.name = "FsSafeError";
        this.code = code;
        this.category = categorizeFsSafeError(code);
        this.details = options.details;
    }
}
/** A rejected no-replace rename capability, not a generic missing native helper. */
export function isNoReplaceUnsupported(error) {
    return error instanceof FsSafeError && error.code === "helper-unavailable" &&
        error.details?.capability === "rename-noreplace";
}
