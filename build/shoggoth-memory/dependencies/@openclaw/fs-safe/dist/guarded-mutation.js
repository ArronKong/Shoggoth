import fsSync, {} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertAsyncDirectoryGuard, assertSyncDirectoryGuard, createAsyncDirectoryGuard, createSyncDirectoryGuard, } from "./directory-guard.js";
export async function withAsyncDirectoryGuards(guards, mutate, options = {}) {
    for (const guard of guards) {
        await assertAsyncDirectoryGuard(guard);
    }
    const result = await mutate();
    if (options.verifyAfter !== false) {
        try {
            for (const guard of guards) {
                await assertAsyncDirectoryGuard(guard);
            }
        }
        catch (error) {
            if (options.onPostGuardFailure) {
                try {
                    // The mutation may have returned an owned resource before the post-guard
                    // check detected a swapped directory. Give callers one chance to close
                    // handles without letting cleanup hide the boundary failure.
                    await options.onPostGuardFailure(result, error);
                }
                catch {
                    // Preserve the boundary failure. Cleanup is best-effort.
                }
            }
            throw error;
        }
    }
    return result;
}
export function withSyncDirectoryGuards(guards, mutate, options = {}) {
    for (const guard of guards) {
        assertSyncDirectoryGuard(guard);
    }
    const result = mutate();
    if (options.verifyAfter !== false) {
        for (const guard of guards) {
            assertSyncDirectoryGuard(guard);
        }
    }
    return result;
}
export async function guardedRename(params) {
    const sourceGuard = await createAsyncDirectoryGuard(path.dirname(params.from));
    const targetGuard = await createAsyncDirectoryGuard(path.dirname(params.to));
    await withAsyncDirectoryGuards([sourceGuard, targetGuard], async () => {
        if (params.onSourceInspected) {
            params.onSourceInspected(fsSync.lstatSync(params.from, { bigint: true }));
        }
        // Authority must survive all awaited guards; do not yield before rename dispatch.
        params.assertBeforeRename?.();
        await fs.rename(params.from, params.to);
        params.onRenamed?.();
    });
}
export function guardedRenameSync(params) {
    const sourceGuard = createSyncDirectoryGuard(path.dirname(params.from));
    const targetGuard = createSyncDirectoryGuard(path.dirname(params.to));
    withSyncDirectoryGuards([sourceGuard, targetGuard], () => fsSync.renameSync(params.from, params.to));
}
export async function guardedRm(params) {
    const guard = await createAsyncDirectoryGuard(path.dirname(params.target));
    await withAsyncDirectoryGuards([guard], async () => {
        params.assertBeforeMutation?.();
        await fs.rm(params.target, {
            ...(params.recursive !== undefined ? { recursive: params.recursive } : {}),
        });
    });
}
export function guardedRmSync(params) {
    const guard = createSyncDirectoryGuard(path.dirname(params.target));
    withSyncDirectoryGuards([guard], () => {
        params.assertBeforeMutation?.();
        fsSync.rmSync(params.target, {
            ...(params.recursive !== undefined ? { recursive: params.recursive } : {}),
            ...(params.force !== undefined ? { force: params.force } : {}),
        });
    }, { verifyAfter: params.verifyAfter });
}
