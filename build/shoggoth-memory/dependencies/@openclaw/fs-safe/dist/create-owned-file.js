import fs from "node:fs";
/** Capture the descriptor's creator-owned closer before it can be reused. */
export function ownFileDescriptorSync(fd, closeFd = fs.closeSync) {
    let open = true;
    const owner = {
        fd,
        close() {
            if (!open)
                return;
            open = false;
            closeFd(fd);
        },
        [Symbol.dispose]() { owner.close(); },
    };
    return Object.freeze(owner);
}
