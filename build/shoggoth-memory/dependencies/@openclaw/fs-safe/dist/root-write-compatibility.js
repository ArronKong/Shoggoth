import { withPinnedWriteRenameIdentityLock } from "./pinned-write.js";
import { createRootWriteLockBinding } from "./root-write-lock-binding.js";
import { serializePathWrite } from "./write-queue.js";
export async function withRootFallbackCompatibilityLock(params, run) {
    const binding = createRootWriteLockBinding(params);
    const callerAssertion = params.assertBeforeMutation;
    const assertBeforeMutation = callerAssertion === undefined
        ? binding.assertCurrent
        : () => { callerAssertion.call(params); binding.assertCurrent(); };
    // Keep the alias queue and historical lock hash before admitting the writer.
    try {
        return await serializePathWrite(binding.targetPath, async () => await withPinnedWriteRenameIdentityLock({
            rootPath: params.rootPath, targetPath: binding.targetPath, relativeTargetPath: binding.relativeLockPath,
        }, async () => await run({
            targetPath: binding.targetPath,
            relativePath: binding.relativePath,
            assertBeforeMutation,
        })));
    }
    finally {
        binding.dispose();
    }
}
