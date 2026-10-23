// deno-fmt-ignore-file
import * as Pathing from './_pathing.mjs';
import { Unique } from './_unique.mjs';
import { BuildSchema, CheckSchema, ErrorSchema } from './schema.mjs';
import { EmitGuard as E, Guard as G } from '../../guard/index.mjs';
// ------------------------------------------------------------------
// Build
// ------------------------------------------------------------------
export function BuildPropertyNames(stack, context, schema, value) {
    const [key, _index] = [Unique(), Unique()];
    return E.Every(E.Keys(value), E.Constant(0), [key, _index], BuildSchema(stack, context, schema.propertyNames, key));
}
// ------------------------------------------------------------------
// Check
// ------------------------------------------------------------------
export function CheckPropertyNames(stack, context, schema, value) {
    return G.Every(G.Keys(value), 0, (key, _index) => CheckSchema(stack, context, schema.propertyNames, key));
}
// ------------------------------------------------------------------
// Error
// ------------------------------------------------------------------
export function ErrorPropertyNames(stack, context, schemaPath, instancePath, schema, value) {
    const propertyNames = [];
    const isPropertyNames = G.EveryAll(G.Keys(value), 0, (key, _index) => {
        const nextInstancePath = `${instancePath}/${Pathing.EncodeFragment(key)}`;
        const nextSchemaPath = `${schemaPath}/propertyNames`;
        const isPropertyName = ErrorSchema(stack, context, nextSchemaPath, nextInstancePath, schema.propertyNames, key);
        if (!isPropertyName)
            propertyNames.push(key);
        return isPropertyName;
    });
    return isPropertyNames ||
        context.AddError('propertyNames', schemaPath, instancePath, { propertyNames });
}
