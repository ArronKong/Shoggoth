import { Transform } from "node:stream";
export const DEFAULT_MAX_ARCHIVE_BYTES_ZIP = 256 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 50_000;
export const DEFAULT_MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_META_ENTRY_BYTES = 1024 * 1024;
export const DEFAULT_MAX_ENTRY_PATH_COMPONENTS = 256;
export const ARCHIVE_LIMIT_ERROR_CODE = {
    ARCHIVE_SIZE_EXCEEDS_LIMIT: "archive-size-exceeds-limit",
    ENTRY_COUNT_EXCEEDS_LIMIT: "archive-entry-count-exceeds-limit",
    ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT: "archive-entry-extracted-size-exceeds-limit",
    EXTRACTED_SIZE_EXCEEDS_LIMIT: "archive-extracted-size-exceeds-limit",
    DECODED_SIZE_EXCEEDS_LIMIT: "archive-decoded-size-exceeds-limit",
    META_ENTRY_SIZE_EXCEEDS_LIMIT: "archive-meta-entry-size-exceeds-limit",
    MANIFEST_SIZE_EXCEEDS_LIMIT: "archive-manifest-size-exceeds-limit",
    ENTRY_PATH_COMPONENTS_EXCEEDS_LIMIT: "archive-entry-path-components-exceeds-limit",
};
const ARCHIVE_LIMIT_ERROR_MESSAGE = {
    [ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT]: "archive size exceeds limit",
    [ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT]: "archive entry count exceeds limit",
    [ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT]: "archive entry extracted size exceeds limit",
    [ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT]: "archive extracted size exceeds limit",
    [ARCHIVE_LIMIT_ERROR_CODE.DECODED_SIZE_EXCEEDS_LIMIT]: "archive decoded size exceeds limit",
    [ARCHIVE_LIMIT_ERROR_CODE.META_ENTRY_SIZE_EXCEEDS_LIMIT]: "archive metadata entry size exceeds limit",
    [ARCHIVE_LIMIT_ERROR_CODE.MANIFEST_SIZE_EXCEEDS_LIMIT]: "archive manifest size exceeds limit",
    [ARCHIVE_LIMIT_ERROR_CODE.ENTRY_PATH_COMPONENTS_EXCEEDS_LIMIT]: "archive entry path components exceed limit",
};
export class ArchiveLimitError extends Error {
    code;
    constructor(code) {
        super(ARCHIVE_LIMIT_ERROR_MESSAGE[code]);
        this.name = "ArchiveLimitError";
        this.code = code;
    }
}
export const MAX_TAR_MANIFEST_BYTES = 64 * 1024 * 1024;
export function resolveTarMeterLimits(options) {
    const limits = resolveExtractLimits(options);
    const payload = Math.min(limits.maxExtractedBytes, Number.MAX_SAFE_INTEGER);
    const overhead = Math.min(limits.maxArchiveBytes, Number.MAX_SAFE_INTEGER);
    // Saturate before multiplying, including when public limits approach MAX_VALUE.
    const pathBytes = Math.max(256, Math.min(limits.maxMetaEntryBytes, Math.min(Math.max(1, limits.maxEntryPathComponents), MAX_TAR_MANIFEST_BYTES / 256) * 256));
    const perEntry = 64 + 2 * pathBytes;
    const maxManifestBytes = limits.maxEntries > Math.floor(MAX_TAR_MANIFEST_BYTES / perEntry)
        ? MAX_TAR_MANIFEST_BYTES : limits.maxEntries * perEntry;
    // TAR sizes are safe integers; native logical entry counts use u32.
    return {
        maxEntries: Math.min(limits.maxEntries, 0xffff_ffff),
        maxMetaEntryBytes: Math.min(limits.maxMetaEntryBytes, Number.MAX_SAFE_INTEGER),
        maxManifestBytes,
        maxDecodedBytes: payload > Number.MAX_SAFE_INTEGER - overhead
            ? Number.MAX_SAFE_INTEGER : payload + overhead,
    };
}
function clampLimit(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return undefined;
    }
    const v = Math.floor(value);
    return v >= 0 ? v : undefined;
}
export function resolveExtractLimits(limits) {
    // Defaults: defensive, but should not break normal installs.
    return {
        maxArchiveBytes: clampLimit(limits?.maxArchiveBytes) ?? DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
        maxEntries: clampLimit(limits?.maxEntries) ?? DEFAULT_MAX_ENTRIES,
        maxExtractedBytes: clampLimit(limits?.maxExtractedBytes) ?? DEFAULT_MAX_EXTRACTED_BYTES,
        maxEntryBytes: clampLimit(limits?.maxEntryBytes) ?? DEFAULT_MAX_ENTRY_BYTES,
        maxMetaEntryBytes: clampLimit(limits?.maxMetaEntryBytes) ?? DEFAULT_MAX_META_ENTRY_BYTES,
        maxEntryPathComponents: clampLimit(limits?.maxEntryPathComponents) ?? DEFAULT_MAX_ENTRY_PATH_COMPONENTS,
    };
}
export function assertArchiveEntryPathComponentsWithinLimit(entryPath, limits) {
    const components = entryPath
        .split(/[\\/]+/u)
        .filter((component) => component.length > 0 && component !== ".").length;
    if (components > limits.maxEntryPathComponents) {
        throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_PATH_COMPONENTS_EXCEEDS_LIMIT);
    }
}
export function assertArchiveEntryCountWithinLimit(entryCount, limits) {
    if (entryCount > limits.maxEntries) {
        throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT);
    }
}
export function createByteBudgetTracker(limits) {
    let entryBytes = 0;
    let extractedBytes = 0;
    const addBytes = (bytes) => {
        const b = Math.max(0, Math.floor(bytes));
        if (b === 0) {
            return;
        }
        entryBytes += b;
        if (entryBytes > limits.maxEntryBytes) {
            throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
        }
        extractedBytes += b;
        if (extractedBytes > limits.maxExtractedBytes) {
            throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT);
        }
    };
    return {
        startEntry() {
            entryBytes = 0;
        },
        addBytes,
        addEntrySize(size) {
            const s = Math.max(0, Math.floor(size));
            if (s > limits.maxEntryBytes) {
                throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
            }
            // Tar budgets are based on the header-declared size.
            addBytes(s);
        },
    };
}
export function createExtractBudgetTransform(params) {
    return new Transform({
        transform(chunk, _encoding, callback) {
            try {
                const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
                params.onChunkBytes(buf.byteLength);
                callback(null, buf);
            }
            catch (err) {
                callback(err instanceof Error ? err : new Error(String(err)));
            }
        },
    });
}
