"use strict";

const { execFile } = require("node:child_process");

// Hermes' HTTP analytics accepts at most 365 days. Its session-list endpoint
// hides child sessions and compresses chains, so it cannot supply lifetime
// counters. For a local profile, read the same authoritative tables as Hermes
// analytics, in a read-only transaction. SQLite stays out of the UI process;
// timeout/output limits fail the whole profile instead of publishing truncation.
function jsonRows(query, columns) {
  return `(SELECT json_group_array(json_object(${columns.map((c) => `'${c}',${c}`).join(",")})) FROM (${query}))`;
}

const parts = ["input_tokens", "output_tokens", "cache_read_tokens", "reasoning_tokens"];
const sums = parts.map((c) => `COALESCE(SUM(${c}),0) AS ${c}`).join(",");
// Resolve each session before grouping: a paid session must not hide another
// session's estimate, and an explicit billed zero is a valid free call.
const costs = "COALESCE(SUM(estimated_cost_usd),0) AS estimated_cost, COALESCE(SUM(actual_cost_usd),0) AS actual_cost, COALESCE(SUM(COALESCE(actual_cost_usd,estimated_cost_usd,0)),0) AS resolved_cost";
const measures = [...parts, "estimated_cost", "actual_cost", "resolved_cost"];
const day = "date(started_at,'unixepoch')";
const daily = jsonRows(`SELECT ${day} AS day,${sums},${costs} FROM sessions GROUP BY day ORDER BY day`, ["day", ...measures]);
const sessionModels = `SELECT COALESCE(NULLIF(model,''),'unknown') AS model,billing_provider AS provider,${sums},${costs},SUM(COALESCE(api_call_count,0)) AS api_calls FROM sessions GROUP BY model,billing_provider`;
// Match Hermes _aux_usage_rows/_get_models_analytics: task='' repeats primary
// accounting and is excluded. Non-empty task rows are add-only auxiliary use;
// they belong to the model rankings, never to session daily/total counters.
const auxiliaryModels = `SELECT COALESCE(NULLIF(u.model,''),'unknown') AS model,u.billing_provider AS provider,
 ${parts.map((c) => `COALESCE(SUM(u.${c}),0) AS ${c}`).join(",")},
 COALESCE(SUM(u.estimated_cost_usd),0) AS estimated_cost,0 AS actual_cost,
 COALESCE(SUM(u.estimated_cost_usd),0) AS resolved_cost,SUM(COALESCE(u.api_call_count,0)) AS api_calls
 FROM session_model_usage u JOIN sessions s ON s.id=u.session_id WHERE u.task!='' GROUP BY u.model,u.billing_provider`;
const activity = jsonRows(`SELECT ${day} AS date,SUM(COALESCE(message_count,0)) AS messages,SUM(COALESCE(tool_call_count,0)) AS toolCalls FROM sessions GROUP BY date`, ["date", "messages", "toolCalls"]);
const modelDaily = jsonRows(`SELECT ${day} AS date,COALESCE(NULLIF(model,''),'unknown') AS model,${sums},${costs} FROM sessions GROUP BY date,model`, ["date", "model", ...measures]);
const sessionColumns = ["id", "title", "source", "model", "started_at", "input_tokens", "output_tokens", "cache_read_tokens", "reasoning_tokens", "estimated_cost_usd", "actual_cost_usd"];
const sessions = jsonRows(`SELECT ${sessionColumns.join(",")},COALESCE(actual_cost_usd,estimated_cost_usd,0) AS resolved_cost FROM sessions ORDER BY COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(reasoning_tokens,0) DESC LIMIT 100`, [...sessionColumns, "resolved_cost"]);
const tools = jsonRows(`SELECT tool,MAX(count) AS count FROM (
  SELECT m.tool_name AS tool,COUNT(*) AS count FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.role='tool' AND m.tool_name IS NOT NULL GROUP BY tool
  UNION ALL
  SELECT json_extract(j.value,'$.function.name') AS tool,COUNT(*) AS count FROM messages m JOIN sessions s ON s.id=m.session_id,
    json_each(CASE WHEN json_valid(m.tool_calls) THEN m.tool_calls ELSE '[]' END) j
    WHERE m.role='assistant' AND j.type='object' AND json_extract(j.value,'$.function.name') IS NOT NULL GROUP BY tool
) GROUP BY tool`, ["tool", "count"]);
function historyQuery(hasAuxiliary) {
  const models = jsonRows(`${sessionModels}${hasAuxiliary ? ` UNION ALL ${auxiliaryModels}` : ""}`, ["model", "provider", ...measures, "api_calls"]);
  return `PRAGMA query_only=ON; BEGIN; SELECT json_object('daily',${daily},'by_model',${models},'models',${models},'day_activity',${activity},'model_daily',${modelDaily},'sessions',${sessions},'tools',${tools}); COMMIT;`;
}

function readSqlite(filePath, query, timeout, maxBuffer) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/sqlite3", ["-readonly", "-batch", filePath, query], {
      timeout, maxBuffer, windowsHide: true,
    }, (error, stdout) => {
      if (error) return reject(new Error("Hermes lifetime usage could not be read"));
      resolve(stdout);
    });
  });
}

async function readHermesUsageHistory(filePath) {
  const deadline = Date.now() + 15_000;
  // Older Hermes databases may not have the task ledger yet. Inspect only its
  // column names, never open a migration writer or read missing tables blindly.
  const columns = await readSqlite(filePath, "SELECT name FROM pragma_table_info('session_model_usage');", 2_000, 64 * 1024);
  const schema = new Set(columns.trim().split(/\r?\n/));
  const hasAuxiliary = ["session_id", "model", "task", "billing_provider", ...parts, "estimated_cost_usd", "api_call_count"]
    .every((column) => schema.has(column));
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Hermes lifetime usage could not be read");
  const result = await readSqlite(filePath, historyQuery(hasAuxiliary), remaining, 8 * 1024 * 1024);
  try { return JSON.parse(result); }
  catch { throw new Error("Hermes lifetime usage response was invalid"); }
}

module.exports = { readHermesUsageHistory };
