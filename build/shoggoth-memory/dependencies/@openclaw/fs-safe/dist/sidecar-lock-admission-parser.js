import { parseSidecarLockSnapshot, readSidecarLockRawSnapshot, } from "./sidecar-lock-reclaim.js";
export function runSidecarAdmissionBoundary(admission, assertCurrent, callback) {
    assertCurrent();
    try {
        return admission.run(callback);
    }
    finally {
        assertCurrent();
    }
}
export async function awaitSidecarAdmissionBoundary(admission, assertCurrent, callback) {
    assertCurrent();
    try {
        return await admission.run(async () => {
            const boxed = Object.create(null);
            Object.defineProperty(boxed, "value", {
                value: undefined, enumerable: true, writable: true,
            });
            boxed.value = await callback();
            return boxed;
        });
    }
    finally {
        assertCurrent();
    }
}
export function observeSidecarLockParser(state, admission, accessor, assertCurrent) {
    assertCurrent();
    if (state.observed)
        return;
    try {
        state.parser = admission.run(accessor);
    }
    finally {
        assertCurrent();
    }
    state.observed = true;
}
export function scopedSidecarLockParser(state, admission, assertCurrent) {
    const parser = state.parser;
    return parser && ((raw) => admission.run(() => {
        assertCurrent();
        try {
            return Reflect.apply(parser, undefined, [raw]);
        }
        finally {
            assertCurrent();
        }
    }));
}
/** Cleanup may outlive its reservation; never invoke user code after authority is lost. */
export function conditionalSidecarLockParser(state, admission, isCurrent) {
    const parser = state.parser;
    return parser && ((raw) => {
        if (!isCurrent())
            return undefined;
        return admission.run(() => {
            if (!isCurrent())
                return undefined;
            let parsed;
            try {
                parsed = Reflect.apply(parser, undefined, [raw]);
            }
            catch (error) {
                if (!isCurrent())
                    return undefined;
                throw error;
            }
            return isCurrent() ? parsed : undefined;
        });
    });
}
export function parseSidecarLockSnapshotUnderAdmission(raw, state, admission, assertCurrent) {
    return parseSidecarLockSnapshot(raw, scopedSidecarLockParser(state, admission, assertCurrent));
}
/** Emulate the historical EEXIST read/parser boundary without opening another sidecar. */
export async function observeHeldSidecarParser(params) {
    const holderChanged = {};
    const assertCurrentHolder = () => {
        params.assertToken();
        if (params.currentHeld() !== params.held || params.held.releasePromise) {
            throw holderChanged;
        }
    };
    let transientDenial = false;
    let raw;
    try {
        raw = await params.admission.run(async () => await readSidecarLockRawSnapshot(params.lockPath, {
            lockRoot: params.lockRoot,
            rejectNonFile: true,
            discardObservation: "changed",
            onOpenFailure: (error) => { transientDenial = params.isTransientDenial(error); },
        }));
    }
    catch (error) {
        return { kind: "read-error", error, transientDenial };
    }
    params.assertToken();
    if (params.currentHeld() !== params.held || params.held.releasePromise) {
        return { kind: "holder-changed" };
    }
    try {
        observeSidecarLockParser(params.parserState, params.admission, params.parserAccessor, assertCurrentHolder);
        parseSidecarLockSnapshotUnderAdmission(raw, params.parserState, params.admission, assertCurrentHolder);
        assertCurrentHolder();
    }
    catch (error) {
        if (error === holderChanged)
            return { kind: "holder-changed" };
        throw error;
    }
    return { kind: "observed" };
}
