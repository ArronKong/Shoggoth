import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError } from "./path.js";
import { assertValidRootRelativePath } from "./root-context.js";
import { assertRootDirectoryObservationGuard, pathStatFromStats } from "./root-directory-list.js";
import { inspectStatObservationSync } from "./stat-observation.js";
/** One literal entry lookup under an operation-local admitted parent; never follow the leaf. */
export async function lookupRootDirectoryEntry(root, guard, name) {
    if (!name || name === "." || name === ".." || path.basename(name) !== name || path.isAbsolute(name)) {
        throw new FsSafeError("invalid-path", "directory lookup requires one literal name");
    }
    assertValidRootRelativePath(name);
    await assertRootDirectoryObservationGuard(root, guard);
    try {
        const pathname = path.join(guard.realPath, name);
        const observed = inspectStatObservationSync(bigint => bigint
            ? fs.lstatSync(pathname, { bigint: true }) : fs.lstatSync(pathname));
        await assertRootDirectoryObservationGuard(root, guard);
        return { entry: { name, ...pathStatFromStats(observed.stat) }, identity: observed.identity };
    }
    catch (error) {
        await assertRootDirectoryObservationGuard(root, guard);
        if (isNotFoundPathError(error))
            return undefined;
        throw error;
    }
}
