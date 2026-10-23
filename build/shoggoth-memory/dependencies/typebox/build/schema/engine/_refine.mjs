// deno-fmt-ignore-file
import * as Externals from './_externals.mjs';
import { EmitGuard as E, Guard as G } from '../../guard/index.mjs';
// ------------------------------------------------------------------
// Build
// ------------------------------------------------------------------
function BuildRefineMultiple(_stack, _context, schema, value) {
    const external = Externals.CreateVariable(schema['~refine']);
    return E.Every(external, E.Constant(0), ['refinement', '_'], E.Call(E.Member('refinement', 'check'), [value]));
}
function BuildRefineSingle(_stack, _context, schema, value) {
    const external = Externals.CreateVariable(schema['~refine'][0]);
    return E.Call(E.Member(external, 'check'), [value]);
}
export function BuildRefine(_stack, _context, schema, value) {
    return G.IsEqual(schema['~refine'].length, 1)
        ? BuildRefineSingle(_stack, _context, schema, value)
        : BuildRefineMultiple(_stack, _context, schema, value);
}
// ------------------------------------------------------------------
// Check
// ------------------------------------------------------------------
export function CheckRefine(_stack, _context, schema, value) {
    return G.Every(schema['~refine'], 0, (refinement, _) => refinement.check(value));
}
// ------------------------------------------------------------------
// Error
// ------------------------------------------------------------------
export function ErrorRefine(_stack, context, schemaPath, instancePath, schema, value) {
    return G.EveryAll(schema['~refine'], 0, (refinement, index) => {
        return refinement.check(value) ||
            context.AddError('~refine', schemaPath, instancePath, { index, message: refinement.error(value) });
    });
}
