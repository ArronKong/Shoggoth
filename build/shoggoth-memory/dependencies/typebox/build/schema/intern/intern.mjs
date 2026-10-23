import { Arguments } from '../../system/arguments/index.mjs';
import { Hashing, Memory } from '../../system/index.mjs';
import * as Schema from '../types/index.mjs';
import * as Stack from '../engine/_stack.mjs';
import { Guard } from '../../guard/index.mjs';
import { Resolve } from '../resolve/index.mjs';
// ----------------------------------------------------------------
// UnresolvableRef
// ----------------------------------------------------------------
function UnresolvableRef(ref) {
    throw Error(`UnresolvableRef '${ref}'`);
}
// ----------------------------------------------------------------
// HashKey
// ----------------------------------------------------------------
function HashKey(schema) {
    return `x-${Hashing.Hash(schema)}`;
}
// ----------------------------------------------------------------
// AdditionalItems
// ----------------------------------------------------------------
function FromAdditionalItems(context, schema) {
    return FromSchema(context, schema.additionalItems);
}
// ----------------------------------------------------------------
// AdditionalProperties
// ----------------------------------------------------------------
function FromAdditionalProperties(context, schema) {
    return FromSchema(context, schema.additionalProperties);
}
// ----------------------------------------------------------------
// AllOf
// ----------------------------------------------------------------
function FromAllOf(context, schema) {
    return schema.allOf.map((inner) => FromSchema(context, inner));
}
// ----------------------------------------------------------------
// AnyOf
// ----------------------------------------------------------------
function FromAnyOf(context, schema) {
    return schema.anyOf.map((inner) => FromSchema(context, inner));
}
// ----------------------------------------------------------------
// Contains
// ----------------------------------------------------------------
function FromContains(context, schema) {
    return FromSchema(context, schema.contains);
}
// ----------------------------------------------------------------
// DependentSchemas
// ----------------------------------------------------------------
function FromDependentSchemas(context, schema) {
    return Guard.Keys(schema.dependentSchemas).reduce((result, key) => ({ ...result, [key]: FromSchema(context, schema.dependentSchemas[key]) }), {});
}
// ----------------------------------------------------------------
// Else
// ----------------------------------------------------------------
function FromElse(context, schema) {
    return FromSchema(context, schema.else);
}
// ----------------------------------------------------------------
// If
// ----------------------------------------------------------------
function FromIf(context, schema) {
    return FromSchema(context, schema.if);
}
// ----------------------------------------------------------------
// Items
// ----------------------------------------------------------------
function FromItems(context, schema) {
    return Schema.IsItemsSized(schema) ? FromItemsSized(context, schema) : FromItemsUnsized(context, schema);
}
// ----------------------------------------------------------------
// ItemsSized
// ----------------------------------------------------------------
function FromItemsSized(context, schema) {
    return schema.items.map((inner) => FromSchema(context, inner));
}
// ----------------------------------------------------------------
// ItemsUnsized
// ----------------------------------------------------------------
function FromItemsUnsized(context, schema) {
    return FromSchema(context, schema.items);
}
// ----------------------------------------------------------------
// Not
// ----------------------------------------------------------------
function FromNot(context, schema) {
    return FromSchema(context, schema.not);
}
// ----------------------------------------------------------------
// OneOf
// ----------------------------------------------------------------
function FromOneOf(context, schema) {
    return schema.oneOf.map((inner) => FromSchema(context, inner));
}
// ----------------------------------------------------------------
// PatternProperties
// ----------------------------------------------------------------
function FromPatternProperties(context, schema) {
    return Guard.Keys(schema.patternProperties).reduce((result, key) => ({ ...result, [key]: FromSchema(context, schema.patternProperties[key]) }), {});
}
// ----------------------------------------------------------------
// PrefixItems
// ----------------------------------------------------------------
function FromPrefixItems(context, schema) {
    return schema.prefixItems.map((inner) => FromSchema(context, inner));
}
// ----------------------------------------------------------------
// Properties
// ----------------------------------------------------------------
function FromProperties(context, schema) {
    return Guard.Keys(schema.properties).reduce((result, key) => ({ ...result, [key]: FromSchema(context, schema.properties[key]) }), {});
}
// ----------------------------------------------------------------
// PropertyNames
// ----------------------------------------------------------------
function FromPropertyNames(context, schema) {
    return FromSchema(context, schema.propertyNames);
}
// ----------------------------------------------------------------
// Ref
// ----------------------------------------------------------------
function ResolveRef(stack, ref) {
    const result = Resolve.Ref(stack, { $ref: ref });
    return { schema: result.schema ?? UnresolvableRef(ref), stack: result.stack };
}
// ----------------------------------------------------------------
// DynamicRef
// ----------------------------------------------------------------
function ResolveDynamicRef(stack, schema) {
    return Resolve.DynamicRef(stack, schema) ?? UnresolvableRef(schema.$dynamicRef);
}
// ----------------------------------------------------------------
// RecursiveRef
// ----------------------------------------------------------------
function ResolveRecursiveRef(stack, schema) {
    return Resolve.RecursiveRef(stack, schema) ?? UnresolvableRef(schema.$recursiveRef);
}
// ----------------------------------------------------------------
// FromResolvedRef (shared logic for Ref, DynamicRef, RecursiveRef)
// ----------------------------------------------------------------
function FromResolvedRef(context, target, nextStack) {
    const nextContext = { ...context, stack: nextStack };
    const resolving = context.resolving.get(target);
    if (Guard.IsUndefined(resolving))
        return FromSchema(nextContext, target);
    // Target is mid-intern, so this is a cycle (point at its reserved placeholder)
    resolving.used = true;
    return { $ref: `#/$defs/${resolving.key}` };
}
// ----------------------------------------------------------------
// FromRef
// ----------------------------------------------------------------
function FromRef(context, schema) {
    // Resolve target off the current traversal stack, carrying forward any resource crossing
    const { schema: target, stack } = ResolveRef(context.stack, schema.$ref);
    return FromResolvedRef(context, target, stack);
}
// ----------------------------------------------------------------
// FromDynamicRef
// ----------------------------------------------------------------
function FromDynamicRef(context, schema) {
    // Resolve target off the current traversal stack (dynamic scope depends on anchors seen so far)
    const target = ResolveDynamicRef(context.stack, schema);
    return FromResolvedRef(context, target, { ...context.stack, pendingResource: true });
}
// ----------------------------------------------------------------
// FromRecursiveRef
// ----------------------------------------------------------------
function FromRecursiveRef(context, schema) {
    // Resolve target off the current traversal stack (recursive scope depends on the path taken so far)
    const target = ResolveRecursiveRef(context.stack, schema);
    return FromResolvedRef(context, target, { ...context.stack, pendingResource: true });
}
// ----------------------------------------------------------------
// Then
// ----------------------------------------------------------------
function FromThen(context, schema) {
    return FromSchema(context, schema.then);
}
// ----------------------------------------------------------------
// UnevaluatedItems
// ----------------------------------------------------------------
function FromUnevaluatedItems(context, schema) {
    return FromSchema(context, schema.unevaluatedItems);
}
// ----------------------------------------------------------------
// UnevaluatedProperties
// ----------------------------------------------------------------
function FromUnevaluatedProperties(context, schema) {
    return FromSchema(context, schema.unevaluatedProperties);
}
// ----------------------------------------------------------------
// SchemaObject
// ----------------------------------------------------------------
function FromSchemaObject(context, schema) {
    // Reference-style schemas resolve to another node and cannot contain other keywords
    if (Schema.IsRef(schema))
        return FromRef(context, schema);
    if (Schema.IsDynamicRef(schema))
        return FromDynamicRef(context, schema);
    if (Schema.IsRecursiveRef(schema))
        return FromRecursiveRef(context, schema);
    // Check if the schema has already been resolved
    const existing = resolved.get(schema);
    if (!Guard.IsUndefined(existing))
        return existing;
    // Reserve a placeholder key in case a nested ref cycles back to this schema
    const reservation = { key: `x-ref-${context.resolving.size}`, used: false };
    context.resolving.set(schema, reservation);
    // Intern each subschema
    const remapped = {
        ...(Schema.IsRefine(schema) ? { ['~refine']: schema['~refine'] } : {}),
        ...(Schema.IsAdditionalItems(schema) ? { additionalItems: FromAdditionalItems(context, schema) } : {}),
        ...(Schema.IsAdditionalProperties(schema) ? { additionalProperties: FromAdditionalProperties(context, schema) } : {}),
        ...(Schema.IsAllOf(schema) ? { allOf: FromAllOf(context, schema) } : {}),
        ...(Schema.IsAnyOf(schema) ? { anyOf: FromAnyOf(context, schema) } : {}),
        ...(Schema.IsContains(schema) ? { contains: FromContains(context, schema) } : {}),
        ...(Schema.IsDependentSchemas(schema) ? { dependentSchemas: FromDependentSchemas(context, schema) } : {}),
        ...(Schema.IsElse(schema) ? { else: FromElse(context, schema) } : {}),
        ...(Schema.IsIf(schema) ? { if: FromIf(context, schema) } : {}),
        ...(Schema.IsItems(schema) ? { items: FromItems(context, schema) } : {}),
        ...(Schema.IsNot(schema) ? { not: FromNot(context, schema) } : {}),
        ...(Schema.IsOneOf(schema) ? { oneOf: FromOneOf(context, schema) } : {}),
        ...(Schema.IsPatternProperties(schema) ? { patternProperties: FromPatternProperties(context, schema) } : {}),
        ...(Schema.IsPrefixItems(schema) ? { prefixItems: FromPrefixItems(context, schema) } : {}),
        ...(Schema.IsProperties(schema) ? { properties: FromProperties(context, schema) } : {}),
        ...(Schema.IsPropertyNames(schema) ? { propertyNames: FromPropertyNames(context, schema) } : {}),
        ...(Schema.IsThen(schema) ? { then: FromThen(context, schema) } : {}),
        ...(Schema.IsUnevaluatedItems(schema) ? { unevaluatedItems: FromUnevaluatedItems(context, schema) } : {}),
        ...(Schema.IsUnevaluatedProperties(schema) ? { unevaluatedProperties: FromUnevaluatedProperties(context, schema) } : {})
    };
    context.resolving.delete(schema);
    // Discard resolution keywords and finalize the interned schema
    const interned = Memory.Discard(Memory.Assign(schema, remapped), ['$id', '$defs', '$anchor', '$dynamicAnchor', '$recursionAnchor']);
    const key = reservation.used ? reservation.key : HashKey(interned);
    registry.set(key, interned);
    // Result
    const result = { $ref: `#/$defs/${key}` };
    resolved.set(schema, result);
    return result;
}
// ----------------------------------------------------------------
// SchemaBoolean
// ----------------------------------------------------------------
function FromSchemaBoolean(_context, schema) {
    // Finalize and register the result
    const key = HashKey(schema);
    registry.set(key, schema);
    // Result
    const result = { $ref: `#/$defs/${key}` };
    resolved.set(schema, result);
    return result;
}
// ----------------------------------------------------------------
// Schema
// ----------------------------------------------------------------
function FromSchema(context, schema) {
    const next = { ...context, stack: Stack.NextStack(context.stack, schema) };
    return Schema.IsSchemaBoolean(schema) ? FromSchemaBoolean(next, schema) : FromSchemaObject(next, schema);
}
// ----------------------------------------------------------------
// BooleanEntry
// ----------------------------------------------------------------
function BooleanEntry(schema) {
    const key = HashKey(schema);
    return { $ref: `#/$defs/${key}`, $defs: { [key]: schema } };
}
// ----------------------------------------------------------------
// Module-level accumulator state
// ----------------------------------------------------------------
const registry = new Map();
const resolved = new Map();
/** (Experimental) This function restructures the schema such that each distinct sub-schema is stored exactly once in a $defs object and keyed by content hash. */
export function Intern(...args) {
    const [context, schema] = Arguments.Match(args, {
        2: (context, schema) => [context, schema],
        1: (schema) => [{}, schema]
    });
    registry.clear();
    resolved.clear();
    if (Schema.IsSchemaBoolean(schema))
        return BooleanEntry(schema);
    const defs = Schema.IsDefs(schema) ? schema.$defs : {};
    const rootStack = Stack.Stack({ ...context, ...defs }, schema);
    const { schema: entry, stack } = Schema.IsRef(schema) ? ResolveRef(Stack.NextStack(rootStack, schema), schema.$ref) : { schema, stack: rootStack };
    if (Schema.IsSchemaBoolean(entry))
        return BooleanEntry(entry);
    const ref_context = { stack, resolving: new Map() };
    const result = FromSchema(ref_context, entry);
    return { $ref: result.$ref, $defs: Object.fromEntries(registry) };
}
