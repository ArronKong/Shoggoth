const { OpenClawBackend } = require('./app/core/openclaw-backend.js');
async function run() {
  const oc = new OpenClawBackend();
  const costAll = await oc.getUsageSeries("all");
  console.log("ALL:", costAll.daily.length > 0 ? costAll.daily[0].date : "none");
  const cost1y = await oc.getUsageSeries("1y");
  console.log("1y:", cost1y.daily.length > 0 ? cost1y.daily[0].date : "none");
  const cost10y = await oc.getUsageSeries("10y");
  console.log("10y:", cost10y.daily.length > 0 ? cost10y.daily[0].date : "none");
  await oc.stop();
}
run().catch(console.error);
