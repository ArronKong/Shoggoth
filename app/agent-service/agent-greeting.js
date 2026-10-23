"use strict";

// First message in a new Agent's default conversation. It is fixed text, not a
// model call, and enters the next turn's context like any assistant reply.
const GREETINGS = Object.freeze({
  "zh-CN": Object.freeze({
    builtin: (name) => `你好，我是 ${name}，你的内置 AI 助理。写代码、查资料、整理文件，或者管理定时任务和看板，都可以交给我。想从哪里开始？`,
    assistant: (name) => `你好，我是 ${name}，你的 AI 助理。写代码、查资料、整理文件，或者管理定时任务和看板，都可以交给我。想从哪里开始？`,
    runtime: (name, runtime) => `你好，我是 ${name}，由你本机的 ${runtime} 驱动。想让我帮你做什么？需要时也可以在下方模型菜单里切换到其他已连接的 CLI。`,
  }),
  en: Object.freeze({
    builtin: (name) => `Hi, I'm ${name}, your built-in AI assistant. I can write code, look things up, organize files, or manage scheduled tasks and boards for you. Where would you like to start?`,
    assistant: (name) => `Hi, I'm ${name}, your AI assistant. I can write code, look things up, organize files, or manage scheduled tasks and boards for you. Where would you like to start?`,
    runtime: (name, runtime) => `Hi, I'm ${name}, powered by ${runtime} on this Mac. What can I help you with? You can also switch to another connected CLI from the model menu below.`,
  }),
});
const GREETING_LOCALES = Object.freeze(Object.keys(GREETINGS));

// An Agent on a local CLI names it; on the built-in harness only the default
// Agent calls itself built-in.
function agentGreeting({ locale, name, runtimeName, isDefault = false }) {
  const copy = GREETINGS[locale] || GREETINGS.en;
  if (runtimeName) return copy.runtime(name, runtimeName);
  return isDefault ? copy.builtin(name) : copy.assistant(name);
}

module.exports = { GREETING_LOCALES, agentGreeting };
