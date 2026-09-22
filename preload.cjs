const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopAgent", {
  openApp: (appName) => ipcRenderer.invoke("open-app", appName),
  closeApp: (appName) => ipcRenderer.invoke("close-app", appName),
  setVolume: (volume) => ipcRenderer.invoke("set-volume", volume),
  muteVolume: () => ipcRenderer.invoke("mute-volume"),
  unmuteVolume: () => ipcRenderer.invoke("unmute-volume"),
  changeVolume: (amount) => ipcRenderer.invoke("change-volume", amount),
  getSystemInfo: () => ipcRenderer.invoke("get-system-info"),
  openUrl: (url) => ipcRenderer.invoke("open-url", url),
  agentCommand: (prompt) => ipcRenderer.invoke("agent-command", prompt),
  confirmAgentAction: (confirmationId, approved) =>
    ipcRenderer.invoke("confirm-agent-action", confirmationId, approved),
  clearAgentMemory: () => ipcRenderer.invoke("clear-agent-memory"),
  transcribeAudio: (arrayBuffer, mimeType) => ipcRenderer.invoke("transcribe-audio", { arrayBuffer, mimeType }),
  wakeWordStart: () => ipcRenderer.invoke("wake-word-start"),
  wakeWordAudio: (arrayBuffer) => ipcRenderer.send("wake-word-audio", arrayBuffer),
  wakeWordStop: () => ipcRenderer.invoke("wake-word-stop"),
  getWakeWordStatus: () => ipcRenderer.invoke("wake-word-status"),
  onWakeWordEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("wake-word-event", listener);
    return () => ipcRenderer.removeListener("wake-word-event", listener);
  },
  geminiLiveStart: () => ipcRenderer.invoke("gemini-live-start"),
  geminiLiveAudio: (arrayBuffer) => ipcRenderer.send("gemini-live-audio", arrayBuffer),
  geminiLiveEndAudio: () => ipcRenderer.invoke("gemini-live-end-audio"),
  geminiLiveStop: () => ipcRenderer.invoke("gemini-live-stop"),
  getGeminiLiveStatus: () => ipcRenderer.invoke("gemini-live-status"),
  onGeminiLiveEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("gemini-live-event", listener);
    return () => ipcRenderer.removeListener("gemini-live-event", listener);
  },
  getLocalAiStatus: () => ipcRenderer.invoke("local-ai-status"),
  getTtsStatus: () => ipcRenderer.invoke("tts-status"),
  importTtsReference: () => ipcRenderer.invoke("tts-import-reference"),
  synthesizeSpeech: (text, options) => ipcRenderer.invoke("tts-synthesize", { text, options }),
  getBrowserSettings: () => ipcRenderer.invoke("browser-settings"),
  setPreferredBrowser: (name) => ipcRenderer.invoke("browser-set-preferred", name),
  openYouTubeMusicLogin: () => ipcRenderer.invoke("youtube-music-login"),
  getGoogleStatus: () => ipcRenderer.invoke("google-status"),
  connectGoogle: () => ipcRenderer.invoke("google-connect"),
  getAutostart: () => ipcRenderer.invoke("get-autostart"),
  setAutostart: (enabled) => ipcRenderer.invoke("set-autostart", enabled),
  onUiCommand: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("ui-command", listener);
    return () => ipcRenderer.removeListener("ui-command", listener);
  },
  onAgentStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("agent-status", listener);
    return () => ipcRenderer.removeListener("agent-status", listener);
  },
});
