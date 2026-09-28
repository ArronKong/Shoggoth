"use strict";

// The Airtable mode uses the frozen bundle and a local OAuth + MCP protocol
// fixture. No Airtable account, source placeholder client ID, or remote IO.
require("./plugin-oauth-management-unit.cjs").main({ airtable: true })
  .catch(error => { console.error(error); process.exitCode = 1; });
