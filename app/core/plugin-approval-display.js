"use strict";

// JSON.stringify leaves some invisible Unicode characters unescaped. Show
// those code units explicitly during approval without changing the original
// command or its digest, which remain the Service's execution authority.
function escapeInvisibleJsonCharacters(command) {
  if (typeof command !== "string") throw new TypeError("Approval command must be a string");
  return command.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, character =>
    Array.from({ length: character.length }, (_, index) =>
      `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`).join(""));
}

module.exports = { escapeInvisibleJsonCharacters };
