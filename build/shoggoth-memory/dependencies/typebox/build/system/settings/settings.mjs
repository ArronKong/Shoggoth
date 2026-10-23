import { Guard } from '../../guard/index.mjs';
// -------------------------------------------------------------------
// State
// -------------------------------------------------------------------
// Internal mutable state
const settings = {
    immutableTypes: false,
    maxErrors: 8,
    maxParseErrors: 1,
    maxInstantiationCount: 128,
    useAcceleration: true,
    exactOptionalPropertyTypes: false,
    enumerableKind: false,
    correctiveParse: false,
    unionPrioritySort: true
};
// -------------------------------------------------------------------
// Reset
// -------------------------------------------------------------------
/** Resets system settings to defaults */
export function Reset() {
    settings.immutableTypes = false;
    settings.maxErrors = 8;
    settings.maxParseErrors = 1;
    settings.maxInstantiationCount = 128;
    settings.useAcceleration = true;
    settings.exactOptionalPropertyTypes = false;
    settings.enumerableKind = false;
    settings.correctiveParse = false;
    settings.unionPrioritySort = true;
}
// -------------------------------------------------------------------
// Set
// -------------------------------------------------------------------
/** Sets system settings */
export function Set(options) {
    for (const key of Guard.Keys(options)) {
        const value = options[key];
        if (value !== undefined) {
            Object.defineProperty(settings, key, { value });
        }
    }
}
// -------------------------------------------------------------------
// Get
// -------------------------------------------------------------------
/** Gets current system settings */
export function Get() {
    return settings;
}
