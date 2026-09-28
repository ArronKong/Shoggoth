"use strict";

// The Shopify mode uses the frozen bundle and isolated OAuth + MCP fixtures.
// It never uses a Shopify account, source placeholder client ID, or remote IO.
require("./plugin-oauth-management-unit.cjs").main({ shopify: true })
  .catch(error => { console.error(error); process.exitCode = 1; });
