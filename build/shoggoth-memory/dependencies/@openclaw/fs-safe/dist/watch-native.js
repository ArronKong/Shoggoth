import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { getFsSafeNativeConfig } from "./native-config.js";
export function watchBinding(mode) {
    if (mode === "poll")
        return;
    const binding = getNativeBinding(); // Preserves require + missing-addon failure.
    // Bun TSFN teardown remains unqualified; guarded native scans remain usable.
    if (binding?.watchRegister && (process.platform !== "darwin" || (binding.watchConfigure && binding.watchEntries)) && !process.versions.bun && !process.versions.deno && ["linux", "darwin", "win32"].includes(process.platform))
        return binding;
    if (mode === "events" || getFsSafeNativeConfig().mode === "require") {
        throw new FsSafeError("helper-unavailable", "native watch events are unavailable", { details: { operation: "watch" } });
    }
}
export class NativeWatchBackend {
    binding;
    root;
    id;
    streamPaths;
    directories;
    constructor(binding, root, callback, limit, persistent) {
        this.binding = binding;
        this.root = root;
        this.streamPaths = JSON.stringify({ anchors: [], exclusions: [] });
        try {
            this.id = binding.watchRegister(root.rootReal, limit, batch => {
                if (this.id !== undefined)
                    callback({ overflow: batch.overflow, error: batch.error, hints: batch.hints.map(hint => ({
                            directory: hint.directory, name: hint.name, event: hint.subtree ? "subtree" : hint.namelessChild ? "children" : hint.structural ? "rename" : "change",
                        })) });
            }, persistent);
        }
        catch (cause) {
            throw watchError(cause);
        }
    }
    add(name, identity) {
        try {
            this.binding.watchAdd(this.id, { root: this.root.rootReal, relative: name,
                rootDev: BigInt(this.root.rootIdentity.dev), rootIno: BigInt(this.root.rootIdentity.ino), ...identity });
        }
        catch (cause) {
            throw watchError(cause);
        }
    }
    testEvent(path, flags) { this.binding.watchTestEvent(this.id, path, flags); }
    entries(snapshot) {
        if (process.platform !== "darwin")
            return false;
        const entries = [...snapshot.entryAnchors ?? []].map(([scope, anchor]) => ({
            scope, name: anchor.name, target: anchor.target,
            directory: { root: this.root.rootReal, relative: anchor.directory,
                rootDev: BigInt(this.root.rootIdentity.dev), rootIno: BigInt(this.root.rootIdentity.ino), ...snapshot.directories.get(anchor.directory) },
        }));
        try {
            const result = this.binding.watchEntries(this.id, entries);
            this.directories = result.directories;
            return result.changed;
        }
        catch (cause) {
            throw watchError(cause);
        }
    }
    configure(paths) {
        if (process.platform !== "darwin")
            return false;
        const key = JSON.stringify(paths);
        if (this.streamPaths === key)
            return false;
        try {
            this.binding.watchConfigure(this.id, paths.anchors, paths.exclusions);
        }
        catch (cause) {
            throw watchError(cause);
        }
        this.streamPaths = key;
        return true;
    }
    close() {
        const id = this.id;
        this.id = undefined; // Fence queued TSFN callbacks before synchronous native join.
        if (id !== undefined)
            this.binding.watchUnregister(id);
    }
}
function watchError(cause) {
    const code = cause?.code;
    return new FsSafeError(code === "ENOTSUP" ? "helper-unavailable" : ["ESTALE", "ENOTDIR", "ELOOP"].includes(code ?? "") ? "path-mismatch" : code === "ENOENT" ? "not-found" : "helper-failed", "native watch registration failed", {
        cause, details: { operation: "watch", code },
    });
}
