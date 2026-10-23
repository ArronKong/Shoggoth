import fs from "node:fs";
import { pathForWindowsFilesystem } from "./windows-path-alias.js";
/** True if stat succeeds; follows symlinks, so broken links return false. */
export async function pathExists(filePath) {
    try {
        fs.statSync(pathForWindowsFilesystem(filePath));
        return true;
    }
    catch {
        return false;
    }
}
/** Synchronous {@link pathExists}. */
export function pathExistsSync(filePath) {
    try {
        fs.statSync(pathForWindowsFilesystem(filePath));
        return true;
    }
    catch {
        return false;
    }
}
