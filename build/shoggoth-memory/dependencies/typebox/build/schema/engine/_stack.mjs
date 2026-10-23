import { Guard } from '../../guard/index.mjs';
import * as Schema from '../types/index.mjs';
// ------------------------------------------------------------------
// DefaultUri
// ------------------------------------------------------------------
export const DefaultUri = 'urn:typebox:root';
// ------------------------------------------------------------------
// NextUri
//
// Resolves a relative or absolute ref against a base URI or URN.
// Hierarchical bases (http, https, etc.) resolve using the normal
// URL rules. URN bases have no path to resolve against, so the ref
// is appended after the base's last ':' segment instead.
// ------------------------------------------------------------------
export function NextUri(ref, base) {
    return (URL.canParse(ref, base)) ? new URL(ref, base) : Guard.IsEqual(base, DefaultUri) ? new URL(`${base}:${ref}`) : new URL(`${base.slice(0, base.lastIndexOf(':'))}:${ref}`);
}
// ------------------------------------------------------------------
// Stack
//
// Creates the root frame a schema traversal starts from.
// ------------------------------------------------------------------
export function Stack(context, schema) {
    const base = Schema.IsSchemaObject(schema) && Schema.IsId(schema) ? NextUri(schema.$id, DefaultUri).href : DefaultUri;
    return {
        context,
        schema,
        lexicalSchema: schema,
        lexicalBase: base,
        resourceBase: base,
        referenceBase: base,
        ids: [],
        useResourceBaseForReference: true,
        recursiveAnchor: undefined,
        dynamicAnchors: [],
        resourceEntries: new Map(),
        pendingResource: true,
        enteredResource: false
    };
}
// ------------------------------------------------------------------
// RegisterResourceAnchors
//
// Collects $dynamicAnchor schemas reachable from a resource root,
// stopping at nested $id boundaries which own their own anchors.
// ------------------------------------------------------------------
function RegisterResourceAnchors(anchors, schema, isRoot = true) {
    if (Schema.IsSchemaBoolean(schema))
        return anchors;
    if (Array.isArray(schema))
        return schema.reduce((result, item) => RegisterResourceAnchors(result, item, false), anchors);
    if (!Schema.IsSchemaObject(schema))
        return anchors;
    if (!isRoot && Schema.IsId(schema))
        return anchors;
    const next = !isRoot && Schema.IsDynamicAnchor(schema) ? [...anchors, schema] : anchors;
    return Object.keys(schema).reduce((result, key) => RegisterResourceAnchors(result, schema[key], false), next);
}
// ------------------------------------------------------------------
// ResourceEntry
//
// A ref crossing (Resolve.Ref) may have marked `schema` as the entry
// point of a retrieved/legacy resource. If so the frame resets to
// that resource's base/root instead of chaining onto the parent.
// ------------------------------------------------------------------
function ResourceEntry(stack, schema) {
    return stack.resourceEntries.get(schema);
}
function NextEnteredResource(stack, schema) {
    return stack.enteredResource || ResourceEntry(stack, schema) !== undefined;
}
// ------------------------------------------------------------------
// NextStack
//
// Each Next* helper below computes one XStack field in isolation from
// the previous frame and the schema being pushed.
// ------------------------------------------------------------------
function IsRelativeId(schema) {
    return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(schema.$id);
}
function NextIds(stack, schema) {
    return Schema.IsId(schema) ? [...stack.ids, schema] : stack.ids;
}
function NextRecursiveAnchor(stack, schema) {
    return stack.recursiveAnchor ?? (Schema.IsRecursiveAnchorTrue(schema) ? schema : undefined);
}
function NextDynamicAnchors(stack, schema) {
    const registered = Schema.IsId(schema) ? RegisterResourceAnchors(stack.dynamicAnchors, schema) : stack.dynamicAnchors;
    return Schema.IsDynamicAnchor(schema) ? [...registered, schema] : registered;
}
function NextPendingResource(stack, schema) {
    return Schema.IsId(schema) ? false : stack.pendingResource;
}
function NextLexicalBase(stack, schema) {
    const entry = ResourceEntry(stack, schema);
    if (entry)
        return entry.base;
    return Schema.IsId(schema) ? NextUri(schema.$id, stack.lexicalBase).href : stack.lexicalBase;
}
function NextResourceBase(stack, schema) {
    const entry = ResourceEntry(stack, schema);
    if (entry)
        return entry.base;
    return (Schema.IsId(schema) && stack.pendingResource) ? NextUri(schema.$id, stack.resourceBase).href : stack.resourceBase;
}
function NextUseResourceBaseForReference(stack, schema) {
    return Schema.IsId(schema) ? !IsRelativeId(schema) : stack.useResourceBaseForReference;
}
function NextReferenceBase(stack, schema) {
    const isRetrieved = NextEnteredResource(stack, schema);
    const useResourceBaseForReference = NextUseResourceBaseForReference(stack, schema);
    return (isRetrieved || useResourceBaseForReference) ? NextResourceBase(stack, schema) : NextLexicalBase(stack, schema);
}
function NextLexicalSchema(stack, schema) {
    const entry = ResourceEntry(stack, schema);
    if (entry)
        return entry.root;
    return Schema.IsId(schema) ? schema : stack.lexicalSchema;
}
// ------------------------------------------------------------------
// NextStack | HasStackKeywords (Optimization)
//
// HasStackKeywords narrows schema to an object and checks whether it
// carries $id, $dynamicAnchor, a first-seen $recursiveAnchor, or a
// resource-entry point. When none apply, NextStack skips the frame
// rebuild and returns the parent stack as-is.
// ------------------------------------------------------------------
function HasStackKeywords(stack, schema) {
    return Schema.IsSchemaObject(schema) && (Schema.IsId(schema) ||
        Schema.IsDynamicAnchor(schema) ||
        (Guard.IsUndefined(stack.recursiveAnchor) && Schema.IsRecursiveAnchorTrue(schema)) ||
        !Guard.IsUndefined(ResourceEntry(stack, schema)));
}
export function NextStack(stack, schema) {
    return HasStackKeywords(stack, schema)
        ? {
            ...stack,
            ids: NextIds(stack, schema),
            dynamicAnchors: NextDynamicAnchors(stack, schema),
            recursiveAnchor: NextRecursiveAnchor(stack, schema),
            pendingResource: NextPendingResource(stack, schema),
            lexicalBase: NextLexicalBase(stack, schema),
            resourceBase: NextResourceBase(stack, schema),
            useResourceBaseForReference: NextUseResourceBaseForReference(stack, schema),
            referenceBase: NextReferenceBase(stack, schema),
            lexicalSchema: NextLexicalSchema(stack, schema),
            enteredResource: NextEnteredResource(stack, schema)
        }
        : stack;
}
