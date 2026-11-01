"use strict";
const { secretCapability, SECRET_MESSAGES, secretReferences, SECRET_METHODS: METHODS } = require("../core/chat-secret-contract");
const { textValue } = require("./secret-detector");
const { serviceError } = require("./security");
const fail = code => { throw serviceError(code, SECRET_MESSAGES[code]); };
class ChatSecretService {
  constructor({ secrets, execution, disclosures, getOwner }) { Object.assign(this, { secrets, execution, disclosures, getOwner }); }
  async owner(input) {
    if (![input.backendId, input.agentId, input.sessionKey].every(v => textValue(v, 1024) && v)) fail("SECRET_INPUT_INVALID");
    const owner = await this.getOwner(input);
    if (!owner || owner.backendId !== input.backendId || !textValue(owner.sessionKey, 1024) || !owner.sessionKey
      || !owner.profileId) fail("SECRET_REFERENCE_FORBIDDEN");
    return { profileId: owner.profileId, sessionId: owner.sessionKey };
  }
  async handle(method, input) {
    if (!METHODS.includes(method) || !input || Object.getPrototypeOf(input) !== Object.prototype) fail("SECRET_INPUT_INVALID");
    const extra = { "chat.secret.prepare": ["operationId", "text", "selections", "ordinary"], "chat.secret.revoke": ["reference"],
      "chat.secret.result": ["receiptId"], "chat.secret.decide": ["disclosureId", "choice"] }[method] || [];
    if (Object.keys(input).some(key => !["backendId", "agentId", "sessionKey", ...extra].includes(key))) fail("SECRET_INPUT_INVALID");
    const scope = await this.owner(input);
    if (method === "chat.secret.disclosures") return { items: this.disclosures?.list(scope) || [] };
    if (method === "chat.secret.decide") {
      if (!this.disclosures || !/^[a-f0-9]{64}$/u.test(input.disclosureId || "")
        || !["original", "retry", "cancel"].includes(input.choice)) fail("SECRET_INPUT_INVALID");
      return this.disclosures.decide(scope, input.disclosureId, input.choice);
    }
    if (method === "chat.secret.prepare") return this.secrets.prepare({ scope, operationId: input.operationId,
      text: input.text, selections: input.selections || [], ordinary: input.ordinary || [] });
    if (method === "chat.secret.list") return { items: this.secrets.list(scope) };
    if (method === "chat.secret.results") return { items: this.execution.list(scope) };
    if (method === "chat.secret.revoke") {
      if (typeof input.reference !== "string" || secretReferences(input.reference).length !== 1) fail("SECRET_REFERENCE_INVALID");
      return this.execution.revokeReference(scope, input.reference);
    }
    if (method === "chat.secret.result") {
      if (!/^[a-f0-9]{64}$/u.test(input.receiptId || "")) fail("SECRET_INPUT_INVALID");
      return this.execution.display(scope, input.receiptId);
    }
    return secretCapability({ input: this.secrets.opened, productTools: this.execution.opened,
      images: this.execution.media?.supportsImages?.() === true });
  }
}
module.exports = { ChatSecretService, METHODS };
