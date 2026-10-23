export class ArchiveSecurityError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "ArchiveSecurityError";
    }
}
export class ArchiveFormatError extends Error {
    code;
    constructor(message, options) {
        super(message, options);
        this.name = "ArchiveFormatError";
        this.code = "archive-header-invalid";
    }
}
export function isArchiveFormatErrorMessage(message) {
    return (message.includes("archive-header-invalid") ||
        message.includes("archive entry size did not match its manifest"));
}
export function isArchiveTarPathErrorMessage(message) {
    return message.includes("archive-gnu-path-invalid") || message.includes("archive-entry-path-invalid");
}
