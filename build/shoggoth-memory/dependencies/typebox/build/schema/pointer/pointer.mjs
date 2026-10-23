// deno-fmt-ignore-file
import { Guard } from '../../guard/index.mjs';
// ------------------------------------------------------------------
// Throw
// ------------------------------------------------------------------
function Throw(message) {
    throw Error(message);
}
function ThrowUnsafePropertyKey() {
    Throw('Pointer contains unsafe property key');
}
function ThrowCannotSetRoot() {
    Throw('Cannot set value');
}
// ------------------------------------------------------------------
// Indices
// ------------------------------------------------------------------
export function Indices(pointer) {
    const indices = pointer.split('/').map(index => index.replace(/~1/g, '/').replace(/~0/g, '~'));
    return indices[0] === '' ? indices.slice(1) : indices;
}
// ------------------------------------------------------------------
// Has
// ------------------------------------------------------------------
export function Has(value, pointer) {
    let current = value;
    for (const index of Indices(pointer)) {
        if (!Guard.IsObject(current) || !Guard.HasPropertyKey(current, index))
            return false;
        current = current[index];
    }
    return true;
}
// ------------------------------------------------------------------
// Get
// ------------------------------------------------------------------
export function Get(value, pointer) {
    let current = value;
    for (const index of Indices(pointer)) {
        if (!Guard.IsObject(current) || Guard.IsUnsafePropertyKey(index))
            return undefined;
        current = current[index];
    }
    return current;
}
// ------------------------------------------------------------------
// Get
// ------------------------------------------------------------------
function Parent(value, indices, last) {
    let current = value;
    for (const index of indices) {
        if (Guard.IsUnsafePropertyKey(index))
            ThrowUnsafePropertyKey();
        current = Guard.IsObject(current) ? current[index] : undefined;
    }
    if (Guard.IsUnsafePropertyKey(last))
        ThrowUnsafePropertyKey();
    if (!Guard.IsObject(current))
        ThrowCannotSetRoot();
    return current;
}
// ------------------------------------------------------------------
// Set
// ------------------------------------------------------------------
export function Set(value, pointer, next) {
    const indices = Indices(pointer);
    const last = indices.pop();
    if (Guard.IsUndefined(last))
        ThrowCannotSetRoot();
    Parent(value, indices, last)[last] = next;
    return value;
}
// ------------------------------------------------------------------
// Delete
// ------------------------------------------------------------------
export function Delete(value, pointer) {
    const indices = Indices(pointer);
    const last = indices.pop();
    if (Guard.IsUndefined(last))
        ThrowCannotSetRoot();
    const parent = Parent(value, indices, last);
    if (Guard.IsArray(parent) && /^(0|[1-9]\d*)$/.test(last)) {
        parent.splice(Number(last), 1);
    }
    else {
        delete parent[last];
    }
    return value;
}
