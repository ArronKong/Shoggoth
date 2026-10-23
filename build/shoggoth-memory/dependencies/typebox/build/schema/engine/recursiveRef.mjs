// deno-fmt-ignore-file
import * as Schema from '../types/index.mjs';
import * as Functions from './_functions.mjs';
import { Resolve } from '../resolve/index.mjs';
import { CheckSchema, ErrorSchema } from './schema.mjs';
// ------------------------------------------------------------------
// Build
// ------------------------------------------------------------------
export function BuildRecursiveRef(stack, context, schema, value) {
    const target = Resolve.RecursiveRef(stack, schema) ?? false;
    const nextStack = target ? { ...stack, pendingResource: true } : stack;
    return Functions.CreateFunction(nextStack, context, target, value);
}
// ------------------------------------------------------------------
// Check
// ------------------------------------------------------------------
export function CheckRecursiveRef(stack, context, schema, value) {
    const target = Resolve.RecursiveRef(stack, schema) ?? false;
    const nextStack = target ? { ...stack, pendingResource: true } : stack;
    return (Schema.IsSchema(target) && CheckSchema(nextStack, context, target, value));
}
// ------------------------------------------------------------------
// Error
// ------------------------------------------------------------------
export function ErrorRecursiveRef(stack, context, schemaPath, instancePath, schema, value) {
    const target = Resolve.RecursiveRef(stack, schema) ?? false;
    const nextStack = target ? { ...stack, pendingResource: true } : stack;
    return (Schema.IsSchema(target) && ErrorSchema(nextStack, context, schemaPath, instancePath, target, value));
}
