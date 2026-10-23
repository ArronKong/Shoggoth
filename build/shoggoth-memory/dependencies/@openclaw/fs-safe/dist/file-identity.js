import { createHash } from "node:crypto";
function isZero(value) {
    return value === 0 || value === 0n;
}
function sameStatValue(left, right) {
    return typeof left === typeof right ? left === right : BigInt(left) === BigInt(right);
}
function isStatValueProvablyDifferent(left, right, platform) {
    if (sameStatValue(left, right)) {
        return false;
    }
    return platform !== "win32" || (!isZero(left) && !isZero(right));
}
export function sha256Hex(data, encoding) {
    const buffer = typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : data;
    return createHash("sha256").update(buffer).digest("hex");
}
export function sameFileIdentity(left, right, platform = process.platform) {
    // When Windows cannot open a path for stat, libuv's FindFirstFile fallback reports dev=0 and
    // ino=0. Treating either unknown value as a mismatch caused nondeterministic path-mismatch
    // failures on legitimate reads under antivirus or indexer contention.
    return (!isStatValueProvablyDifferent(left.dev, right.dev, platform) &&
        !isStatValueProvablyDifferent(left.ino, right.ino, platform));
}
function sameCleanupStatValue(left, right) {
    // Converting an unsafe number to bigint cannot recover an already rounded ID.
    if (typeof left === "number" && !Number.isSafeInteger(left))
        return false;
    if (typeof right === "number" && !Number.isSafeInteger(right))
        return false;
    return sameStatValue(left, right);
}
export function sameFileIdentityForCleanup(left, right, platform = process.platform) {
    if (platform !== "win32") {
        return sameCleanupStatValue(left.dev, right.dev) && sameCleanupStatValue(left.ino, right.ino);
    }
    // Unknown Windows identity components cannot authorize cleanup: a replacement
    // could share the known component. Snapshot adapter-backed fields once so
    // changing accessors cannot alter the check.
    const leftDev = left.dev;
    if (isZero(leftDev))
        return false;
    const leftIno = left.ino;
    if (isZero(leftIno))
        return false;
    const rightDev = right.dev;
    if (isZero(rightDev))
        return false;
    const rightIno = right.ino;
    if (isZero(rightIno))
        return false;
    return sameCleanupStatValue(leftDev, rightDev) && sameCleanupStatValue(leftIno, rightIno);
}
