"use strict";
const { secretReferences, SECRET_MESSAGES } = require("../core/chat-secret-contract");
const { serviceError } = require("./security");
const fail = () => { throw serviceError("SECRET_TOOL_NOT_SUPPORTED", SECRET_MESSAGES.SECRET_TOOL_NOT_SUPPORTED); };
const contains = value => secretReferences(JSON.stringify(value)).length > 0;
function browserArguments(name, input, resolve) {
  const result = structuredClone(input);
  const replace = (object, key) => {
    if (typeof object?.[key] === "string") object[key] = resolve(object[key]);
  };
  // These are tool value slots, not a website or HTML field allowlist. The
  // existing driver remains responsible for the actual current target.
  const skeleton = structuredClone(input);
  if (name === "browser_type") { replace(result, "text"); delete skeleton.text; }
  else if (name === "browser_fill_form" && Array.isArray(result.fields)) {
    result.fields.forEach((field, index) => { replace(field, "value"); delete skeleton.fields[index].value; });
  } else if (name === "browser_handle_dialog") { replace(result, "promptText"); delete skeleton.promptText; }
  if (contains(skeleton)) fail();
  return result;
}
function secretEnvironment(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length > 32) return false;
  return Object.entries(value).every(([key, ref]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key)
    && !/^(?:LD_|DYLD_|NODE_|ELECTRON_|PYTHON|RUBY|PERL|BASH|ZDOT|ENV$|PATH$|HOME$|SHELL$|IFS$|TMP|LANG$|LC_|TZ$)/u.test(key)
    && typeof ref === "string" && secretReferences(ref).length === 1 && secretReferences(ref)[0].reference === ref);
}
module.exports = { browserArguments, contains, secretEnvironment };
