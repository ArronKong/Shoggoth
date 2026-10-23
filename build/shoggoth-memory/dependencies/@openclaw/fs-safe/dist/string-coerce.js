export function normalizeNullableString(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
export function normalizeOptionalString(value) {
    return normalizeNullableString(value) ?? undefined;
}
export function normalizeOptionalLowercaseString(value) {
    return normalizeOptionalString(value)?.toLowerCase();
}
export function normalizeLowercaseStringOrEmpty(value) {
    return normalizeOptionalLowercaseString(value) ?? "";
}
