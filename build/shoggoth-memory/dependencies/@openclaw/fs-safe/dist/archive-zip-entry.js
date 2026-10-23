/** Internal: create only after the complete decoder/admission association. */
export function createAdmittedZipEntry(entry, name, physical) {
    const mode = physical.creatorSystem === 3 ? physical.externalAttributes >>> 16 : undefined;
    entry.dir = physical.kind === "directory";
    // Previously unsupported non-UNIX symlinks must also be recognizable to
    // public preflight consumers using JSZip's conventional type inspection.
    entry.unixPermissions = mode ?? (physical.kind === "symlink" ? 0o120000 : null);
    entry.dosPermissions = physical.creatorSystem === 0 ? physical.externalAttributes & 0x3f : null;
    return { entry, name, kind: physical.kind, mode, size: physical.size, crc32: physical.crc32 };
}
