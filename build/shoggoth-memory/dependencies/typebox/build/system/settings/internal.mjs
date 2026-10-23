import { Get } from './settings.mjs';
// ------------------------------------------------------------------
// TempMaxErrors
// ------------------------------------------------------------------
let TempMaxErrors = 0;
// ------------------------------------------------------------------
// [Internal] EnableParseErrors
// ------------------------------------------------------------------
export function EnableParseErrors() {
    const settings = Get();
    TempMaxErrors = settings.maxErrors;
    settings.maxErrors = settings.maxParseErrors;
}
// ------------------------------------------------------------------
// [Internal] DisableParseErrors
// ------------------------------------------------------------------
export function DisableParseErrors() {
    const settings = Get();
    settings.maxErrors = TempMaxErrors;
}
