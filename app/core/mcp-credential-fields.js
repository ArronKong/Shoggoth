"use strict";
// Public request cards use these names; SDK snake_case is accepted only as input.
function canonicalMcpCredentialField(value) {
  if (typeof value !== "string") return null;
  if (/^(?:env|header):[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(value)) return value;
  const match = value.match(/^oauthClient[.:](clientId|clientSecret|client_id|client_secret)$/u);
  return match ? `oauthClient:${match[1] === "client_id" ? "clientId" : match[1] === "client_secret" ? "clientSecret" : match[1]}` : null;
}
function publicOAuthClient(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return {};
  const result = {};
  for (const [name, alias] of [["clientId", "client_id"], ["clientSecret", "client_secret"], ["redirectUri", "redirectUri"]]) {
    const field = value[name] ?? value[alias]; if (typeof field === "string" && field.length) result[name] = field;
  }
  return result;
}
module.exports = { canonicalMcpCredentialField, publicOAuthClient };
