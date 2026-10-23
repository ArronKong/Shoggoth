// deno-fmt-ignore-file
import * as Functions from './_functions.mjs';
import * as Schema from '../types/index.mjs';
import { Resolve } from '../resolve/index.mjs';
import { CheckContext, ErrorContext } from './_context.mjs';
import { EmitGuard as E } from '../../guard/index.mjs';
import { CheckSchema, ErrorSchema } from './schema.mjs';
// ------------------------------------------------------------------
// BuildRef
// ------------------------------------------------------------------
function BuildRefStandard(stack, context, target, value) {
    const interior = E.ArrowFunction(['context', 'value'], Functions.CreateFunction(stack, context, target, 'value'));
    const exterior = E.ArrowFunction(['context', 'value'], E.Statements([
        E.ConstDeclaration('nextContext', E.New('CheckContext', [])),
        E.ConstDeclaration('result', E.Call(interior, ['nextContext', 'value'])),
        E.If('result', context.Merge('[nextContext]')),
        E.Return('result')
    ]));
    return E.Call(exterior, ['context', value]);
}
function BuildRefFast(stack, context, target, value) {
    return Functions.CreateFunction(stack, context, target, value);
}
export function BuildRef(stack, context, schema, value) {
    const result = Resolve.Ref(stack, schema);
    const target = result.schema ?? false;
    return context.UseUnevaluated()
        ? BuildRefStandard(result.stack, context, target, value)
        : BuildRefFast(result.stack, context, target, value);
}
// ------------------------------------------------------------------
// Check
// ------------------------------------------------------------------
export function CheckRef(stack, context, schema, value) {
    const result = Resolve.Ref(stack, schema);
    const target = result.schema ?? false;
    const nextContext = new CheckContext();
    const valid = (Schema.IsSchema(target) && CheckSchema(result.stack, nextContext, target, value));
    if (valid)
        context.Merge([nextContext]);
    return valid;
}
// ------------------------------------------------------------------
// Error
// ------------------------------------------------------------------
export function ErrorRef(stack, context, schemaPath, instancePath, schema, value) {
    const result = Resolve.Ref(stack, schema);
    const target = result.schema ?? false;
    const nextContext = new ErrorContext();
    const valid = (Schema.IsSchema(target) && ErrorSchema(result.stack, nextContext, schemaPath, instancePath, target, value));
    if (valid)
        context.Merge([nextContext]);
    if (!valid)
        context.AddErrors(nextContext.GetErrors());
    return valid;
}
