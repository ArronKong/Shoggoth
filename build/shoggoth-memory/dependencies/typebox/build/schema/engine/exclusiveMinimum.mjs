// deno-fmt-ignore-file
import { Guard as G, EmitGuard as E } from '../../guard/index.mjs';
// ------------------------------------------------------------------
// Build
// ------------------------------------------------------------------
export function BuildExclusiveMinimum(_stack, _context, schema, value) {
    return E.IsGreaterThan(value, E.Constant(schema.exclusiveMinimum));
}
// ------------------------------------------------------------------
// Check
// ------------------------------------------------------------------
export function CheckExclusiveMinimum(_stack, _context, schema, value) {
    return G.IsGreaterThan(value, schema.exclusiveMinimum);
}
// ------------------------------------------------------------------
// Error
// ------------------------------------------------------------------
export function ErrorExclusiveMinimum(stack, context, schemaPath, instancePath, schema, value) {
    return CheckExclusiveMinimum(stack, context, schema, value) ||
        context.AddError('exclusiveMinimum', schemaPath, instancePath, { comparison: '>', limit: schema.exclusiveMinimum });
}
