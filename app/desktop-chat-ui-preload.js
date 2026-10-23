"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const CHANNEL = "shoggoth-chat-ui:bridge";
contextBridge.exposeInMainWorld("nativeChatUiBridge", Object.freeze({
  request: value => {
    const json = JSON.stringify(value);
    if (typeof json !== "string" || new TextEncoder().encode(json).length > 12 * 1024) {
      return Promise.reject(new Error("UI_BRIDGE_TOO_LARGE"));
    }
    return ipcRenderer.invoke(CHANNEL, JSON.parse(json)).then(reply=>{if(reply?.ok===true)return reply.result;const error=new Error(reply?.error?.code||'UI_BRIDGE_REJECTED');Object.assign(error,reply?.error);throw error;});
  },
  subscribe: listener => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("shoggoth-chat-ui:update", handler);
    return () => ipcRenderer.removeListener("shoggoth-chat-ui:update", handler);
  },
}));
