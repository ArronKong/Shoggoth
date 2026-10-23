import fsSync from "node:fs";
import { formatIcaclsResetCommand, inspectWindowsPermissions, } from "./permissions-windows.js";
import { hasWindowsPathAlias, pathForWindowsFilesystem, } from "./windows-path-alias.js";
function failedSafeStat(error) {
    return {
        ok: false,
        isSymlink: false,
        isDir: false,
        mode: null,
        uid: null,
        gid: null,
        error,
    };
}
async function safeStatAdmitted(targetPath) {
    try {
        const lst = fsSync.lstatSync(pathForWindowsFilesystem(targetPath));
        return {
            ok: true,
            isSymlink: lst.isSymbolicLink(),
            isDir: lst.isDirectory(),
            mode: typeof lst.mode === "number" ? lst.mode : null,
            uid: typeof lst.uid === "number" ? lst.uid : null,
            gid: typeof lst.gid === "number" ? lst.gid : null,
        };
    }
    catch (err) {
        return failedSafeStat(String(err));
    }
}
export async function safeStat(targetPath) {
    if (hasWindowsPathAlias(targetPath, "filesystem")) {
        return failedSafeStat("Path uses a Windows filesystem namespace alias");
    }
    return await safeStatAdmitted(targetPath);
}
export async function inspectPathPermissions(targetPath, opts) {
    const admissionPlatform = process.platform === "win32"
        ? process.platform
        : (opts?.platform ?? process.platform);
    const st = hasWindowsPathAlias(targetPath, "filesystem", admissionPlatform)
        ? failedSafeStat("Path uses a Windows filesystem namespace alias")
        : await safeStatAdmitted(targetPath);
    if (!st.ok) {
        return {
            ok: false,
            isSymlink: false,
            isDir: false,
            mode: null,
            bits: null,
            source: "unknown",
            worldWritable: false,
            groupWritable: false,
            worldReadable: false,
            groupReadable: false,
            error: st.error,
        };
    }
    let effectiveMode = st.mode;
    let effectiveIsDir = st.isDir;
    if (st.isSymlink) {
        try {
            const target = fsSync.statSync(targetPath);
            effectiveMode = typeof target.mode === "number" ? target.mode : st.mode;
            effectiveIsDir = target.isDirectory();
        }
        catch {
            // Keep lstat metadata when the symlink target cannot be inspected.
        }
    }
    const bits = modeBits(effectiveMode);
    const platform = opts?.platform ?? process.platform;
    const windows = platform === "win32";
    const permissions = {
        ok: true,
        isSymlink: st.isSymlink,
        isDir: effectiveIsDir,
        mode: effectiveMode,
        bits,
        source: windows ? "unknown" : "posix",
        worldWritable: !windows && isWorldWritable(bits),
        groupWritable: !windows && isGroupWritable(bits),
        worldReadable: !windows && isWorldReadable(bits),
        groupReadable: !windows && isGroupReadable(bits),
    };
    return windows ? await inspectWindowsPermissions(targetPath, permissions, opts) : permissions;
}
export function formatPermissionDetail(targetPath, perms) {
    if (perms.source === "windows-acl") {
        return `${targetPath} acl=${perms.aclSummary ?? "unknown"}`;
    }
    return `${targetPath} mode=${formatOctal(perms.bits)}`;
}
export function formatPermissionRemediation(params) {
    if (params.perms.source === "windows-acl") {
        return formatIcaclsResetCommand(params.targetPath, {
            isDir: params.isDir,
            env: params.env,
        });
    }
    const optionSeparator = params.targetPath.startsWith("-") ? "-- " : "";
    return (`chmod ${params.posixMode.toString(8).padStart(3, "0")} ${optionSeparator}` +
        formatPosixShellArgument(params.targetPath));
}
function formatPosixShellArgument(value) {
    if (value && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
        return value;
    }
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
export function modeBits(mode) {
    return mode == null ? null : mode & 0o777;
}
export function formatOctal(bits) {
    return bits == null ? "unknown" : bits.toString(8).padStart(3, "0");
}
export function isWorldWritable(bits) {
    return bits != null && (bits & 0o002) !== 0;
}
export function isGroupWritable(bits) {
    return bits != null && (bits & 0o020) !== 0;
}
export function isWorldReadable(bits) {
    return bits != null && (bits & 0o004) !== 0;
}
export function isGroupReadable(bits) {
    return bits != null && (bits & 0o040) !== 0;
}
export function formatPosixMode(mode) {
    return (mode & 0o777).toString(8).padStart(3, "0");
}
