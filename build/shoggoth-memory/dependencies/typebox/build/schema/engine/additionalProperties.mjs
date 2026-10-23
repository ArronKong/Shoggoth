// deno-fmt-ignore-file
import * as Schema from '../types/index.mjs';
import * as Externals from './_externals.mjs';
import * as Pathing from './_pathing.mjs';
import { Unique } from './_unique.mjs';
import { UnicodeRegExp } from './_regexp.mjs';
import { EmitGuard as E, Guard as G } from '../../guard/index.mjs';
import { BuildSchemaPushStack, CheckSchemaPushStack, ErrorSchemaPushStack } from './schema.mjs';
// ------------------------------------------------------------------
// Optimization: IsAdditionalPropertiesIgnored
//
// We can ignore additionalProperties if the schema is true-like and
// we are not in an unevaluated context, noting that additional
// properties are considered tracked, evaluated keys.
// ------------------------------------------------------------------
function IsAdditionalPropertiesIgnored(context, additionalProperties) {
    return !context.UseUnevaluated() &&
        (G.IsEqual(additionalProperties, true) ||
            (G.IsObject(additionalProperties) && G.IsEqual(G.Keys(additionalProperties).length, 0)));
}
// ------------------------------------------------------------------
// Optimization: GetPropertiesPattern
//
// Constructs a regular expression that matches all property keys
// and pattern properties defined in a schema. This approach unifies
// handling of both property types, avoiding separate logic paths.
//
// If no keys or patterns are present, it returns a pattern that
// matches nothing: '(?!)'.
//
// ------------------------------------------------------------------
function GetPropertyKeyAsPattern(key) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `^${escaped}$`;
}
function GetPropertiesPattern(schema) {
    const patterns = [];
    if (Schema.IsPatternProperties(schema))
        patterns.push(...G.Keys(schema.patternProperties));
    if (Schema.IsProperties(schema))
        patterns.push(...G.Keys(schema.properties).map(GetPropertyKeyAsPattern));
    return G.IsEqual(patterns.length, 0) ? '(?!)' : `(${patterns.join('|')})`;
}
// ------------------------------------------------------------------
// BuildAdditionalPropertiesFast
//
// Optimized logic for schemas with `additionalProperties: false`.
//
// This fast-path applies only when:
// - `additionalProperties` is explicitly set to false,
// - the schema uses only `properties` (no `patternProperties`),
// - and all defined properties are required (i.e., no optional keys).
//
// This constraint is common when enforcing strict object shapes
// with only known, fixed keys. When all these conditions are met,
// we can generate a simplified and efficient runtime check.
//
// ------------------------------------------------------------------
export function CanAdditionalPropertiesFast(_context, schema, _value) {
    return Schema.IsRequired(schema)
        && Schema.IsProperties(schema)
        && !Schema.IsPatternProperties(schema)
        && G.IsEqual(schema.additionalProperties, false)
        && G.IsEqual(G.Keys(schema.properties).length, schema.required.length);
}
export function BuildAdditionalPropertiesFast(_context, schema, value) {
    return E.IsEqual(E.Member(E.Call(E.Member('Object', 'getOwnPropertyNames'), [value]), 'length'), E.Constant(schema.required.length));
}
// ------------------------------------------------------------------
// BuildAdditionalPropertiesStandard
// ------------------------------------------------------------------
export function BuildAdditionalPropertiesStandard(stack, context, schema, value) {
    const [key, _index] = [Unique(), Unique()];
    const regexp = Externals.CreateVariable(UnicodeRegExp(GetPropertiesPattern(schema)));
    const isSchema = BuildSchemaPushStack(stack, context, schema.additionalProperties, `${value}[${key}]`);
    const isKey = E.Call(E.Member(regexp, 'test'), [key]);
    const addKey = context.AddKey(key);
    const guarded = context.UseUnevaluated() ? E.Or(isKey, E.And(isSchema, addKey)) : E.Or(isKey, isSchema);
    const result = E.Every(E.Keys(value), E.Constant(0), [key, _index], guarded);
    return result;
}
// ------------------------------------------------------------------
// Build
// ------------------------------------------------------------------
export function BuildAdditionalProperties(stack, context, schema, value) {
    if (IsAdditionalPropertiesIgnored(context, schema.additionalProperties))
        return E.Constant(true);
    return CanAdditionalPropertiesFast(context, schema, value)
        ? BuildAdditionalPropertiesFast(context, schema, value)
        : BuildAdditionalPropertiesStandard(stack, context, schema, value);
}
// ------------------------------------------------------------------
// Check
// ------------------------------------------------------------------
export function CheckAdditionalProperties(stack, context, schema, value) {
    const regexp = UnicodeRegExp(GetPropertiesPattern(schema));
    const isAdditionalProperties = G.Every(G.Keys(value), 0, (key, _index) => {
        return regexp.test(key) ||
            (CheckSchemaPushStack(stack, context, schema.additionalProperties, value[key]) && context.AddKey(key));
    });
    return isAdditionalProperties;
}
// ------------------------------------------------------------------
// Error
// ------------------------------------------------------------------
export function ErrorAdditionalProperties(stack, context, schemaPath, instancePath, schema, value) {
    const regexp = UnicodeRegExp(GetPropertiesPattern(schema));
    const additionalProperties = [];
    const isAdditionalProperties = G.EveryAll(G.Keys(value), 0, (key, _index) => {
        const nextSchemaPath = `${schemaPath}/additionalProperties`;
        const nextInstancePath = `${instancePath}/${Pathing.EncodeFragment(key)}`;
        const isAdditionalProperty = regexp.test(key) ||
            (ErrorSchemaPushStack(stack, context, nextSchemaPath, nextInstancePath, schema.additionalProperties, value[key]) && context.AddKey(key));
        if (!isAdditionalProperty)
            additionalProperties.push(key);
        return isAdditionalProperty;
    });
    return isAdditionalProperties ||
        context.AddError('additionalProperties', schemaPath, instancePath, { additionalProperties });
}
