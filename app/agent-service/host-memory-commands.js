"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { hasSecret } = require("./memory-engine");
const { isUiActionSubmission } = require("./ui-input-provenance");
const { isBorrowedMemoryDerived, isReferentialMemoryRequest } = require("./shoggoth-memory/borrowed-memory-provenance.cjs");
const { memoryOperationId } = require("./conversation-memory-service");
const NAMESPACE = "host-memory-commands-v1";
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalized = value => value.normalize("NFKC").trim().replace(/\s+/gu, " ");
const fail = (code, text) => { throw serviceError(code, text); };
const quote = String.raw`(?:"([^"\n]+)"|“([^”\n]+)”|「([^」\n]+)」)`;
const textOf = match => match.slice(1).find(value => value !== undefined);

// Deliberately bounded grammar. A quote, question, document or model output
// cannot become write authority. Unclear targets produce a local clarification.
function parseHostMemoryCommand(text) {
  if (typeof text !== "string" || text.length > 10_000 || /[\r\n\0]/u.test(text)) return null;
  const value = text.trim();
  let match = /^(?:(?:请)?(?:记住|记下|保存记忆)\s*[：:]\s*|(?:please\s+)?remember\s*:\s*|\/memory\s+(?:save|remember)\s+)(.+)$/iu.exec(value);
  if (match) return { action: "save", content: match[1].trim(), language: /[\u3400-\u9fff]/u.test(value) ? "zh" : "en" };
  match = new RegExp(String.raw`^(?:(?:请)?(?:更正|修改)记忆\s*[：:]?\s*|(?:please\s+)?correct memory\s*:\s*|/memory\s+correct\s+)${quote}\s*(?:为|改为|to|=>)\s*${quote}[。.!！]?$`, "iu").exec(value);
  if (match) return { action: "correct", target: textOf(match.slice(0, 4)), content: match.slice(4).find(value => value !== undefined), language: /[\u3400-\u9fff]/u.test(value) ? "zh" : "en" };
  match = /^(?:(?:请)?(?:忘记|遗忘|删除记忆)\s*[：:]\s*|(?:please\s+)?forget\s*:\s*|\/memory\s+forget\s+)(.*)$/iu.exec(value);
  if (match) {
    const target = new RegExp(String.raw`^${quote}[。.!！]?$`, "u").exec(match[1].trim());
    return { action: "forget", target: target ? textOf(target) : /^id:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(match[1].trim()) ? match[1].trim() : null,
      language: /[\u3400-\u9fff]/u.test(value) ? "zh" : "en" };
  }
  if (/^(?:\/memory\b|(?:请)?(?:更正|修改)记忆\s*[：:]|(?:please\s+)?correct memory\s*:)/iu.test(value)) return { action: "help", language: /[\u3400-\u9fff]/u.test(value) ? "zh" : "en" };
  return null;
}
function help(language) {
  return language === "zh" ? '请提供完整的记忆内容：记住：内容；更正记忆：“原内容”为“新内容”；忘记：“完整内容”。更正和遗忘只匹配当前助理的一条可见记忆。'
    : 'Use Remember: content; Correct memory: "old content" to "new content"; Forget: "complete content". Corrections and forgetting require one exact visible memory owned by this Agent.';
}

class HostMemoryCommands {
  constructor({ memory, conversation }) { this.memory = memory; this.conversation = conversation; }
  recognizes(run, command) {
    return !!command && run?.source === "chat" && !command.attachments?.length
      && !/^(?:federation-(?:send|message)-|ui-operation-)/u.test(command.operationId)
      && !!parseHostMemoryCommand(command.prompt);
  }
  key(run, command) { return hash([run.profileId, run.id, command.operationId]); }
  fingerprint(run, command) { return hash([run.id, run.profileId, run.sourceId, run.workspace, command.operationId, command.prompt]); }
  read(run, command) {
    this.memory.database.assertOpen();
    const row = this.memory.database.db.prepare("SELECT value FROM memory_state WHERE namespace=? AND key=?")
      .get(NAMESPACE, this.key(run, command));
    if (!row?.value) return null;
    let receipt; try { receipt = JSON.parse(row.value); } catch { fail("MEMORY_COMMAND_STATE_INVALID", "记忆操作记录不可读取"); }
    if (receipt.version !== 1 || receipt.fingerprint !== this.fingerprint(run, command)
      || !["prepared", "done"].includes(receipt.phase) || !receipt.source
      || typeof receipt.text !== "string" || !["save", "correct", "forget", "help"].includes(receipt.action)) {
      fail("MEMORY_COMMAND_STATE_INVALID", "记忆操作记录与当前请求不匹配");
    }
    return receipt;
  }
  enrolled(run, command) {
    return this.recognizes(run, command) && !run.runtimeSessionRef && !run.runtimeTurnRef && !run.runtimeAttemptRef
      && this.read(run, command) !== null;
  }
  scope(run, command, parentCheck) {
    const memory = this.memory, session = memory.chatSessionStore.getSession(run.sourceId);
    if (!session || session.profileId !== run.profileId || session.workspace !== run.workspace) fail("CONVERSATION_SOURCE_INVALID", "记忆操作的会话归属不可用");
    const check = () => {
      parentCheck(); memory.assertProfile(run.profileId);
      const current = memory.chatSessionStore.getSession(run.sourceId);
      if (!current || current.id !== session.id || current.profileId !== run.profileId || current.workspace !== run.workspace
        || !["draft", "binding", "ready"].includes(current.status)
        || memory.chatSessionStore.getCronSessionOrigin?.(run.sourceId)) fail("CONVERSATION_SOURCE_INVALID", "记忆操作的会话已变化");
      const source = memory.transcriptStore.listEvents(run.profileId, session.id)
        .find(event => event.kind === "user" && event.runId === run.id && event.content?.operationId === command.operationId);
      if (!source || source.contextExcluded || source.content?.text !== command.prompt
        || isUiActionSubmission(source) || isBorrowedMemoryDerived(source)) fail("CONVERSATION_SOURCE_INVALID", "记忆操作必须来自当前用户原话");
      return source;
    };
    const source = check();
    return { check, source: { id: source.id, hash: hash(source.content.text), sessionId: session.id },
      store: memory.database.openKeyedStore({ namespace: NAMESPACE, maxEntries: 100_000, overflowPolicy: "reject-new" }, check) };
  }
  async prepare(run, command, parentCheck) {
    if (!this.recognizes(run, command)) return false;
    const scope = this.scope(run, command, parentCheck), prior = this.read(run, command);
    if (prior) { if (hash(prior.source) !== hash(scope.source)) fail("CONVERSATION_SOURCE_INVALID", "记忆操作原话已变化"); return true; }
    const intent = parseHostMemoryCommand(command.prompt), zh = intent.language === "zh";
    const receipt = { version: 1, fingerprint: this.fingerprint(run, command), source: scope.source,
      phase: "prepared", action: intent.action, args: null, text: help(intent.language) };
    if (hasSecret(command.prompt) || /\{\{SHOGGOTH_SECRET_/u.test(command.prompt)) {
      receipt.text = zh ? "这条内容包含凭据或凭据引用，未保存到记忆。" : "This contains credentials or credential references and was not saved to memory.";
    } else if (intent.action === "save" && isReferentialMemoryRequest(command.prompt)) {
      receipt.text = zh ? "请重新写出要保存的完整事实；不能把“上面那条”等引用直接保存为你的记忆。" : "Please restate the complete fact in your own words; a reference to previous content cannot be saved as your memory.";
    } else if (intent.action === "save" && intent.content && Buffer.byteLength(intent.content) <= 8192) {
      receipt.args = { content: intent.content, scope: "user", classification: "explicit", sourceQuote: command.prompt,
        expectedRevision: this.memory.store.getRevision(run.profileId) };
      receipt.text = zh ? "已根据你的原话保存这条记忆。" : "Saved this memory from your own words.";
    } else if (["correct", "forget"].includes(intent.action) && intent.target
      && (intent.action !== "correct" || intent.content?.trim() && Buffer.byteLength(intent.content) <= 8192)) {
      const targets = this.memory.store.list(run.profileId, { status: "active" }).filter(item =>
        this.memory.visible(item, { workspace: run.workspace, maxSensitivity: "private" })
        && (intent.target.startsWith("id:") ? item.id === intent.target.slice(3) : normalized(item.content) === normalized(intent.target)));
      if (targets.length === 1) {
        const item = targets[0];
        receipt.args = { expectedRevision: this.memory.store.getRevision(run.profileId), sourceQuote: command.prompt,
          ...(intent.action === "forget" ? { id: item.id } : { content: intent.content, scope: item.scope, classification: "explicit", supersedes: item.id,
            sensitivity: item.sensitivity, validFrom: item.validFrom, validUntil: item.validUntil }) };
        receipt.text = intent.action === "forget" ? zh ? "已遗忘这条记忆及其更正历史，后续召回会排除这些来源。" : "Forgot this memory and its correction history; future recall excludes those sources."
          : zh ? "已按你的原话更正记忆，旧内容已被替代。" : "Corrected the memory from your words and superseded its previous content.";
      } else receipt.text = (zh ? targets.length ? "找到多条相同内容，未作更改。" : "没有找到当前助理可见的完整匹配记忆，未作更改。"
        : targets.length ? "Multiple matching memories were found; nothing changed." : "No exact visible memory was found for this Agent; nothing changed.") + " " + help(intent.language);
    }
    scope.check();
    await scope.store.registerIfAbsent(this.key(run, command), receipt);
    scope.check();
    return true;
  }
  async execute(run, command, parentCheck) {
    const scope = this.scope(run, command, parentCheck), receipt = this.read(run, command);
    if (!receipt || hash(receipt.source) !== hash(scope.source)) fail("MEMORY_COMMAND_STATE_INVALID", "记忆操作没有已核实的来源记录");
    if (receipt.phase === "done") return { text: receipt.text };
    let text = receipt.text;
    if (receipt.args) {
      const name = receipt.action === "forget" ? "memory_forget" : "memory_save";
      const binding = this.conversation.bind(name, receipt.args, run);
      const result = await this.conversation.write(name, run.profileId, receipt.args,
        { operationId: `host-${command.operationId}`, binding, assertCurrent: scope.check });
      scope.check();
      if (name === "memory_save" && !result.saved) text = /[\u3400-\u9fff]/u.test(command.prompt)
        ? "该操作已有记录，但对应记忆已撤回或尚未确认，没有重新保存。"
        : "This operation already exists, but its memory is withdrawn or unconfirmed; it was not saved again.";
      if (name === "memory_save" && result.item?.id !== memoryOperationId(run.profileId, `host-${command.operationId}`)
        && result.saved !== true) fail("MEMORY_COMMAND_STATE_INVALID", "记忆操作结果不可确认");
    }
    await scope.store.register(this.key(run, command), { ...receipt, phase: "done", text });
    scope.check();
    return { text };
  }
}

module.exports = { HostMemoryCommands, parseHostMemoryCommand };
