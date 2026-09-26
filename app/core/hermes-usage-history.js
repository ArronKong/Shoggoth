"use strict";

const { execFile } = require("node:child_process");

// Query every local profile without starting its dashboard, including archived,
// hidden and child sessions. The primary session row includes task='' usage;
// non-empty auxiliary tasks are additional usage and must be added exactly once.
function jsonRows(query, columns) {
  return `(SELECT json_group_array(json_object(${columns.map(c => `'${c}',${c}`).join(",")})) FROM (${query}))`;
}
const parts = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"];
function historyQuery(schema, range, now) {
  const column = (table, name, fallback = "NULL") => schema[table]?.has(name) ? `${table}.${name}` : fallback;
  const primary = parts.map(c => `${column("sessions", c, "0")} AS ${c}`).join(",");
  const actual = column("sessions", "actual_cost_usd");
  const estimated = column("sessions", "estimated_cost_usd");
  const costQuality = (a, e) => `CASE WHEN ${a} IS NOT NULL THEN 'reported' WHEN ${e} IS NOT NULL THEN 'estimated' ELSE 'missing' END`;
  let usage = `SELECT sessions.id AS session_id,sessions.started_at AS at,COALESCE(NULLIF(sessions.model,''),'unknown') AS model,
    ${column("sessions", "billing_provider")} AS provider,${primary},COALESCE(${actual},${estimated},0) AS resolved_cost,
    ${costQuality(actual, estimated)} AS cost_quality,${column("sessions", "api_call_count", "0")} AS api_calls FROM sessions`;
  const hasAuxiliary = ["session_id", "model", "task", "estimated_cost_usd", ...parts.filter(c => c !== "cache_write_tokens")]
    .every(c => schema.session_model_usage.has(c));
  if (hasAuxiliary) {
    const auxActual = column("session_model_usage", "actual_cost_usd");
    const auxEstimated = column("session_model_usage", "estimated_cost_usd");
    usage += ` UNION ALL SELECT sessions.id,COALESCE(${column("session_model_usage", "first_seen_at")},sessions.started_at),
      COALESCE(NULLIF(session_model_usage.model,''),'unknown'),${column("session_model_usage", "billing_provider")},
      ${parts.map(c => column("session_model_usage", c, "0")).join(",")},COALESCE(${auxActual},${auxEstimated},0),
      ${costQuality(auxActual, auxEstimated)},${column("session_model_usage", "api_call_count", "0")}
      FROM session_model_usage JOIN sessions ON sessions.id=session_model_usage.session_id WHERE session_model_usage.task!=''`;
  }
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ({ today: 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365 }[range] || 1) + 1);
  const cutoff = range === "all" ? 0 : start.getTime() / 1000;
  const sums = parts.map(c => `COALESCE(SUM(${c}),0) AS ${c}`).join(",");
  const measures = [...parts, "resolved_cost", "cost_quality", "entry_count"];
  const aggregates = `${sums},SUM(resolved_cost) AS resolved_cost,cost_quality,COUNT(*) AS entry_count`;
  const day = "date(at,'unixepoch','localtime')";
  // Keep price provenance/model until JS resolves estimates; merging unlike
  // sessions first would let one billed session hide another's missing cost.
  const daily = jsonRows(`SELECT ${day} AS day,model,provider,${aggregates} FROM scoped GROUP BY day,model,provider,cost_quality`, ["day", "model", "provider", ...measures]);
  const models = jsonRows(`SELECT model,provider,${aggregates},SUM(api_calls) AS api_calls FROM scoped GROUP BY model,provider,cost_quality`, ["model", "provider", ...measures, "api_calls"]);
  const modelDaily = jsonRows(`SELECT ${day} AS date,model,provider,${aggregates} FROM scoped GROUP BY date,model,provider,cost_quality`, ["date", "model", "provider", ...measures]);
  const sessionDay = "date(started_at,'unixepoch','localtime')";
  const sessionsInRange = range === "all" ? "1=1" : `started_at>=${cutoff} AND started_at<=${now / 1000}`;
  const activity = jsonRows(`SELECT ${sessionDay} AS date,SUM(COALESCE(message_count,0)) AS messages,SUM(COALESCE(tool_call_count,0)) AS toolCalls FROM sessions WHERE ${sessionsInRange} GROUP BY date`, ["date", "messages", "toolCalls"]);
  const sessions = jsonRows(`SELECT sessions.id,title,source,sessions.model,started_at,${primary},${actual} AS actual_cost_usd,${estimated} AS estimated_cost_usd,
    COALESCE(${actual},${estimated},0) AS resolved_cost,${costQuality(actual, estimated)} AS cost_quality
    FROM sessions WHERE ${sessionsInRange} ORDER BY COALESCE(input_tokens,0)+COALESCE(output_tokens,0) DESC LIMIT 100`, ["id", "title", "source", "model", "started_at", ...parts, "actual_cost_usd", "estimated_cost_usd", "resolved_cost", "cost_quality"]);
  const tools = jsonRows(`SELECT tool,MAX(count) AS count FROM (
    SELECT m.tool_name AS tool,COUNT(*) AS count FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.started_at>=${cutoff} AND m.role='tool' AND m.tool_name IS NOT NULL GROUP BY tool
    UNION ALL SELECT json_extract(j.value,'$.function.name') AS tool,COUNT(*) AS count FROM messages m JOIN sessions s ON s.id=m.session_id,
    json_each(CASE WHEN json_valid(m.tool_calls) THEN m.tool_calls ELSE '[]' END) j
    WHERE s.started_at>=${cutoff} AND m.role='assistant' AND j.type='object' AND json_extract(j.value,'$.function.name') IS NOT NULL GROUP BY tool
  ) GROUP BY tool`, ["tool", "count"]);
  const lastActivity = `COALESCE(${column("sessions", "last_activity_at")},${column("sessions", "ended_at")},sessions.started_at)`;
  // Cumulative upstream counters cannot split an older session's usage at midnight.
  const overlapping = cutoff === 0 ? "0" : `(SELECT COUNT(*) FROM sessions WHERE started_at<${cutoff} AND ${lastActivity}>=${cutoff})`;
  return `PRAGMA query_only=ON; BEGIN; WITH usage AS (${usage}),scoped AS (SELECT * FROM usage WHERE ${range === "all" ? "1=1" : `at>=${cutoff} AND at<=${now / 1000}`})
    SELECT json_object('daily',${daily},'by_model',${models},'models',${models},'day_activity',${activity},'model_daily',${modelDaily},'sessions',${sessions},'tools',${tools},'overlapping_sessions',${overlapping}); COMMIT;`;
}

function readSqlite(filePath, query, timeout, maxBuffer) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/sqlite3", ["-readonly", "-batch", filePath, query], {
      timeout, maxBuffer, windowsHide: true,
    }, (error, stdout) => {
      if (error) return reject(new Error("Hermes usage could not be read"));
      resolve(stdout);
    });
  });
}

async function readHermesUsageHistory(filePath, { range = "all", now = Date.now() } = {}) {
  if (!["today", "7d", "30d", "90d", "1y", "all"].includes(range) || !Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid usage range");
  const schema = {};
  await Promise.all(["sessions", "session_model_usage"].map(async table => {
    const columns = await readSqlite(filePath, `SELECT name FROM pragma_table_info('${table}');`, 2_000, 64 * 1024);
    schema[table] = new Set(columns.trim().split(/\r?\n/));
  }));
  const result = await readSqlite(filePath, historyQuery(schema, range, now), 15_000, 8 * 1024 * 1024);
  try { return JSON.parse(result); }
  catch { throw new Error("Hermes usage response was invalid"); }
}

module.exports = { readHermesUsageHistory };
