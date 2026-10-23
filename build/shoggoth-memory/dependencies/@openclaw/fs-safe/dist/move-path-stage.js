import fsSync, {} from "node:fs";
import path from "node:path";
import { createAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { guardedRm, guardedRmSync } from "./guarded-mutation.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { registerTempPathForExit } from "./temp-cleanup.js";
import { realpathSync } from "./realpath.js";
export async function createMoveStageOwner(staged) {
    const parent = await createAsyncDirectoryGuard(path.dirname(staged), { bigint: true });
    let identity;
    let unregister;
    const changed = () => new FsSafeError("path-mismatch", "move staging path changed before publication");
    const assertParent = () => {
        const current = fsSync.lstatSync(parent.dir, { bigint: true });
        if (!current.isDirectory() || current.isSymbolicLink() ||
            !sameFileIdentityForCleanup(current, parent.stat) ||
            realpathSync.native(parent.dir) !== parent.realPath)
            throw changed();
    };
    const assertCurrent = () => {
        assertParent();
        if (!identity || !sameFileIdentityForCleanup(fsSync.lstatSync(staged, { bigint: true }), identity)) {
            throw changed();
        }
    };
    return {
        record(created) {
            if (!sameFileIdentityForCleanup(created, created))
                throw changed();
            identity = created;
            unregister = registerTempPathForExit(staged, {
                identity,
                cleanupSync: () => {
                    guardedRmSync({ target: staged, recursive: created.isDirectory(), assertBeforeMutation: assertCurrent });
                },
            });
        },
        assertCurrent,
        published() { unregister?.(); },
        async cleanup() {
            if (!identity)
                return;
            try {
                await guardedRm({ target: staged, recursive: identity.isDirectory(), assertBeforeMutation: assertCurrent });
                unregister?.();
            }
            catch (error) {
                if (error.code === "ENOENT" || error instanceof FsSafeError) {
                    unregister?.();
                }
                // Retry only the original receipt after transient cleanup I/O failures.
            }
        },
    };
}
