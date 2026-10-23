import { replaceFileAtomic } from "./replace-file.js";
import { admitStandalonePublicationPath } from "./windows-path-alias.js";
export async function writeTextAtomic(filePath, content, options) {
    const admittedPath = admitStandalonePublicationPath(filePath);
    const payload = options?.trailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
    const durable = options?.durable ?? true;
    await replaceFileAtomic({
        filePath: admittedPath,
        content: payload,
        mode: options?.mode ?? 0o600,
        dirMode: options?.dirMode ?? (0o777 & ~process.umask()),
        copyFallbackOnPermissionError: true,
        syncTempFile: durable,
        syncParentDir: durable,
        beforeRename: options?.beforeRename,
        tempPrefix: options?.tempPrefix,
    });
}
