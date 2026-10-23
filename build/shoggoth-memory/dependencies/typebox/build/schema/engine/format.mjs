// deno-fmt-ignore-file
import * as Externals from './_externals.mjs';
import { Format } from '../../format/index.mjs';
import { EmitGuard as E } from '../../guard/index.mjs';
// ------------------------------------------------------------------
// Build (Remote)
// ------------------------------------------------------------------
// export function BuildFormat(_stack: Stack.XStack, _context: BuildContext, schema: Schema.XFormat, value: string): string {
//   return E.Call(E.Member('Format', 'Test'), [E.Constant(schema.format), value])
// }
// ------------------------------------------------------------------
// Build (Inline)
// ------------------------------------------------------------------
export function BuildFormat(_stack, _context, schema, value) {
    return Format.Has(schema.format) ? E.Call(Externals.CreateVariable(Format.Get(schema.format)), [value]) : E.Constant(true);
}
// ------------------------------------------------------------------
// Check
// ------------------------------------------------------------------
export function CheckFormat(_stack, _context, schema, value) {
    return Format.Test(schema.format, value);
}
// ------------------------------------------------------------------
// Error
// ------------------------------------------------------------------
export function ErrorFormat(stack, context, schemaPath, instancePath, schema, value) {
    return CheckFormat(stack, context, schema, value) ||
        context.AddError('format', schemaPath, instancePath, { format: schema.format });
}
