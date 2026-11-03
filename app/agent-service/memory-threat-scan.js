"use strict";

// Prompt-injection and exfiltration patterns for memory the Agent writes on
// its own. Ported from Hermes tools/threat_patterns.py ("strict" scope), since
// saved memory enters every later system prompt. Dropped: Hermes-only paths,
// hardcoded secrets (hasSecret covers them) and the C2 heartbeat/task-pull
// words, which name ordinary Shoggoth features (Heartbeat, Kanban tasks).
// Added: Chinese forms of the three classic injections, for Chinese content.

const MAX_SCAN_CHARS = 65_536;
const W = "[\\p{L}\\p{N}_]";
const FILLER = `(?:${W}+\\s+){0,8}`;
const SECRET_VAR = "\\$\\{?[\\p{L}\\p{N}_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\\b";
const MODIFY = "(update|modify|edit|write|change|append|add\\s+to)\\s+[^\\n]{0,2048}";

const PATTERNS = [
  [`ignore\\s+${FILLER}(previous|all|above|prior)\\s+${FILLER}instructions`, "prompt_injection"],
  ["system\\s+prompt\\s+override", "sys_prompt_override"],
  [`disregard\\s+${FILLER}(your|all|any)\\s+${FILLER}(instructions|rules|guidelines)`, "disregard_rules"],
  [`act\\s+as\\s+(if|though)\\s+${FILLER}you\\s+${FILLER}(have\\s+no|don't\\s+have)\\s+${FILLER}(restrictions|limits|rules)`, "bypass_restrictions"],
  ["<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->", "html_comment_injection"],
  ["<\\s*div\\s+style\\s*=\\s*[\"'][^>]{0,2048}display\\s*:\\s*none", "hidden_div"],
  [`translate\\s+[^\\n]{0,512}\\s+into\\s+${W}+(?:[\\s-]+${W}+){0,2}\\s+and\\s+(execute|run|eval)\\b`, "translate_execute"],
  [`do\\s+not\\s+${FILLER}tell\\s+${FILLER}the\\s+user`, "deception_hide"],
  [`you\\s+are\\s+${FILLER}now\\s+(?:a|an|the)\\s+`, "role_hijack"],
  [`pretend\\s+${FILLER}(you\\s+are|to\\s+be)\\s+`, "role_pretend"],
  [`output\\s+${FILLER}(system|initial)\\s+prompt`, "leak_system_prompt"],
  [`(respond|answer|reply)\\s+without\\s+${FILLER}(restrictions|limitations|filters|safety)`, "remove_filters"],
  [`you\\s+have\\s+been\\s+${FILLER}(updated|upgraded|patched)\\s+to`, "fake_update"],
  [`\\bname\\s+yourself\\s+${W}+`, "identity_override"],
  ["register\\s+(as\\s+)?a?\\s*node", "c2_node_registration"],
  ["connect\\s+to\\s+the\\s+network\\b", "c2_network_connect"],
  [`you\\s+must\\s+(?:${W}+\\s+){0,3}(register|connect|report|beacon)\\b`, "forced_action"],
  ["only\\s+use\\s+one[\\s-]?liners?\\b", "anti_forensic_oneliner"],
  [`never\\s+${FILLER}(?:create|write)\\s+${FILLER}(?:script|file)\\s+${FILLER}disk`, "anti_forensic_disk"],
  [`unset\\s+${W}*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC|SHOGGOTH)${W}*`, "env_var_unset_agent"],
  ["\\b(?:cobalt\\s*strike|sliver|havoc|mythic|metasploit|brainworm)\\b", "known_c2_framework"],
  ["\\bc2\\s+(?:server|channel|infrastructure|beacon)\\b", "c2_explicit"],
  ["\\bcommand\\s+and\\s+control\\b", "c2_explicit_long"],
  [`curl\\s+[^\\n]{0,2048}${SECRET_VAR}`, "exfil_curl"],
  [`wget\\s+[^\\n]{0,2048}${SECRET_VAR}`, "exfil_wget"],
  ["cat\\s+[^\\n]{0,2048}(\\.env|credentials|\\.netrc|\\.pgpass|\\.npmrc|\\.pypirc)", "read_secrets"],
  ["(send|post|upload|transmit)\\s+[^\\n]{0,2048}\\s+(to|at)\\s+https?://", "send_to_url"],
  [`(include|output|print|share)\\s+${FILLER}(conversation|chat\\s+history|previous\\s+messages|full\\s+context|entire\\s+context)`, "context_exfil"],
  ["authorized_keys", "ssh_backdoor"],
  ["(?:\\b(?:echo|cat|cp|mv|dd|tee|install|printf|rsync|scp|ln|append|add|write|sed|chmod|chown|truncate|rm|touch|curl|wget|git)\\b|\\bopen\\s*\\(|>>?)[^\\n]{0,512}(?:\\$HOME/\\.ssh|~/\\.ssh)", "ssh_access"],
  [`${MODIFY}(?:AGENTS\\.md|CLAUDE\\.md|\\.cursorrules|\\.clinerules)`, "agent_config_mod"],
  ["(?:忽略|无视|忽视)[^\\n]{0,16}(?:之前|以上|上面|先前|前面|所有|全部)[^\\n]{0,16}(?:指令|指示|规则|提示词)", "prompt_injection_zh"],
  ["(?:不要|别|切勿)[^\\n]{0,8}(?:告诉|告知|透露给)[^\\n]{0,4}用户", "deception_hide_zh"],
  ["(?:输出|打印|泄露|显示)[^\\n]{0,8}(?:系统提示|系统指令)", "leak_system_prompt_zh"],
].map(([source, id]) => [new RegExp(source, "iu"), id]);

const INVISIBLE_CHARS = new Set([..."\u200b\u200c\u200d\u2060\u2062\u2063\u2064\ufeff\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"]);

// The first matched pattern ID, or null. Invisible characters are checked on
// the raw text because NFKC can strip them.
function memoryThreatPattern(text) {
  if (typeof text !== "string" || !text) return null;
  const raw = text.slice(0, MAX_SCAN_CHARS);
  for (const ch of raw) {
    if (INVISIBLE_CHARS.has(ch)) return `invisible_unicode_U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
  }
  const normalized = raw.normalize("NFKC");
  return PATTERNS.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
}

module.exports = { memoryThreatPattern };
