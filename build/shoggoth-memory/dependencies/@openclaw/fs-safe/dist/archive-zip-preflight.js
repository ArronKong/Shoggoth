import { ARCHIVE_LIMIT_ERROR_CODE, ArchiveLimitError, resolveExtractLimits, } from "./archive-limits.js";
import { admitZipBuffer } from "./archive-zip-admission.js";
import { loadAdmittedZipArchive } from "./archive-zip-loader.js";
export function loadZipArchiveWithAdmission(buffer, limits) {
    try {
        const resolvedLimits = resolveExtractLimits(limits);
        if (buffer.byteLength > resolvedLimits.maxArchiveBytes) {
            throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
        }
        const entries = [];
        admitZipBuffer(buffer, resolvedLimits, entry => { entries.push(entry); });
        return loadAdmittedZipArchive(buffer, entries);
    }
    catch (error) {
        // Keep validation failures in the promise handed to the extraction deadline.
        return Promise.reject(error);
    }
}
export async function loadZipArchiveWithPreflight(buffer, limits) {
    return (await loadZipArchiveWithAdmission(buffer, limits)).archive;
}
