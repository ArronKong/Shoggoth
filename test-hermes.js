const { HermesBackend } = require('./app/core/hermes-backend.js');
async function run() {
  const hb = new HermesBackend();
  await hb.start();
  const costAll = await hb.getUsageSeries("all");
  console.log("ALL:", costAll.daily.length > 0 ? costAll.daily[0].date : "none");
  const cost1y = await hb.getUsageSeries("1y");
  console.log("1y:", cost1y.daily.length > 0 ? cost1y.daily[0].date : "none");
  process.exit(0);
}
run().catch(console.error);
