import { fileIdentityMismatchError, inspectFileIdentitySync } from "./strict-file-identity.js";
function safeNumber(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function safeExpected(identity) {
    return typeof identity.dev === "bigint" && typeof identity.ino === "bigint" &&
        identity.dev >= 0n && identity.ino >= 0n &&
        identity.dev <= 9007199254740991n && identity.ino <= 9007199254740991n;
}
function observeStatSync(inspect, expected, initial, platform = process.platform, captureIdentity) {
    if (platform === "win32" || (!initial && expected && !safeExpected(expected))) {
        // Preserve the strict Windows unknown-ID retry, including known components
        // and validation of the expected identity before the first observation.
        const stat = inspectFileIdentitySync(() => {
            const current = initial;
            initial = undefined;
            return (current ?? inspect(true));
        }, expected, platform);
        return (captureIdentity
            ? { stat, identity: expected ?? { dev: stat.dev, ino: stat.ino } }
            : stat);
    }
    const stat = initial ?? inspect(false);
    const { dev: rawDev, ino: rawIno } = stat;
    const numericDev = safeNumber(rawDev);
    const numericIno = safeNumber(rawIno);
    const dev = numericDev ? BigInt(rawDev) : typeof rawDev === "bigint" ? rawDev : undefined;
    const ino = numericIno ? BigInt(rawIno) : typeof rawIno === "bigint" ? rawIno : undefined;
    if (expected && ((dev !== undefined && dev !== expected.dev) ||
        (ino !== undefined && ino !== expected.ino)))
        throw fileIdentityMismatchError();
    if (numericDev && numericIno) {
        return (captureIdentity
            ? { stat, identity: expected ?? { dev: dev, ino: ino } }
            : stat);
    }
    // An unsafe numeric component is unknown, not a rounded identity. Retain
    // every exact component from this observation while obtaining the full ID.
    const exact = inspectFileIdentitySync(() => {
        const current = inspect(true);
        if ((dev !== undefined && current.dev !== dev) ||
            (ino !== undefined && current.ino !== ino))
            throw fileIdentityMismatchError();
        return current;
    }, expected, platform);
    return (captureIdentity
        ? { stat: exact, identity: expected ?? { dev: exact.dev, ino: exact.ino } }
        : exact);
}
/** Operation-local metadata plus exact identity; never use projected PathStat IDs. */
export function inspectStatObservationSync(inspect, expected, initial, platform = process.platform) {
    return observeStatSync(inspect, expected, initial, platform, true);
}
/** Revalidate an exact identity without allocating a receipt that the caller will discard. */
export function assertStatObservationSync(inspect, expected, initial, platform = process.platform) {
    return observeStatSync(inspect, expected, initial, platform, false);
}
