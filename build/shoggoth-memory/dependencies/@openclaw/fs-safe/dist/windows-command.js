import path from "node:path";
function getEnvValueCaseInsensitive(env, name) {
    const direct = env[name];
    if (direct !== undefined) {
        return direct;
    }
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(env)) {
        if (key.toLowerCase() === lower) {
            return value;
        }
    }
    return undefined;
}
function normalizeWindowsInstallRoot(value) {
    const trimmed = value?.trim();
    if (!trimmed || !path.win32.isAbsolute(trimmed)) {
        return null;
    }
    let end = trimmed.length;
    while (end > 0 && (trimmed[end - 1] === "\\" || trimmed[end - 1] === "/")) {
        end -= 1;
    }
    return trimmed.slice(0, end);
}
function resolveWindowsSystemRoot(env) {
    const source = env ?? process.env;
    return (normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(source, "SystemRoot")) ??
        normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(source, "WINDIR")) ??
        "C:\\Windows");
}
export function resolveWindowsSystemCommand(command, env) {
    return path.win32.join(resolveWindowsSystemRoot(env), "System32", command);
}
