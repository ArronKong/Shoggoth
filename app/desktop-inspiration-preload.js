"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const prefix = "shoggoth:desktop-inspiration:";
const subscribe = (name, callback) => {
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(prefix + name, handler);
  return () => ipcRenderer.removeListener(prefix + name, handler);
};
contextBridge.exposeInMainWorld("openclawDesktop", {
  requestMicrophoneAccess: () => ipcRenderer.invoke("shoggoth:microphone:request"),
  getMicrophoneAccessStatus: () => ipcRenderer.invoke("shoggoth:microphone:status"),
  saveInspirationArchive: input => ipcRenderer.invoke("shoggoth:inspiration:save-archive", input),
  desktopInspiration: {
    surface: true,
    ready: () => ipcRenderer.invoke(prefix + "ready"),
    reveal: presentationId => ipcRenderer.invoke(prefix + "reveal", presentationId),
    conceal: presentationId => ipcRenderer.invoke(prefix + "conceal", presentationId),
    dismiss: () => ipcRenderer.invoke(prefix + "dismiss"),
    setInteractive: value => ipcRenderer.send(prefix + "interaction", value),
    setBusy: value => ipcRenderer.send(prefix + "busy", value),
    trayTarget: () => ipcRenderer.invoke(prefix + "tray-target"),
    onShow: callback => subscribe("show", callback),
    onHide: callback => subscribe("hide", callback),
    onHidden: callback => subscribe("hidden", callback),
    onGeometry: callback => subscribe("geometry", callback),
  },
});
