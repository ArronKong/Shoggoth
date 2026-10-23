import fs from "node:fs";
export async function syncFileBestEffort(handle) {
    try {
        await handle.sync();
    }
    catch (error) {
        if (error?.code !== "EPERM")
            throw error;
    }
}
export function syncFileBestEffortSync(fd, fsModule = fs) {
    try {
        fsModule.fsyncSync(fd);
    }
    catch (error) {
        if (error?.code !== "EPERM")
            throw error;
    }
}
