import fs, {} from "node:fs";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { realpathSync } from "./realpath.js";
import { assertNoWindowsPathAlias, pathForWindowsFilesystem, resolvePathPreservingWindowsRoot, } from "./windows-path-alias.js";
const numericFields = ["dev", "mode", "nlink", "uid", "gid", "rdev", "blksize", "ino", "size", "blocks"];
const timeFields = ["atime", "mtime", "ctime", "birthtime"];
// Live pins retain private authority. New admissions snapshot the supplied
// fields and accept exact provenance only while its public identity is intact.
const authorities = new WeakMap();
const identities = new WeakMap();
export function directoryReceiptIdentity(identity) {
    if (!identity) {
        throw new FsSafeError("path-mismatch", "directory receipt identity is missing");
    }
    const known = identities.get(identity);
    const dev = identity.dev;
    const ino = identity.ino;
    if (known) {
        const matches = (value, expected) => typeof value === "bigint" ? value === expected : value === Number(expected);
        if (!matches(dev, known.identity.dev) || !matches(ino, known.identity.ino)) {
            throw new FsSafeError("path-mismatch", "directory receipt identity changed");
        }
        return known.identity;
    }
    const exact = (value) => {
        if ((typeof value !== "bigint" && !Number.isSafeInteger(value)) ||
            (process.platform === "win32" && (value === 0 || value === 0n))) {
            throw new FsSafeError("path-mismatch", "directory receipt identity could not be verified");
        }
        return BigInt(value);
    };
    return Object.freeze({ dev: exact(dev), ino: exact(ino) });
}
function snapshotDirectoryReceipt(receipt) {
    const pathname = receipt?.path;
    const realPath = receipt?.realPath;
    const stat = receipt?.identity;
    if (typeof pathname !== "string" || typeof realPath !== "string" || stat == null) {
        throw new FsSafeError("path-mismatch", "directory receipt is incomplete");
    }
    assertNoWindowsPathAlias(pathname, "filesystem");
    assertNoWindowsPathAlias(realPath, "filesystem");
    const identity = directoryReceiptIdentity(stat);
    const known = authorities.get(receipt);
    if (known && (pathname !== known.path || realPath !== known.realPath ||
        identity.dev !== known.identity.dev || identity.ino !== known.identity.ino)) {
        throw new FsSafeError("path-mismatch", "directory receipt changed before admission");
    }
    const metadata = known?.metadata ?? identities.get(stat)?.metadata ?? snapshotDirectoryMetadata(stat, identity);
    return Object.freeze({ path: pathname, realPath, identity, metadata });
}
function snapshotDirectoryMetadata(stat, identity) {
    const metadata = {};
    for (const field of numericFields) {
        metadata[field] = Number(field === "dev" || field === "ino" ? identity[field] : stat[field]);
    }
    for (const field of timeFields) {
        if ("atimeNs" in stat) {
            const nanoseconds = stat[`${field}Ns`];
            const remainder = ((nanoseconds % 1000000000n) + 1000000000n) % 1000000000n;
            metadata[`${field}Ms`] = Number((nanoseconds - remainder) / 1000000000n) * 1_000 + Number(remainder) / 1_000_000;
        }
        else {
            metadata[`${field}Ms`] = stat[`${field}Ms`];
        }
    }
    return Object.freeze(metadata);
}
export function directoryReceiptAuthority(receipt) {
    return authorities.get(receipt) ?? snapshotDirectoryReceipt(receipt);
}
export function ownDirectoryReceipt(receipt) {
    return receiptFromAuthority(snapshotDirectoryReceipt(receipt));
}
export function copyRetainedDirectoryReceipt(receipt) {
    const authority = directoryReceiptAuthority(receipt);
    return receiptFromAuthority(authority);
}
function receiptFromAuthority(authority) {
    const receipt = {
        path: authority.path,
        realPath: authority.realPath,
        identity: Object.assign(Object.create(fs.Stats.prototype), authority.metadata),
    };
    authorities.set(receipt, authority);
    identities.set(receipt.identity, authority);
    return receipt;
}
// The caller already admitted the exact observation and its paths.
export function createDirectoryReceiptFromIdentity(pathname, realPath, exactStat) {
    const identity = Object.freeze({ dev: exactStat.dev, ino: exactStat.ino });
    return receiptFromAuthority(Object.freeze({
        path: pathname,
        realPath,
        identity,
        // Project metadata from the admitted observation, never a fresh pathname stat.
        metadata: snapshotDirectoryMetadata(exactStat, identity),
    }));
}
export function createDirectoryReceiptSync(directoryPath, label, canonicalize = realpathSync) {
    assertNoWindowsPathAlias(directoryPath, "filesystem", `${label} path uses a Windows filesystem namespace alias`);
    const pathname = resolvePathPreservingWindowsRoot(directoryPath);
    assertNoWindowsPathAlias(pathname, "filesystem", `${label} path uses a Windows filesystem namespace alias`);
    const exact = inspectDirectoryIdentitySync(pathname);
    const operationPath = pathForWindowsFilesystem(pathname);
    const realPath = canonicalize(operationPath);
    assertNoWindowsPathAlias(realPath, "filesystem", `${label} real path uses a Windows filesystem namespace alias`);
    return createDirectoryReceiptFromIdentity(pathname, realPath, exact);
}
export function assertDirectoryReceiptCurrentSync(receipt, label, canonicalize = realpathSync) {
    const authority = directoryReceiptAuthority(receipt);
    assertNoWindowsPathAlias(authority.path, "filesystem", `${label} path uses a Windows filesystem namespace alias`);
    assertNoWindowsPathAlias(authority.realPath, "filesystem", `${label} real path uses a Windows filesystem namespace alias`);
    inspectDirectoryIdentitySync(authority.path, authority.identity);
    const realPath = canonicalize(pathForWindowsFilesystem(authority.path));
    assertNoWindowsPathAlias(realPath, "filesystem", `${label} real path uses a Windows filesystem namespace alias`);
    if (realPath !== authority.realPath) {
        throw new FsSafeError("path-mismatch", `${label} changed during durable directory operation: ${authority.path}`);
    }
}
