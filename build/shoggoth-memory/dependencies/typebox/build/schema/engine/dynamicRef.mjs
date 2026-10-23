// deno-fmt-ignore-file
import * as Schema from '../types/index.mjs';
import * as Functions from './_functions.mjs';
import { Resolve } from '../resolve/index.mjs';
import { CheckSchema, ErrorSchema } from './schema.mjs';
// ------------------------------------------------------------------
// Build
// ------------------------------------------------------------------
export function BuildDynamicRef(stack, context, schema, value) {
    const target = Resolve.DynamicRef(stack, schema) ?? false;
    const nextStack = target ? { ...stack, pendingResource: true } : stack;
    return Functions.CreateFunction(nextStack, context, target, value);
}
// ------------------------------------------------------------------
// Check
// ------------------------------------------------------------------
export function CheckDynamicRef(stack, context, schema, value) {
    const target = Resolve.DynamicRef(stack, schema) ?? false;
    const nextStack = target ? { ...stack, pendingResource: true } : stack;
    return (Schema.IsSchema(target) && CheckSchema(nextStack, context, target, value));
}
// ------------------------------------------------------------------
// Error
// ------------------------------------------------------------------
export function ErrorDynamicRef(stack, context, schemaPath, instancePath, schema, value) {
    const target = Resolve.DynamicRef(stack, schema) ?? false;
    const nextStack = target ? { ...stack, pendingResource: true } : stack;
    return (Schema.IsSchema(target) && ErrorSchema(nextStack, context, schemaPath, instancePath, target, value));
}
