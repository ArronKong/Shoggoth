"use strict";
const Ajv = require("ajv");
const Ajv2019 = require("ajv/dist/2019");
const Ajv2020 = require("ajv/dist/2020");
const { fail, safeJson } = require("./hook-contract");
const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
const ajv2019 = new Ajv2019({ strict: false, allErrors: false, validateFormats: false });
const ajv2020 = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });
const validators = new WeakMap();
function validateHookToolArguments(schema, args) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) fail("HOOK_TOOL_CONTRACT_UNAVAILABLE");
  let validate = validators.get(schema);
  if (!validate) {
    try { safeJson(schema, 65536);
      const compiler = schema.$schema?.includes("2020-12") ? ajv2020 : schema.$schema?.includes("2019-09") ? ajv2019 : ajv;
      validate = compiler.compile(schema); validators.set(schema, validate); }
    catch { fail("HOOK_TOOL_CONTRACT_INVALID"); }
  }
  return validate(args) === true;
}
module.exports = { validateHookToolArguments };
