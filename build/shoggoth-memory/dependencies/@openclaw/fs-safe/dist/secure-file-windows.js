import { fileIdentityMismatchError } from "./strict-file-identity.js";
import { getNativeBinding } from "./native.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import { inspectWindowsDescriptorCommand } from "./windows-security-command.js";
import { unverified as permissionUnverified, validateSecureWindowsSecurityFacts } from "./windows-security-facts.js";
const IDENTITY_RE = /^([0-9a-f]{8}):([0-9a-f]{16})$/;
const TRUSTED_OWNER_CLASSES = new Set(["current-user", "system", "administrators"]);
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function parseIdentity(value) {
    if (typeof value !== "string")
        throw fileIdentityMismatchError();
    const match = IDENTITY_RE.exec(value);
    if (!match)
        throw fileIdentityMismatchError();
    return {
        dev: BigInt(`0x${match[1]}`),
        ino: BigInt(`0x${match[2]}`),
    };
}
function inspectDescriptorResult(params, result, mechanism) {
    if (!isRecord(result))
        permissionUnverified("Windows descriptor ACL facts were malformed");
    const observed = parseIdentity(result.identity);
    if (observed.dev !== params.identity.dev || observed.ino !== params.identity.ino) {
        throw fileIdentityMismatchError();
    }
    const facts = validateSecureWindowsSecurityFacts(result.security);
    return {
        ok: true,
        isSymlink: false,
        isDir: params.stat.isDirectory(),
        mode: typeof params.stat.mode === "number" ? params.stat.mode : null,
        bits: null,
        source: "windows-acl",
        worldWritable: facts.worldWritable,
        groupWritable: facts.groupWritable,
        worldReadable: facts.worldReadable,
        groupReadable: facts.groupReadable,
        ownerSid: facts.ownerSid,
        ownerTrusted: TRUSTED_OWNER_CLASSES.has(facts.ownerClass),
        aclSummary: `${mechanism} descriptor owner=${facts.ownerClass} world=` +
            `${facts.worldReadable ? "r" : "-"}${facts.worldWritable ? "w" : "-"} ` +
            `group=${facts.groupReadable ? "r" : "-"}${facts.groupWritable ? "w" : "-"}`,
    };
}
/** Both mechanisms inspect the same borrowed handle; the caller owns its lifetime. */
export async function inspectSecureWindowsFile(params) {
    let native;
    try {
        native = getNativeBinding();
    }
    catch (cause) {
        permissionUnverified("Windows descriptor ACL verification requires the matching native helper", cause);
    }
    const inspect = native?.inspectWindowsSecureFileHandle;
    const nativeAvailable = typeof inspect === "function";
    if (!nativeAvailable && getFsSafeNativeConfig().mode === "require") {
        permissionUnverified("Windows descriptor ACL verification requires an up-to-date native helper");
    }
    if (!nativeAvailable) {
        warnNativeFallback("windows-secure-file", "Windows descriptor ACL inspection uses a slower built-in system command.");
    }
    let result;
    try {
        if (nativeAvailable) {
            result = inspect.call(native, params.fd);
        }
        else {
            result = await inspectWindowsDescriptorCommand(params.fd);
        }
    }
    catch (cause) {
        permissionUnverified("Windows descriptor ACL verification failed", cause);
    }
    return inspectDescriptorResult(params, result, nativeAvailable ? "native" : "system-command");
}
