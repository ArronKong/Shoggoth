import { ArchiveFormatError, ArchiveSecurityError } from "./archive-errors.js";
import { createArchiveOutputPathTracker, validateArchiveEntryPath } from "./archive-entry.js";
import { createAdmittedZipEntry } from "./archive-zip-entry.js";
import { zipPathKey } from "./archive-zip-names.js";
export function assertZipEntryBinding(archive, record, path) {
    const { entry } = record;
    const name = entry.name;
    validateArchiveEntryPath(name, { escapeLabel: "archive root" });
    if (archive.files[record.name] !== entry || zipPathKey(name) !== path)
        disagreement();
}
function disagreement() {
    throw new ArchiveFormatError("ZIP decoder disagrees with admitted directory metadata");
}
function collision() {
    throw new ArchiveSecurityError("entry-path", "zip archive contains duplicate or colliding entry names");
}
function matchesData(value, physical) {
    if (!value || typeof value !== "object")
        return false;
    const data = value;
    return Number.isInteger(data.crc32) && data.crc32 >= -0x80000000 && data.crc32 <= 0xffffffff &&
        (data.crc32 >>> 0) === physical.crc32 && data.uncompressedSize === physical.size &&
        data.compressedSize === physical.compressedSize && typeof data.getContentWorker === "function" &&
        data.compression?.magic === String.fromCharCode(physical.compressionMethod & 255, physical.compressionMethod >>> 8);
}
/** Internal: the caller has admitted these unchanged bytes and their metadata. */
export async function loadAdmittedZipArchive(buffer, admitted) {
    const physicalByPath = new Map();
    const trackOutputPath = createArchiveOutputPathTracker();
    for (const entry of admitted) {
        trackOutputPath(entry.portableKey, entry.portableKey);
        if (physicalByPath.has(entry.portableKey))
            collision();
        physicalByPath.set(entry.portableKey, entry);
    }
    const JSZip = await importOptionalJsZip();
    const archive = new JSZip();
    const originalFile = archive.file;
    const originalDescriptor = Object.getOwnPropertyDescriptor(archive, "file");
    const inserted = new Map();
    const remaining = new Map(physicalByPath);
    // JSZip's fileAdd can misclassify UNIX type bits as directories, rename an
    // entry, and erase its payload. Intercept only this private instance's load.
    Object.defineProperty(archive, "file", { configurable: true, writable: true,
        value: function (...args) {
            if (args.length === 1)
                return originalFile.apply(this, args);
            const [name, data, options] = args;
            if (this !== archive || args.length !== 3 || typeof name !== "string" || !options || typeof options !== "object")
                disagreement();
            validateArchiveEntryPath(name);
            const key = zipPathKey(name);
            const physical = remaining.get(key);
            if (!physical) {
                if (physicalByPath.has(key))
                    collision();
                disagreement();
            }
            const fields = options;
            const unixMode = physical.creatorSystem === 3 ? physical.externalAttributes >>> 16 : null;
            const dosMode = physical.creatorSystem === 0 ? physical.externalAttributes & 0x3f : null;
            const decoderDirectory = Boolean(physical.externalAttributes & 0x10) || physical.portableDirectory;
            if (physical.index !== inserted.size || fields.unixPermissions !== unixMode || fields.dosPermissions !== dosMode ||
                fields.dir !== decoderDirectory || !matchesData(data, physical))
                disagreement();
            const result = originalFile.call(this, name, data, {
                ...fields, dir: false, unixPermissions: null, dosPermissions: null, createFolders: false,
            });
            const entry = archive.files[name];
            if (!entry || typeof entry !== "object" || inserted.has(entry))
                disagreement();
            // fileAdd also substitutes an empty promise for declared-zero contents.
            // Retain the original decoder object so size/CRC checks still read bytes.
            entry._data = data;
            inserted.set(entry, { physical, data });
            remaining.delete(key);
            return result;
        },
    });
    try {
        const loaded = await archive.loadAsync(buffer, { createFolders: false });
        if (loaded !== archive)
            disagreement();
    }
    catch (error) {
        if (error instanceof ArchiveFormatError || error instanceof ArchiveSecurityError)
            throw error;
        throw new ArchiveFormatError(`invalid ZIP archive: ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
    }
    finally {
        if (originalDescriptor)
            Object.defineProperty(archive, "file", originalDescriptor);
        else
            Reflect.deleteProperty(archive, "file");
    }
    const names = Object.keys(archive.files);
    if (names.length !== admitted.length)
        collision();
    const normalized = [];
    for (const name of names) {
        validateArchiveEntryPath(name);
        const entry = archive.files[name];
        if (!entry || typeof entry.name !== "string")
            disagreement();
        validateArchiveEntryPath(entry.name);
        const insertion = inserted.get(entry);
        if (!insertion || zipPathKey(name) !== insertion.physical.portableKey || zipPathKey(entry.name) !== insertion.physical.portableKey ||
            entry.dir !== false || entry.unixPermissions !== null || entry.dosPermissions !== null ||
            entry._data !== insertion.data || !matchesData(entry._data, insertion.physical))
            disagreement();
        normalized[insertion.physical.index] = [name, entry, insertion.physical];
        inserted.delete(entry);
    }
    if (remaining.size || inserted.size)
        disagreement();
    const files = Object.create(null);
    const entries = new Map();
    for (const [name, entry, physical] of normalized) {
        const appendSlash = physical.kind === "directory" && !name.endsWith("/");
        const normalizedName = appendSlash ? `${name}/` : name;
        if (Object.hasOwn(files, normalizedName))
            collision();
        if (appendSlash) {
            entry.name = `${entry.name}/`;
        }
        files[normalizedName] = entry;
        entries.set(physical.portableKey, createAdmittedZipEntry(entry, normalizedName, physical));
    }
    archive.files = files;
    return { archive, entries };
}
async function importOptionalJsZip() {
    try {
        const module = await import("jszip");
        const candidate = typeof module === "function" ? module : module.default;
        if (typeof candidate !== "function" ||
            typeof candidate.prototype?.file !== "function" ||
            typeof candidate.prototype?.loadAsync !== "function") {
            throw new Error('Optional archive dependency "jszip" does not expose its constructor, file(), and loadAsync().');
        }
        return candidate;
    }
    catch (err) {
        throw missingOptionalArchiveDependencyError("jszip", err);
    }
}
function missingOptionalArchiveDependencyError(packageName, cause) {
    return new Error(`Optional archive dependency "${packageName}" is not installed. Install it to use ZIP archive helpers from @openclaw/fs-safe/archive.`, { cause });
}
