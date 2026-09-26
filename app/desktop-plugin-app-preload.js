"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// Only the registered MCP App window can use this channel. No filesystem,
// shell, generic IPC, credentials or normal desktop bridge is exposed here.
contextBridge.exposeInMainWorld("pluginAppBridge", Object.freeze({
  request: message => {
    const json = JSON.stringify(message);
    if (typeof json !== "string" || json.length > 64 * 1024) return Promise.reject(new Error("MCP App message too large"));
    return ipcRenderer.invoke("shoggoth-plugin-app:request", JSON.parse(json));
  },
}));
