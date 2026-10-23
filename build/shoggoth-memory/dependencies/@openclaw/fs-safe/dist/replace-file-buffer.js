export function* writeAtomicDestination(file, data, destination, restore = false) {
    if (destination)
        yield* destination.beforeWrite(restore);
    yield* file.truncate(0);
    destination?.writing();
    let written = 0;
    while (written < data.length) {
        if (destination)
            yield* destination.beforeWrite(restore);
        let result = file.write(data, written, data.length - written, written);
        if (file.io.asynchronous) {
            const completed = (yield result);
            if (completed.bytesWritten === 0)
                throw new Error("Copy fallback write made no progress");
            result = completed.bytesWritten;
        }
        written += result;
    }
    if (destination)
        yield* destination.beforeWrite(restore);
    yield* file.truncate(data.length);
}
