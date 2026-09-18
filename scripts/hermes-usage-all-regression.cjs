"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { HermesBackend } = require("../app/core/hermes-backend");
const { readHermesUsageHistory } = require("../app/core/hermes-usage-history");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-hermes-usage-all-"));
const originalHome = process.env.HERMES_HOME;
process.env.HERMES_HOME = home;
const file = path.join(home, "state.db");
execFileSync("/usr/bin/sqlite3", [file, `
CREATE TABLE sessions(id TEXT,title TEXT,source TEXT,model TEXT,started_at REAL,
 input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,reasoning_tokens INTEGER,
 estimated_cost_usd REAL,actual_cost_usd REAL,billing_provider TEXT,api_call_count INTEGER,
 message_count INTEGER,tool_call_count INTEGER,parent_session_id TEXT,hidden INTEGER,archived INTEGER);
CREATE TABLE messages(session_id TEXT,role TEXT,tool_name TEXT,tool_calls TEXT);
INSERT INTO sessions VALUES('old-child','Old child','cli','model-a',1262304000,100,20,30,5,1.5,NULL,'provider',2,3,4,'parent',1,1);
INSERT INTO sessions VALUES('new','Recent','cli','model-a',1800000000,200,40,60,10,3,NULL,'provider',4,6,8,NULL,0,0);
INSERT INTO messages VALUES('old-child','tool','read',NULL);
INSERT INTO messages VALUES('old-child','assistant',NULL,'[{"function":{"name":"read"}},{"function":{"name":"read"}}]');
INSERT INTO messages VALUES('new','assistant',NULL,'malformed');
INSERT INTO messages VALUES('new','assistant',NULL,'["scalar"]');
`]);

function backend(mode = "local") {
  const instance = new HermesBackend({ getConfig: () => ({ hermesMode: mode }) });
  instance.profileById.set("hermes-default", "default");
  instance.dashboards.set("default", { profile: "default", baseUrl: "http://127.0.0.1:1" });
  return instance;
}

(async () => {
  try {
    const before = fs.readFileSync(file);
    const data = await readHermesUsageHistory(file);
    assert.equal(data.daily.length, 2, "全历史应包含超过一年、隐藏、归档和子会话");
    assert.equal(data.daily[0].day, "2010-01-01");
    assert.deepEqual(data.tools, [{ tool: "read", count: 2 }], "两种工具计量取max，不能重复计数");
    const instance = backend();
    const [series, breakdown] = await Promise.all([instance.getUsageSeries("all"), instance.getUsageBreakdown("all")]);
    assert.equal(series.availability, "complete");
    assert.equal(series.totals.totalTokens, 465);
    assert.equal(series.totals.totalCost, 4.5);
    assert.equal(breakdown.totals.totalTokens, series.totals.totalTokens);
    assert.equal(breakdown.byModel[0].totalTokens, 465);
    assert.equal(breakdown.dailyActivity.reduce((sum, row) => sum + row.messages, 0), 9);
    assert.equal(breakdown.modelDaily.reduce((sum, row) => sum + row.tokens, 0), 465);
    assert.equal(breakdown.topSessions.length, 2);
    assert.deepEqual(fs.readFileSync(file), before, "全历史查询必须保持数据库逐字节不变");
    // Mixed actual/estimated/free sessions on one day, separate historical day,
    // and the modern auxiliary ledger. Empty-task primary rows must not double count.
    execFileSync("/usr/bin/sqlite3", [file, `
INSERT INTO sessions VALUES('paid','Paid','cli','cost-model',1800000000,10,0,0,0,1.2,1,'provider',1,1,0,NULL,0,0);
INSERT INTO sessions VALUES('estimated','Estimated','cli','cost-model',1800000000,20,0,0,0,2,NULL,'provider',1,1,0,NULL,0,0);
INSERT INTO sessions VALUES('free','Free','cli','cost-model',1800000000,30,0,0,0,99,0,'provider',1,1,0,NULL,0,0);
CREATE TABLE session_model_usage(session_id TEXT,model TEXT,task TEXT,billing_provider TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,reasoning_tokens INTEGER,estimated_cost_usd REAL,api_call_count INTEGER);
INSERT INTO session_model_usage VALUES('new','aux-only','compression','provider',500,50,0,0,0.5,1);
INSERT INTO session_model_usage VALUES('old-child','old-aux','vision','provider',70,0,0,0,0.7,1);
INSERT INTO session_model_usage VALUES('new','primary-repeated','','provider',10000,0,0,0,100,1);
INSERT INTO session_model_usage VALUES('missing','orphan-aux','vision','provider',10000,0,0,0,100,1);
`]);
    const modernBefore = fs.readFileSync(file);
    const [modernSeries, modernBreakdown] = await Promise.all([instance.getUsageSeries("all"), instance.getUsageBreakdown("all")]);
    assert.equal(modernSeries.totals.totalTokens, 525, "Aux计量不进入上游session daily/total口径");
    assert.equal(modernSeries.daily[0].totalCost, 1.5, "历史日独立保留估算成本");
    assert.equal(modernSeries.daily[1].totalCost, 6, "同一天按session先选实际或估算，再求和");
    assert.equal(modernSeries.totals.totalCost, 7.5, "跨日费用与逐session选择一致");
    assert.equal(modernBreakdown.totals.totalCost, 7.5);
    assert.equal(modernBreakdown.topSessions.find((row) => row.sessionId === "free").totalCost, 0, "实际费用0不能退回非零估算");
    assert.equal(modernBreakdown.byModel.find((row) => row.model === "cost-model").totalCost, 3);
    assert.equal(modernBreakdown.byModel.find((row) => row.model === "aux-only").totalTokens, 550);
    assert.equal(modernBreakdown.byModel.find((row) => row.model === "aux-only").totalCost, 0.5);
    assert.equal(modernBreakdown.byModel.find((row) => row.model === "old-aux").totalTokens, 70, "All模型榜包括旧日期的aux账本");
    assert.equal(modernBreakdown.byModel.some((row) => ["primary-repeated", "orphan-aux"].includes(row.model)), false);
    assert.equal(modernBreakdown.modelDaily.reduce((sum, row) => sum + row.tokens, 0), 525, "日趋势与session总计一致，不重复加aux");
    assert.deepEqual(fs.readFileSync(file), modernBefore);
    instance.profileById.set("hermes-missing", "missing");
    instance.dashboards.set("missing", { profile: "missing", baseUrl: "http://127.0.0.1:1" });
    const partial = await instance.getUsageSeries("all");
    assert.equal(partial.availability, "partial");
    assert.equal(partial.totals.totalTokens, 525, "失败profile不能拖垮健康profile");
    const remote = await backend("remote").getUsageSeries("all");
    assert.equal(remote.availability, "unavailable", "远端缺全历史接口必须明确不可用，不能偷偷读本机数据");
    assert.equal(remote.availabilityReason, "unsupported-range");
    assert.equal(instance._usageRangeDays("1y"), 365);
    assert.equal(instance._usageRangeDays("all"), null, "不可再发送违反上游范围的36500天");
    console.log("PASS Hermes full-history usage, read-only, hidden/archived children, failure isolation, remote boundary");
  } finally {
    if (originalHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
