"use strict";

// Presentation metadata belongs to a single call, never to the operation's
// arguments, permissions, confirmations or persistent product state.
const ACTIVITY_TITLE_KEY = "activityTitle";
const MAX_ACTIVITY_TITLE_LENGTH = 120;
const ACTIVITY_TITLE_SCHEMA = Object.freeze({
  type: "string", minLength: 1, maxLength: MAX_ACTIVITY_TITLE_LENGTH,
});
const NATIVE_ACTIVITY_INSTRUCTION = [
  "For tool-based work, send brief public progress in the user's language at the start, at major milestones, and when asking for a decision. Use public assistant text (commentary when supported), separate from the final answer.",
  "Keep routine operations, argument corrections, and repeated attempts in tool activity. Use activityTitle on each Shoggoth tool call and the runtime's own action title or description for native tools when supported. A parallel batch can have a distinct title for each concrete subject, source, page or search topic.",
  "Keep updates concise. Exclude secrets and hidden reasoning, use only supported tool arguments, and claim success after a verified result.",
].join(" ");

function withActivityTitle(definition) {
  return { ...definition, inputSchema: { ...definition.inputSchema,
    properties: { ...definition.inputSchema.properties, [ACTIVITY_TITLE_KEY]: ACTIVITY_TITLE_SCHEMA } } };
}

function splitActivityArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Object.hasOwn(value, ACTIVITY_TITLE_KEY)) return { valid: true, arguments: value };
  const descriptor = Object.getOwnPropertyDescriptor(value, ACTIVITY_TITLE_KEY);
  const title = descriptor?.value;
  if (typeof title !== "string" || !title.trim() || title.length > MAX_ACTIVITY_TITLE_LENGTH
    || !title.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(title)) return { valid: false };
  const args = Object.create(Object.getPrototypeOf(value));
  for (const key of Reflect.ownKeys(value)) {
    if (key !== ACTIVITY_TITLE_KEY) Object.defineProperty(args, key, Object.getOwnPropertyDescriptor(value, key));
  }
  return { valid: true, arguments: args, activityTitle: title.trim() };
}

module.exports = { ACTIVITY_TITLE_KEY, ACTIVITY_TITLE_SCHEMA, MAX_ACTIVITY_TITLE_LENGTH,
  NATIVE_ACTIVITY_INSTRUCTION, withActivityTitle, splitActivityArguments };
