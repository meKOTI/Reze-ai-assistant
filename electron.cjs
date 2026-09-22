require("dotenv").config();

const { app, BrowserWindow, ipcMain, shell, Tray, Menu, globalShortcut, session, dialog } = require("electron");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { exec, spawn } = require("child_process");
const loudness = require("loudness");
const { executeAgentAction, getActionRisk, captureScreenDataUrl } = require("./agent-tools.cjs");
const { addMessage, rememberFact, recallFacts, getContext, clearMemory: clearPersistentMemory } = require("./memory-store.cjs");
const {
  configureBrowser,
  getBrowserSettings,
  setPreferredBrowser,
  browserStart,
  browserOpen,
  browserSearch,
  browserSnapshot,
  browserClick,
  browserType,
  browserPress,
  youtubeMusicLogin,
  youtubeMusicPlay,
  browserClose,
} = require("./browser-tools.cjs");
const { googleStatus, googleConnect, gmailList, gmailRead, gmailSend, calendarList, calendarCreate, calendarDelete } = require("./google-tools.cjs");
const { uiSnapshot, uiFocusWindow, uiClick, uiSetText } = require("./windows-ui.cjs");
const { getLocalAiStatus, callLocalModel, getCurrentLocalModel, LOCAL_AI_MODEL } = require("./local-ai.cjs");
const { configureTts, status: getTtsEngineStatus, importReference: importTtsReference, synthesize: synthesizeTts, shutdown: shutdownTts } = require("./tts-engine.cjs");

let mainWindow;
let tray;
let isQuitting = false;
const pendingConfirmations = new Map();
const conversationHistory = [];
const MAX_HISTORY_MESSAGES = 16;
const MAX_AGENT_STEPS = 10;
const MAX_LOCAL_AGENT_STEPS = 6;
const GROQ_TEXT_MODEL = process.env.GROQ_TEXT_MODEL || "openai/gpt-oss-20b";
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3";
const GROQ_STT_LANGUAGE = (process.env.GROQ_STT_LANGUAGE || "pl").trim();
const GROQ_STT_HINTS = (process.env.REZE_STT_HINTS || "REZE, Discord, Spotify, YouTube Music, IRIS OUT, Ado, Chrome, Brave, Edge, Ollama, Qwen").trim();

const REZE_WAKE_THRESHOLD = Number(process.env.REZE_WAKE_THRESHOLD || "0.50");
const REZE_WAKE_VAD_THRESHOLD = Number(process.env.REZE_WAKE_VAD_THRESHOLD || "0.35");
let wakeWordProcess = null;
let wakeWordReady = false;
let wakeWordLastScore = 0;
let wakeWordLineBuffer = "";

function emitWakeWordEvent(payload = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("wake-word-event", payload);
  }
}

function getWakePythonPath() {
  const candidates = [
    path.join(__dirname, ".venv-openwakeword", "Scripts", "python.exe"),
    process.env.REZE_WAKE_PYTHON,
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function stopWakeWordSidecar() {
  wakeWordReady = false;
  if (wakeWordProcess) {
    try { wakeWordProcess.stdin?.end(); } catch {}
    try { wakeWordProcess.kill(); } catch {}
  }
  wakeWordProcess = null;
  wakeWordLineBuffer = "";
}

function handleWakeWordLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    if (msg.type === "ready") wakeWordReady = true;
    if (msg.type === "score") wakeWordLastScore = Number(msg.score || 0);
    if (msg.type === "error") wakeWordReady = false;
    emitWakeWordEvent(msg);
  } catch {
    emitWakeWordEvent({ type: "debug", message: trimmed });
  }
}

function startWakeWordSidecar() {
  if (wakeWordProcess && !wakeWordProcess.killed) {
    return { success: true, ready: wakeWordReady };
  }

  const python = getWakePythonPath();
  if (!python) {
    const message = "Brak środowiska openWakeWord. Uruchom SETUP-OPENWAKEWORD.ps1.";
    emitWakeWordEvent({ type: "error", message });
    return { success: false, message };
  }

  const script = path.join(__dirname, "openwakeword-sidecar.py");
  if (!fs.existsSync(script)) {
    const message = "Brak pliku openwakeword-sidecar.py.";
    emitWakeWordEvent({ type: "error", message });
    return { success: false, message };
  }

  wakeWordReady = false;
  wakeWordLastScore = 0;
  wakeWordLineBuffer = "";

  const child = spawn(python, [script], {
    cwd: __dirname,
    env: {
      ...process.env,
      REZE_WAKE_THRESHOLD: String(REZE_WAKE_THRESHOLD),
      REZE_WAKE_VAD_THRESHOLD: String(REZE_WAKE_VAD_THRESHOLD),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  wakeWordProcess = child;

  // A Python sidecar can exit immediately (for example when reze.onnx is missing).
  // Node emits EPIPE asynchronously on stdin in that case, so a try/catch around
  // stdin.write() alone is not enough. Swallow EPIPE and surface other errors in UI.
  child.stdin.on("error", (error) => {
    if (error?.code === "EPIPE") return;
    emitWakeWordEvent({ type: "error", message: `openWakeWord stdin: ${error.message}` });
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    wakeWordLineBuffer += data;
    const lines = wakeWordLineBuffer.split(/\r?\n/);
    wakeWordLineBuffer = lines.pop() || "";
    for (const line of lines) handleWakeWordLine(line);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => {
    const msg = String(data || "").trim();
    if (msg) emitWakeWordEvent({ type: "debug", message: msg });
  });
  child.on("error", (error) => {
    wakeWordReady = false;
    emitWakeWordEvent({ type: "error", message: `openWakeWord: ${error.message}` });
  });
  child.on("exit", (code) => {
    const wasCurrent = wakeWordProcess === child;
    if (wasCurrent) {
      wakeWordProcess = null;
      wakeWordReady = false;
    }
    if (code && code !== 0) {
      let hint = "";
      if (code === 2) hint = " Sprawdź instalację przez SETUP-OPENWAKEWORD.ps1.";
      if (code === 3) hint = " Brakuje wake-models\\reze.onnx.";
      if (code === 4) hint = " Nie udało się załadować modelu ONNX.";
      emitWakeWordEvent({ type: "error", message: `openWakeWord zakończył pracę (kod ${code}).${hint}` });
    }
  });

  return { success: true, ready: false };
}

function sendWakeWordPcm(arrayBuffer) {
  const child = wakeWordProcess;
  if (
    !child ||
    child.killed ||
    child.exitCode !== null ||
    !child.stdin ||
    !child.stdin.writable ||
    child.stdin.destroyed ||
    !arrayBuffer
  ) {
    return false;
  }

  const pcm = Buffer.from(arrayBuffer);
  if (!pcm.length) return false;

  const packet = Buffer.allocUnsafe(4 + pcm.length);
  packet.writeUInt32LE(pcm.length, 0);
  pcm.copy(packet, 4);

  try {
    const ok = child.stdin.write(packet, (error) => {
      if (error && error.code !== "EPIPE") {
        emitWakeWordEvent({ type: "error", message: `openWakeWord stdin: ${error.message}` });
      }
    });
    return ok;
  } catch (error) {
    if (error?.code !== "EPIPE") {
      emitWakeWordEvent({ type: "error", message: `openWakeWord write: ${error.message}` });
    }
    return false;
  }
}


const apps = {
  notatnik: { open: "notepad.exe", process: "notepad.exe" },
  notepad: { open: "notepad.exe", process: "notepad.exe" },
  kalkulator: { open: "calc.exe", process: "CalculatorApp.exe" },
  calculator: { open: "calc.exe", process: "CalculatorApp.exe" },
  paint: { open: "mspaint.exe", process: "mspaint.exe" },
};

function showMainWindow({ focusInput = false, toggleVoice = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (focusInput) mainWindow.webContents.send("ui-command", { type: "focus_input" });
  if (toggleVoice) mainWindow.webContents.send("ui-command", { type: "toggle_voice" });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: "#0b0f14",
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.argv.includes("--dev")) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "dist", "index.html"));
  }
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, "public", "tray-icon.png"));
  tray.setToolTip("REZE Desktop Assistant");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Pokaż REZE", click: () => showMainWindow({ focusInput: true }) },
    { label: "Polecenie głosowe", click: () => showMainWindow({ toggleVoice: true }) },
    { type: "separator" },
    { label: "Zakończ REZE", click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on("double-click", () => showMainWindow({ focusInput: true }));
}

function loginItemSettings(enabled) {
  const options = { openAtLogin: Boolean(enabled) };
  if (process.platform === "win32" && !app.isPackaged) {
    options.path = process.execPath;
    options.args = [app.getAppPath()];
  }
  app.setLoginItemSettings(options);
  return app.getLoginItemSettings();
}

function remember(role, content) {
  const text = String(content);
  conversationHistory.push({ role, content: text });
  if (conversationHistory.length > MAX_HISTORY_MESSAGES) {
    conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY_MESSAGES);
  }
  addMessage(role, text).catch((error) => console.warn("MEMORY SAVE ERROR:", error.message));
}

function systemInfoMessage() {
  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const usedRam = totalRam - freeRam;
  return `CPU: ${os.cpus()[0]?.model ?? "Nieznany"} | RAM: ${(usedRam / 1024 ** 3).toFixed(1)} GB / ${(totalRam / 1024 ** 3).toFixed(1)} GB`;
}

function requestedBrowserName(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text.includes("brave")) return "brave";
  if (text.includes("chrome")) return "chrome";
  if (text.includes("edge")) return "edge";
  return null;
}

async function executeCoreAction(action, args = {}) {
  // Nie uruchamiaj przeglądarek zwykłym open_program/open_app.
  // Przeglądarka musi należeć do tej samej sesji Playwright, żeby następny
  // browser_search/browser_snapshot nie tworzył drugiego okna.
  if (action === "open_program") {
    const browserName = requestedBrowserName(args.name);
    if (browserName) {
      const started = await browserStart(browserName);
      return { message: JSON.stringify(started, null, 2) };
    }
  }

  if (action === "open_app") {
    const browserName = requestedBrowserName(args.appName);
    if (browserName) {
      const started = await browserStart(browserName);
      return { message: JSON.stringify(started, null, 2) };
    }
  }

  const extended = await executeAgentAction(action, args);
  if (extended) return extended;

  switch (action) {
    case "open_app": {
      const key = args.appName?.toLowerCase().trim();
      const selectedApp = apps[key];
      if (selectedApp) {
        exec(selectedApp.open);
        return { message: `Otwieram ${args.appName}.` };
      }

      const dynamic = await executeAgentAction("open_program", { name: args.appName });
      if (dynamic) return dynamic;
      throw new Error(`Nie znalazłem aplikacji: ${args.appName}`);
    }
    case "close_app": {
      const key = args.appName?.toLowerCase().trim();
      const selectedApp = apps[key];
      if (!selectedApp) throw new Error(`Nie znam aplikacji: ${args.appName}`);
      return await new Promise((resolve, reject) => {
        exec(`taskkill /IM "${selectedApp.process}" /F`, (error) => {
          if (error) reject(new Error(`Nie udało się zamknąć ${args.appName}.`));
          else resolve({ message: `Zamknąłem ${args.appName}.` });
        });
      });
    }
    case "set_volume": {
      const volume = Number(args.volume);
      if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw new Error("Nieprawidłowa głośność.");
      await loudness.setVolume(volume);
      return { message: `Ustawiłem głośność na ${volume}%.` };
    }
    case "mute_volume":
      await loudness.setMuted(true);
      return { message: "Wyciszyłem komputer." };
    case "unmute_volume":
      await loudness.setMuted(false);
      return { message: "Włączyłem dźwięk." };
    case "change_volume": {
      const amount = Number(args.amount);
      if (!Number.isFinite(amount)) throw new Error("Nieprawidłowa zmiana głośności.");
      const current = await loudness.getVolume();
      const next = Math.max(0, Math.min(100, current + amount));
      await loudness.setVolume(next);
      return { message: `Głośność: ${next}%.` };
    }
    case "get_system_info":
      return { message: systemInfoMessage() };
    case "open_url": {
      let url = String(args.url || "").trim();
      if (!url) throw new Error("Brak adresu strony.");
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      return { message: JSON.stringify(await browserOpen(url, "auto"), null, 2) };
    }
    case "remember_fact":
      return { message: `Zapamiętałem: ${await rememberFact(args.text, args.category)}` };
    case "recall_memory":
      return { message: JSON.stringify(await recallFacts(args.query), null, 2) };
    case "analyze_screen":
      return { message: JSON.stringify(await analyzeScreen(args.query), null, 2) };
    case "browser_open":
      return { message: JSON.stringify(await browserOpen(args.url, args.browser), null, 2) };
    case "browser_search":
      return { message: JSON.stringify(await browserSearch(args.query, args.browser), null, 2) };
    case "browser_snapshot":
      return { message: JSON.stringify(await browserSnapshot(), null, 2) };
    case "browser_click":
      return { message: JSON.stringify(await browserClick(args.target), null, 2) };
    case "browser_type":
      return { message: JSON.stringify(await browserType(args.target, args.text, args.submit), null, 2) };
    case "browser_press":
      return { message: JSON.stringify(await browserPress(args.key), null, 2) };
    case "youtube_music_play":
      return { message: JSON.stringify(await youtubeMusicPlay(args.query, args.browser, args.mode || "song"), null, 2) };
    case "browser_close":
      return { message: await browserClose() };
    case "google_status":
      return { message: JSON.stringify(await googleStatus(), null, 2) };
    case "google_connect":
      return { message: JSON.stringify(await googleConnect(), null, 2) };
    case "gmail_list":
      return { message: JSON.stringify(await gmailList(args), null, 2) };
    case "gmail_read":
      return { message: JSON.stringify(await gmailRead(args), null, 2) };
    case "gmail_send":
      return { message: JSON.stringify(await gmailSend(args), null, 2) };
    case "calendar_list":
      return { message: JSON.stringify(await calendarList(args), null, 2) };
    case "calendar_create":
      return { message: JSON.stringify(await calendarCreate(args), null, 2) };
    case "calendar_delete":
      return { message: JSON.stringify(await calendarDelete(args), null, 2) };
    case "ui_snapshot":
      return { message: JSON.stringify(await uiSnapshot(args), null, 2) };
    case "ui_focus_window":
      return { message: JSON.stringify(await uiFocusWindow(args), null, 2) };
    case "ui_click":
      return { message: JSON.stringify(await uiClick(args), null, 2) };
    case "ui_set_text":
      return { message: JSON.stringify(await uiSetText(args), null, 2) };
    default:
      throw new Error(`Nieznana akcja: ${action}`);
  }
}

function normalizeFastCommand(prompt) {
  let value = String(prompt || "").trim();

  // STT / wake-word potrafi zostawić na początku nazwę asystenta.
  // Router ma dostać samo polecenie, np. "REZE, puść IRIS OUT" -> "puść IRIS OUT".
  value = value
    .replace(/^[\s"'„”‘’]*?(?:hej\s+)?reze(?:\s*[,.:;!?-]+\s*|\s+)/i, "")
    .replace(/^[\s"'„”‘’]+|[\s"'„”‘’]+$/g, "")
    .trim();

  // Potoczny początek zdania nie powinien wypychać prostego polecenia do modelu.
  // Normalizujemy tylko wypełniacze na początku, nie nazwy utworów / aplikacji.
  // Przykład: "Ej, weź mi puść villain od Ado" -> "puść villain od Ado".
  for (let i = 0; i < 4; i += 1) {
    const before = value;
    value = value
      .replace(/^(?:ej|hej|dobra|okej|ok|no)\b[\s,.:;!?-]*/i, "")
      .replace(/^(?:czy\s+)?(?:możesz|mozesz)\s+(?:mi\s+)?/i, "")
      .replace(/^(?:proszę|prosze)\s+(?:cię|cie)?\s*/i, "")
      .replace(/^(?:weź|wez)\s+(?:mi\s+)?/i, "")
      .trim();
    if (value === before) break;
  }

  return value;
}

async function tryFastRoute(prompt) {
  // Najpierw normalizujemy tekst z mikrofonu / wake-word. Dzięki temu
  // "REZE, puść IRIS OUT" i "puść IRIS OUT" trafiają w tę samą szybką ścieżkę.
  const command = normalizeFastCommand(prompt);
  const text = command.toLowerCase();
  let match;

  match = text.match(/^(?:volume|głośność)\s+(\d{1,3})%?$/i);
  if (match) {
    const value = Number(match[1]);
    if (value >= 0 && value <= 100) {
      await loudness.setVolume(value);
      return { success: true, route: "FAST", message: `Głośność: ${value}%.` };
    }
  }

  if (["mute", "wycisz"].includes(text)) {
    await loudness.setMuted(true);
    return { success: true, route: "FAST", message: "Wyciszyłem komputer." };
  }
  if (["unmute", "odcisz"].includes(text)) {
    await loudness.setMuted(false);
    return { success: true, route: "FAST", message: "Włączyłem dźwięk." };
  }
  if (["stop", "reze stop", "anuluj", "reze anuluj"].includes(text)) {
    return { success: true, route: "FAST", message: "Anulowano." };
  }

  // Muzyka: najczęstsze frazy omijają model i od razu trafiają do YouTube Music.
  match = command.match(/^(?:puść|pusc|zagraj|odtwórz|odtworz)\s+(?:mi\s+)?coś\s+od\s+(.+)$/i);
  if (match) {
    const query = match[1].trim();
    const result = await youtubeMusicPlay(query, "auto", "artist");
    return { success: true, route: "FAST", message: `Puszczam coś od ${query} w YouTube Music.`, data: result };
  }

  // "puść IRIS OUT od Ado" -> wyszukuj jako "Ado IRIS OUT".
  // Kolejność wykonawca + tytuł (np. "puść Ado IRIS OUT") również działa —
  // trafia do następnej reguły jako pełne zapytanie.
  match = command.match(/^(?:puść|pusc|zagraj|odtwórz|odtworz)\s+(?:mi\s+)?(.+?)\s+od\s+(.+)$/i);
  if (match) {
    const title = match[1].trim();
    const artist = match[2].trim();
    const query = `${artist} ${title}`;
    const result = await youtubeMusicPlay(query, "auto", "song");
    return { success: true, route: "FAST", message: `Puszczam ${title} od ${artist} w YouTube Music.`, data: result };
  }

  match = command.match(/^(?:puść|pusc|zagraj|odtwórz|odtworz)\s+(?:mi\s+)?(.+)$/i);
  if (match) {
    const query = match[1].trim();
    const result = await youtubeMusicPlay(query, "auto", "song");
    return { success: true, route: "FAST", message: `Puszczam ${query} w YouTube Music.`, data: result };
  }

  match = command.match(/^(?:włącz|wlacz)\s+(?:piosenkę|piosenke|utwór|utwor|muzykę|muzyke)\s+(.+?)\s+od\s+(.+)$/i);
  if (match) {
    const title = match[1].trim();
    const artist = match[2].trim();
    const query = `${artist} ${title}`;
    const result = await youtubeMusicPlay(query, "auto", "song");
    return { success: true, route: "FAST", message: `Puszczam ${title} od ${artist} w YouTube Music.`, data: result };
  }

  match = command.match(/^(?:włącz|wlacz)\s+(?:piosenkę|piosenke|utwór|utwor|muzykę|muzyke)\s+(.+)$/i);
  if (match) {
    const query = match[1].trim();
    const result = await youtubeMusicPlay(query, "auto", "song");
    return { success: true, route: "FAST", message: `Puszczam ${query} w YouTube Music.`, data: result };
  }

  match = command.match(/^(?:włącz|wlacz)\s+coś\s+od\s+(.+)$/i);
  if (match) {
    const query = match[1].trim();
    const result = await youtubeMusicPlay(query, "auto", "artist");
    return { success: true, route: "FAST", message: `Puszczam coś od ${query} w YouTube Music.`, data: result };
  }

  // Najczęstsze polecenia uruchamiania aplikacji też omijają lokalny model.
  // Dzięki temu awaria / zawieszenie Qwena nie blokuje podstawowego sterowania pulpitem.
  match = command.match(/^(?:(?:hej\s+)?(?:reze[, ]+)?|(?:czy\s+)?(?:możesz|mozesz)\s+|(?:weź|wez)\s+)?(?:otwórz|otworz|odpal|uruchom|włącz|wlacz)\s+(?:mi\s+)?(.+?)[.!?]*$/i);
  if (match) {
    let target = match[1].trim();
    // Nie przechwytuj zdań, które wyglądają jak bardziej złożone polecenia.
    if (target && target.split(/\s+/).length <= 5 && !/\b(?:i|oraz|potem|następnie|nastepnie|wyszukaj|znajdź|znajdz|na youtube|w youtube)\b/i.test(target)) {
      target = target.replace(/^(?:aplikację|aplikacje|program)\s+/i, "").trim();
      try {
        const result = await executeCoreAction("open_program", { name: target });
        return { success: true, route: "FAST", message: result?.message || `Otwieram ${target}.` };
      } catch {
        // Jeśli nie jest to aplikacja, nie zgadujemy — niech dalszy router zdecyduje,
        // np. czy "włącz IRIS OUT" oznacza utwór w YouTube Music.
      }
    }
  }

  return null;
}

const SYSTEM_PROMPT = `
Jesteś REZE, agentem desktopowym na Windows. Odpowiadasz po polsku.
Masz dostęp do narzędzi przekazanych przez API. Korzystaj z nich, gdy są potrzebne.

Zasady:
- Wykonuj zadania krok po kroku. Najpierw ustal minimalny plan, potem wykonuj kolejne narzędzia i sprawdzaj ich wyniki.
- Jeśli narzędzie zwróci błąd, nie powtarzaj bezmyślnie tej samej akcji: zmień strategię albo wyjaśnij problem.
- Gdy potrzebujesz pliku, najpierw go znajdź narzędziem find_files, a potem użyj open_file/read_file.
- Gdy użytkownik chce otworzyć aplikację/program, preferuj open_program. Jeśli chcesz najpierw sprawdzić dopasowania, użyj find_program.
- open_app służy głównie do kilku starych wbudowanych aliasów; do Discorda, Spotify, Steam, Chrome, VS Code i innych zainstalowanych aplikacji używaj open_program.
- Jeśli użytkownik prosi o najnowszy plik, wyniki find_files są posortowane od najnowszego do najstarszego — wybierz pierwszy.
- Do Pulpitu/Pobranych/Dokumentów używaj aliasów desktop, downloads, documents lub ścieżek zwróconych przez narzędzia.
- Nie wymyślaj wyników narzędzi.
- Nie kasuj plików, nie formatuj dysków, nie modyfikuj kont/rejestru i nie instaluj programów.
- Do sterowania zwykłymi oknami Windows preferuj ui_snapshot + ui_click/ui_set_text. To jest stabilniejsze niż zgadywanie współrzędnych.
- Gdy Windows UI Automation nie widzi potrzebnego elementu, użyj analyze_screen jako fallback. Zwraca opis i może podać współrzędne celu. Dopiero potem użyj mouse_click.
- Do stron WWW preferuj narzędzia browser_* zamiast sterowania myszą.
- Jeśli użytkownik wskazuje konkretną przeglądarkę (np. Brave, Chrome, Edge), NIE otwieraj jej przez open_program. Użyj browser_open lub browser_search z polem browser, aby REZE sterowała dokładnie tą przeglądarką.
- Dla poleceń typu „otwórz Brave i wyszukaj Sony” użyj WYŁĄCZNIE browser_search({ query: "Sony", browser: "brave" }). Nie wywołuj przed tym open_program, open_app, open_url ani browser_open.
- Do zwykłego wyszukiwania preferuj browser_search. Nie otwieraj osobno wyszukiwarki przed browser_search, bo tworzy to duplikaty okien/kart.
- browser_snapshot daje tekst i elementy strony, więc używaj go po nawigacji i po ważnych kliknięciach.
- Domyślna przeglądarka REZE jest wybierana przez użytkownika w UI. Jeśli pole browser nie jest podane, użyj tej preferencji.
- Do odtwarzania muzyki używaj youtube_music_play zamiast ręcznego klikania po YouTube Music.
- Przykłady: „puść IRIS OUT”, „puść Ado IRIS OUT”, „włącz utwór IRIS OUT” => youtube_music_play(..., mode: "song").
- „puść IRIS OUT od Ado” oznacza konkretny utwór; wyszukuj najlepiej jako „Ado IRIS OUT”.
- „puść coś od Ado”, „włącz coś od Ado” => youtube_music_play({ query: "Ado", mode: "artist" }).
- YouTube Music działa w trwałym profilu przeglądarki REZE. Użytkownik loguje się raz, a cookies/sesja są zachowywane lokalnie.
- Zapamiętuj trwałe preferencje/fakty o użytkowniku przez remember_fact tylko wtedy, gdy są faktycznie przydatne w przyszłości. Użyj recall_memory, gdy wcześniejsza preferencja może pomóc.
- Gmail i Kalendarz Google obsługuj wyłącznie przez narzędzia google_*, gmail_* i calendar_*. Gdy konto nie jest połączone, użyj google_status lub poproś użytkownika o połączenie w UI.
- Do odczytu maili używaj gmail_list/gmail_read. Wysyłanie maila przez gmail_send wymaga potwierdzenia aplikacji.
- Do kalendarza używaj calendar_list/calendar_create/calendar_delete. Tworzenie i usuwanie wydarzeń wymaga potwierdzenia aplikacji.
- Sterowanie myszą/klawiaturą, kliknięcia/wpisywanie w przeglądarce i ryzykowne operacje mogą wymagać zgody użytkownika; aplikacja sama ją obsłuży.
- Gdy zadanie jest zakończone albo pytanie nie wymaga narzędzia, odpowiedz zwykłym krótkim tekstem po polsku.
`;

const GROQ_TOOLS = [
  {
    type: "function",
    function: {
      name: "open_app",
      description: "Otwórz prostą znaną aplikację Windows. Dla pozostałych zainstalowanych programów preferuj open_program.",
      parameters: {
        type: "object",
        properties: { appName: { type: "string" } },
        required: ["appName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_app",
      description: "Zamknij znaną aplikację Windows.",
      parameters: {
        type: "object",
        properties: { appName: { type: "string" } },
        required: ["appName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_volume",
      description: "Ustaw głośność systemu w zakresie 0-100.",
      parameters: {
        type: "object",
        properties: { volume: { type: "number", minimum: 0, maximum: 100 } },
        required: ["volume"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mute_volume",
      description: "Wycisz dźwięk systemu.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "unmute_volume",
      description: "Włącz dźwięk systemu po wyciszeniu.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "change_volume",
      description: "Zmień obecną głośność o podaną liczbę punktów procentowych.",
      parameters: {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_system_info",
      description: "Pobierz podstawowe informacje o komputerze, CPU i RAM.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "open_url",
      description: "Otwórz adres URL w przeglądarce wybranej w ustawieniach REZE.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "Wyświetl pliki w katalogu użytkownika.",
      parameters: {
        type: "object",
        properties: { dir: { type: "string", description: "Np. desktop, downloads, documents, home" } },
        required: ["dir"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description: "Znajdź pliki. Wyniki są posortowane od najnowszego do najstarszego.",
      parameters: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Np. downloads, desktop, documents" },
          query: { type: "string", description: "Fragment nazwy; może być pusty" },
          extension: { type: "string", description: "Rozszerzenie bez kropki, np. pdf" },
          limit: { type: "number", minimum: 1, maximum: 100 },
        },
        required: ["dir"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Odczytaj plik tekstowy z dozwolonego katalogu użytkownika.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Utwórz lub zapisz plik w dozwolonym katalogu użytkownika.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          overwrite: { type: "boolean" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_file",
      description: "Otwórz istniejący plik w domyślnej aplikacji. Używaj pełnej ścieżki zwróconej przez find_files, jeśli ją masz.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_program",
      description: "Znajdź zainstalowany program w menu Start Windows. Użyj, gdy nazwa aplikacji jest niepewna albo chcesz zobaczyć dopasowania.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nazwa programu, np. Discord, Spotify, Steam, Chrome, Visual Studio Code" },
          limit: { type: "number", minimum: 1, maximum: 20 },
          refresh: { type: "boolean", description: "Odśwież katalog aplikacji" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_program",
      description: "Znajdź i uruchom zainstalowany program Windows po jego ludzkiej nazwie, np. Discord, Spotify, Steam, Chrome lub Visual Studio Code.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_program",
      description: "Uruchom program z opcjonalnymi argumentami.",
      parameters: {
        type: "object",
        properties: {
          program: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
        required: ["program"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_powershell",
      description: "Uruchom wyłącznie bezpieczne polecenie PowerShell do odczytu/diagnostyki, np. Get-Process. Nie używaj do otwierania plików, jeśli istnieje open_file.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "take_screenshot",
      description: "Zrób screenshot ekranu i opcjonalnie zapisz pod wskazaną ścieżką.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mouse_click",
      description: "Kliknij myszą w podanych współrzędnych ekranu.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          button: { type: "string", enum: ["left", "right", "middle"] },
        },
        required: ["x", "y"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description: "Wpisz tekst za pomocą klawiatury do aktywnego pola.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press_key",
      description: "Naciśnij klawisz lub skrót klawiaturowy.",
      parameters: {
        type: "object",
        properties: { combo: { type: "string" } },
        required: ["combo"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_screen",
      description: "Zrób bieżący screenshot w pamięci i przeanalizuj ekran modelem vision. Użyj do znalezienia elementu na ekranie lub opisania tego, co widać.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Co znaleźć/opisać, np. przycisk Pobierz. Jeśli szukasz elementu, model zwróci x/y." } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember_fact",
      description: "Zapisz trwałą, przydatną preferencję lub fakt użytkownika w lokalnej pamięci ARII.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" }, category: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_memory",
      description: "Wyszukaj trwałe fakty i preferencje zapisane wcześniej przez ARIĘ.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_open",
      description: "Otwórz stronę w kontrolowanej przez ARIĘ przeglądarce. Obsługuje Brave, Chrome i Edge.",
      parameters: { type: "object", properties: { url: { type: "string" }, browser: { type: "string", enum: ["auto", "brave", "chrome", "edge"] } }, required: ["url"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_search",
      description: "Wyszukaj zapytanie w Google w kontrolowanej przeglądarce Brave, Chrome lub Edge. Używaj, gdy użytkownik mówi np. 'otwórz Brave i wyszukaj Sony'.",
      parameters: { type: "object", properties: { query: { type: "string" }, browser: { type: "string", enum: ["auto", "brave", "chrome", "edge"] } }, required: ["query"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_snapshot",
      description: "Odczytaj bieżącą stronę: tytuł, URL, tekst i listę widocznych elementów interaktywnych.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description: "Kliknij element w kontrolowanej przeglądarce. Preferuj ref typu reze-12 zwrócony przez browser_snapshot; możesz też użyć tekstu albo selektora CSS.",
      parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_type",
      description: "Wpisz tekst do pola na stronie. Preferuj ref typu reze-12 zwrócony przez browser_snapshot; można też użyć etykiety, placeholdera lub selektora. Opcjonalnie zatwierdź Enterem.",
      parameters: { type: "object", properties: { target: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } }, required: ["target", "text"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_press",
      description: "Wyślij klawisz do kontrolowanej przeglądarki, np. Enter, Escape, Control+L.",
      parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "youtube_music_play",
      description: "Odtwórz utwór albo coś od wskazanego wykonawcy w YouTube Music, używając wybranej domyślnej przeglądarki REZE i trwałej zalogowanej sesji. Dla konkretnego tytułu mode=song; dla 'coś od artysty' mode=artist.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Tytuł utworu albo nazwa wykonawcy." },
          mode: { type: "string", enum: ["song", "artist"] },
          browser: { type: "string", enum: ["auto", "brave", "chrome", "edge"] },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_close",
      description: "Zamknij kontrolowaną przeglądarkę ARII.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "google_status",
      description: "Sprawdź, czy integracja Google jest skonfigurowana i połączona.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "google_connect",
      description: "Rozpocznij bezpieczne logowanie OAuth do Google w przeglądarce użytkownika.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "gmail_list",
      description: "Pobierz listę wiadomości Gmail. query obsługuje składnię wyszukiwania Gmail, np. is:unread, from:abc@example.com.",
      parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 20 } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "gmail_read",
      description: "Odczytaj pełniejszą treść wiadomości Gmail po ID zwróconym przez gmail_list.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "gmail_send",
      description: "Wyślij wiadomość Gmail. Ta akcja wymaga potwierdzenia użytkownika.",
      parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_list",
      description: "Pobierz wydarzenia z głównego Kalendarza Google w zakresie dat ISO. Jeśli nie podasz zakresu, zwróci najbliższe 7 dni.",
      parameters: { type: "object", properties: { timeMin: { type: "string" }, timeMax: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 50 } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_create",
      description: "Utwórz wydarzenie w głównym Kalendarzu Google. start/end jako ISO 8601. Akcja wymaga potwierdzenia.",
      parameters: { type: "object", properties: { summary: { type: "string" }, start: { type: "string" }, end: { type: "string" }, description: { type: "string" }, location: { type: "string" } }, required: ["summary", "start"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_delete",
      description: "Usuń wydarzenie Kalendarza Google po ID. Akcja wymaga potwierdzenia.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "ui_snapshot",
      description: "Odczytaj strukturę elementów aktywnego okna Windows przez UI Automation. Preferuj przed vision/myszą.",
      parameters: { type: "object", properties: { maxElements: { type: "number", minimum: 20, maximum: 300 }, maxDepth: { type: "number", minimum: 1, maximum: 8 } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "ui_focus_window",
      description: "Przenieś fokus na istniejące okno po fragmencie jego tytułu.",
      parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "ui_click",
      description: "Kliknij/wywołaj element aktywnego okna przez Windows UI Automation. Najpierw użyj ui_snapshot.",
      parameters: { type: "object", properties: { name: { type: "string" }, automationId: { type: "string" }, controlType: { type: "string" } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "ui_set_text",
      description: "Wpisz tekst do pola aktywnego okna przez Windows UI Automation. Najpierw użyj ui_snapshot.",
      parameters: { type: "object", properties: { name: { type: "string" }, automationId: { type: "string" }, controlType: { type: "string" }, text: { type: "string" } }, required: ["text"], additionalProperties: false },
    },
  },
];

const LOCAL_SYSTEM_PROMPT = `
Jesteś szybkim lokalnym mózgiem REZE działającym na komputerze użytkownika. Rozumiesz naturalny język polski.
Twoje najważniejsze zadanie to interpretować codzienną mowę i wykonywać proste/średnie zadania przez narzędzia.

Przykłady tej samej intencji:
- "otwórz Discorda", "otworzysz mi discorda?", "weź odpal Discord", "możesz włączyć discorda" => open_program(name="Discord")
- "trochę ciszej", "ścisz mi komputer o 10" => change_volume(amount=-10)
- "puść IRIS OUT", "puść Ado IRIS OUT", "zagraj IRIS OUT", "włącz utwór IRIS OUT" => youtube_music_play(..., mode="song")
- "puść IRIS OUT od Ado" => youtube_music_play(query="Ado IRIS OUT", mode="song")
- "puść coś od Ado", "włącz coś od Ado" => youtube_music_play(query="Ado", mode="artist")

Zasady:
- Nie wymagaj od użytkownika sztywnych komend. Rozpoznawaj sens wypowiedzi.
- Dla prostych operacji na komputerze NATYCHMIAST używaj właściwego narzędzia, bez długiego tłumaczenia.
- Do elementów aplikacji Windows preferuj ui_snapshot, potem ui_click/ui_set_text. Vision/mysz to fallback.
- Jeśli użytkownik chce odtworzyć utwór lub coś od wykonawcy, preferuj youtube_music_play. Nie deleguj tego do Groq.
- Po ważnym kroku możesz odczytać UI ponownie i sprawdzić rezultat.
- Jeśli zadanie wymaga długiego rozumowania, szerokiej wiedzy, analizy wielu dokumentów, skomplikowanego planu, aktualnej wiedzy internetowej albo nie jesteś pewny co zrobić — użyj delegate_to_groq.
- Nie deleguj prostych poleceń desktopowych tylko dlatego, że użytkownik powiedział je potocznie.
- Jeśli zadanie nie wymaga narzędzia i potrafisz odpowiedzieć krótko oraz pewnie, odpowiedz bezpośrednio po polsku.
- Odpowiedzi końcowe mają być krótkie i naturalne.
`;


// --- Gemini Live voice pipeline -------------------------------------------------
// Wake-word detection remains 100% local in the renderer. Only audio recorded
// AFTER the local "REZE" detection is streamed to Gemini Live.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";
const GEMINI_LIVE_TIMEOUT_MS = Number(process.env.GEMINI_LIVE_TIMEOUT_MS || 12000);
let geminiLiveSession = null;

function geminiEvent(type, data = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("gemini-live-event", { type, ...data });
}

function geminiSchema(value) {
  if (Array.isArray(value)) return value.map(geminiSchema);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "additionalProperties") continue;
    out[key] = geminiSchema(item);
  }
  return out;
}

function geminiFunctionDeclarations() {
  return GROQ_TOOLS.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: geminiSchema(tool.function.parameters || { type: "object", properties: {} }),
  }));
}

function closeGeminiLive(reason = "done") {
  const current = geminiLiveSession;
  geminiLiveSession = null;
  if (!current) return;
  clearTimeout(current.timeout);
  try { current.ws?.close(1000, reason); } catch {}
}

function armGeminiTimeout(session) {
  clearTimeout(session.timeout);
  session.timeout = setTimeout(() => {
    if (geminiLiveSession !== session) return;
    geminiEvent("error", {
      message: `Gemini Live: brak odpowiedzi. Odebrano z mikrofonu ${session.receivedAudioChunks || 0} paczek / ${session.receivedAudioBytes || 0} B; wysłano do Gemini ${session.audioChunks || 0} paczek / ${session.audioBytes || 0} B; setup=${session.ready ? "OK" : "BRAK setupComplete"}.`,
      audioChunks: session.audioChunks || 0,
      audioBytes: session.audioBytes || 0,
      receivedAudioChunks: session.receivedAudioChunks || 0,
      receivedAudioBytes: session.receivedAudioBytes || 0,
      ready: Boolean(session.ready),
    });
    closeGeminiLive("timeout");
  }, GEMINI_LIVE_TIMEOUT_MS);
}

async function executeGeminiTool(session, fc) {
  if (geminiLiveSession !== session || session.finished) return;
  session.finished = true;
  const action = String(fc?.name || "");
  const args = fc?.args && typeof fc.args === "object" ? fc.args : {};
  geminiEvent("tool", { action, args });

  if (!GROQ_TOOLS.some((tool) => tool.function.name === action)) {
    const message = `Gemini wybrało nieznane narzędzie: ${action}`;
    geminiEvent("result", { success: false, route: "GEMINI LIVE", message });
    closeGeminiLive("unknown_tool");
    return;
  }

  const risk = getActionRisk(action, args);
  if (risk.risky || ["ui_click", "ui_set_text"].includes(action)) {
    const confirmationId = crypto.randomUUID();
    const reason = risk.risky ? risk.reason : `REZE chce sterować interfejsem Windows: ${action}`;
    pendingConfirmations.set(confirmationId, { engine: "GEMINI", action, args });
    geminiEvent("result", {
      success: false,
      route: "GEMINI LIVE",
      requiresConfirmation: true,
      confirmationId,
      confirmation: reason,
      message: reason,
    });
    closeGeminiLive("confirmation");
    return;
  }

  let result;
  try {
    result = await executeCoreAction(action, args);
    const message = String(result?.message || "Gotowe.");
    remember("assistant", message);
    geminiEvent("result", { success: true, route: "GEMINI LIVE", action, message });
  } catch (error) {
    geminiEvent("result", { success: false, route: "GEMINI LIVE", action, message: `Nie udało się: ${error.message}` });
  } finally {
    // One wake word = one attempted command. Close immediately after the tool attempt.
    closeGeminiLive("tool_attempted");
  }
}

function handleGeminiMessage(session, raw) {
  let response;
  try { response = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")); }
  catch { return; }
  if (geminiLiveSession !== session) return;

  if (response.setupComplete !== undefined) {
    session.ready = true;
    geminiEvent("ready", { model: GEMINI_LIVE_MODEL });
    // Keep Gemini's server-side activity detector enabled. REZE still decides
    // when to stop capturing locally, but Gemini decides the speech boundaries
    // inside the streamed audio. This is the most reliable hybrid mode documented
    // by the Live API.
    for (const pcm of session.audioQueue.splice(0)) sendGeminiPcm(session, pcm);
    if (session.endRequested) sendGeminiAudioEnd(session);
    return;
  }

  if (response.goAway?.timeLeft) {
    geminiEvent("debug", { message: `Gemini Live GO_AWAY: ${response.goAway.timeLeft}` });
  }

  const content = response.serverContent;
  if (content?.inputTranscription?.text) {
    session.transcript = `${session.transcript || ""}${content.inputTranscription.text}`;
    geminiEvent("transcript", { text: session.transcript.trim() });
  }
  if (content?.modelTurn?.parts) {
    for (const part of content.modelTurn.parts) {
      if (part.text) session.modelText = `${session.modelText || ""}${part.text}`;
    }
  }

  if (response.toolCall?.functionCalls?.length) {
    executeGeminiTool(session, response.toolCall.functionCalls[0]).catch((error) => {
      geminiEvent("error", { message: error.message });
      closeGeminiLive("tool_error");
    });
    return;
  }

  if (content?.turnComplete && !session.finished) {
    session.finished = true;
    const message = String(session.modelText || "Nie rozpoznałem polecenia.").trim();
    geminiEvent("result", { success: Boolean(session.modelText), route: "GEMINI LIVE", message });
    closeGeminiLive("turn_complete");
  }
}

function sendGeminiPcm(session, pcm) {
  if (!session?.ready || session.ws?.readyState !== 1 || !pcm?.length || session.audioEnded) return;
  session.audioBytes += pcm.length;
  session.audioChunks = (session.audioChunks || 0) + 1;
  session.ws.send(JSON.stringify({
    realtimeInput: {
      audio: { data: Buffer.from(pcm).toString("base64"), mimeType: "audio/pcm;rate=16000" },
    },
  }));
}

function sendGeminiAudioEnd(session) {
  if (!session?.ready || session.ws?.readyState !== 1 || session.audioEnded) return;
  session.audioEnded = true;
  // Gemini keeps automatic activity detection enabled. REZE's local VAD only
  // decides when the microphone stream is finished; audioStreamEnd commits that
  // stream so the server can finalize the user's turn immediately.
  session.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  geminiEvent("processing", {
    transcript: session.transcript || "",
    audioBytes: session.audioBytes || 0,
    audioChunks: session.audioChunks || 0,
  });
  armGeminiTimeout(session);
}

function startGeminiLive() {
  if (!GEMINI_API_KEY) throw new Error("Brak GEMINI_API_KEY w pliku .env.");
  if (typeof WebSocket === "undefined") throw new Error("Ta wersja Node/Electron nie udostępnia WebSocket.");
  closeGeminiLive("restart");

  const endpoint = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const ws = new WebSocket(endpoint);
  const session = { ws, ready: false, audioQueue: [], endRequested: false, audioEnded: false, finished: false, transcript: "", modelText: "", timeout: null, audioBytes: 0, audioChunks: 0, receivedAudioBytes: 0, receivedAudioChunks: 0 };
  geminiLiveSession = session;
  geminiEvent("connecting", { model: GEMINI_LIVE_MODEL });

  ws.addEventListener("open", () => {
    if (geminiLiveSession !== session) return;
    ws.send(JSON.stringify({
      setup: {
        model: `models/${GEMINI_LIVE_MODEL}`,
        // Live API WebSocket schema: responseModalities belongs directly in setup.
        // Keeping it under generationConfig prevents setupComplete on current Gemini Live.
        responseModalities: ["AUDIO"],
        generationConfig: {
          thinkingConfig: { thinkingLevel: "minimal" },
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
            endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
            prefixPaddingMs: 120,
            silenceDurationMs: 450,
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: { parts: [{ text: `Jesteś głosowym interpreterem poleceń desktopowego asystenta REZE. Użytkownik mówi głównie po polsku, potocznie i może mieszać polski z angielskimi nazwami własnymi. Rozumiej INTENCJĘ bez wymagania poprawnej gramatyki. Dla polecenia wykonawczego NATYCHMIAST wybierz właściwe narzędzie i podaj argumenty. Nie opisuj toku rozumowania, nie pisz rozprawek, nie powtarzaj polecenia. Jeśli wypowiedź nie jest poleceniem możliwym do wykonania narzędziem, odpowiedz maksymalnie jednym krótkim zdaniem po polsku. Przykład: „ej weź mi puść Villain od Ado” => youtube_music_play(query="Ado Villain", mode="song"). „puść coś od Ado” => youtube_music_play(query="Ado", mode="artist").` }] },
        tools: [{ functionDeclarations: geminiFunctionDeclarations() }],
      },
    }));
  });
  ws.addEventListener("message", (event) => handleGeminiMessage(session, event.data));
  ws.addEventListener("error", (event) => {
    if (geminiLiveSession === session) geminiEvent("error", { message: `Błąd połączenia z Gemini Live${event?.message ? `: ${event.message}` : "."}` });
  });
  ws.addEventListener("close", (event) => {
    if (geminiLiveSession === session) {
      geminiLiveSession = null;
      geminiEvent("closed", { code: event.code, reason: event.reason || "" });
    }
  });
  armGeminiTimeout(session);
  return { success: true, model: GEMINI_LIVE_MODEL };
}

const LOCAL_TOOLS = [
  ...GROQ_TOOLS,
  {
    type: "function",
    function: {
      name: "delegate_to_groq",
      description: "Przekaż zadanie większemu modelowi Groq, gdy jest zbyt złożone lub wymaga głębszego rozumowania.",
      parameters: { type: "object", properties: { reason: { type: "string" } }, additionalProperties: false },
    },
  },
];

async function analyzeScreen(query) {
  if (!process.env.GROQ_API_KEY) throw new Error("Brak GROQ_API_KEY w pliku .env.");
  const shot = await captureScreenDataUrl();
  const prompt = `Przeanalizuj screenshot ekranu Windows o rozmiarze ${shot.width}x${shot.height}. Zadanie: ${String(query || "Opisz ekran")}.
Jeśli użytkownik chce znaleźć element do kliknięcia, zwróć współrzędne środka elementu względem tego obrazu. Odpowiedz WYŁĄCZNIE JSON-em:
{"description":"krótki opis","found":true,"x":123,"y":456,"confidence":0.0,"target":"co znaleziono"}.
Jeśli nie ma jednoznacznego celu, ustaw found=false oraz x/y=null.`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_VISION_MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: shot.dataUrl } },
      ] }],
    }),
  });
  if (!response.ok) throw new Error(`Groq Vision ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Model vision nie zwrócił odpowiedzi.");
  try {
    return JSON.parse(content);
  } catch {
    return { description: content, found: false, x: null, y: null, confidence: 0, target: "" };
  }
}

function compactGroqMessages(messages) {
  return messages.map((message) => {
    if (message.role !== "tool" || typeof message.content !== "string") return message;
    const limit = 6000;
    if (message.content.length <= limit) return message;
    return { ...message, content: message.content.slice(0, limit) + "\n[wynik skrócony przez REZE]" };
  });
}

function sendAgentStatus(type, data = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("agent-status", { type, ...data });
}

function retryDelayMs(response, errorText, attempt) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter * 1000) + 300;
  const match = String(errorText).match(/try again in\s+([0-9.]+)s/i);
  if (match) return Math.ceil(Number(match[1]) * 1000) + 500;
  return Math.min(15000, 2500 * (attempt + 1));
}

function recoverGroqToolCall(errorText) {
  let outer;
  try {
    outer = JSON.parse(errorText);
  } catch {
    return null;
  }

  const error = outer?.error;
  if (error?.code !== "tool_use_failed" || !error.failed_generation) return null;

  let failed;
  try {
    failed = typeof error.failed_generation === "string"
      ? JSON.parse(error.failed_generation)
      : error.failed_generation;
  } catch {
    return null;
  }

  const rawName = String(failed?.name || "").trim();
  // GPT-OSS potrafi czasem dokleić wewnętrzny token, np.
  // browser_snapshot<|channel|>commentary. Odcinamy wszystko od <|.
  const cleanName = rawName.split("<|")[0].trim();
  const allowedNames = new Set(GROQ_TOOLS.map((tool) => tool.function.name));
  if (!cleanName || !allowedNames.has(cleanName)) return null;

  let args = failed?.arguments ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) args = {};

  // Modele czasem zwracają {"":""} dla narzędzi bez parametrów.
  const schemaProperties = GROQ_TOOLS.find((tool) => tool.function.name === cleanName)
    ?.function?.parameters?.properties || {};
  args = Object.fromEntries(Object.entries(args).filter(([key]) => Object.hasOwn(schemaProperties, key)));

  console.warn(`GROQ TOOL RECOVERY: ${rawName} -> ${cleanName}`);
  return {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: `recovered_${crypto.randomUUID()}`,
      type: "function",
      function: {
        name: cleanName,
        arguments: JSON.stringify(args),
      },
    }],
  };
}

function normalizeSpeechTranscript(text) {
  let value = String(text || "").trim();
  if (!value) return value;

  // Tylko bardzo pewne, kontekstowe poprawki nazw używanych przez REZE.
  // Nie próbujemy „naprawiać” całych zdań, żeby nie zmieniać intencji użytkownika.
  const replacements = [
    [/\b(?:reze|rezę|rezy|rize|ryze)\b/gi, "REZE"],
    [/\biris\s*(?:out|aut|ałt|ał)\b/gi, "IRIS OUT"],
    [/\byoutube\s*music\b/gi, "YouTube Music"],
    [/\bspotif(?:y|aj|ai)\b/gi, "Spotify"],
    [/\bdiscord(?:a|zie|em)?\b/gi, (m) => m],
  ];
  for (const [pattern, replacement] of replacements) value = value.replace(pattern, replacement);
  return value.replace(/\s+/g, " ").trim();
}

function sttDebugDirectory() {
  const configured = String(process.env.REZE_STT_DEBUG_DIR || "").trim();
  return configured ? path.resolve(configured) : path.join(process.cwd(), "stt-debug");
}

function safeDebugStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function saveSttDebugRecording(arrayBuffer, mimeType) {
  const dir = sttDebugDirectory();
  await fs.promises.mkdir(dir, { recursive: true });
  const stamp = safeDebugStamp();
  const ext = String(mimeType || "").includes("ogg") ? "ogg" : String(mimeType || "").includes("wav") ? "wav" : "webm";
  const base = path.join(dir, stamp);
  await fs.promises.writeFile(`${base}.${ext}`, Buffer.from(arrayBuffer));
  return { dir, base, audioPath: `${base}.${ext}`, stamp };
}

async function transcribeAudio(arrayBuffer, mimeType = "audio/webm") {
  if (!process.env.GROQ_API_KEY) throw new Error("Brak GROQ_API_KEY w pliku .env.");
  if (!arrayBuffer) throw new Error("Brak danych audio.");

  let debug = null;
  try {
    debug = await saveSttDebugRecording(arrayBuffer, mimeType);
  } catch (error) {
    console.warn("[STT DEBUG] Nie udało się zapisać audio:", error.message);
  }

  const prompt = [
    "Dokładna transkrypcja polecenia głosowego do asystenta desktopowego REZE.",
    "Użytkownik mówi głównie po polsku, ale zdanie może zawierać angielskie lub japońskie nazwy aplikacji, wykonawców i utworów.",
    "Zachowuj nazwy własne w ich oryginalnej pisowni, gdy da się je rozpoznać.",
    "Nie tłumacz nazw utworów ani wykonawców. Nie dopowiadaj niczego przy ciszy lub szumie.",
    GROQ_STT_HINTS ? `Częste nazwy i słowa: ${GROQ_STT_HINTS}.` : "",
  ].filter(Boolean).join(" ");

  const form = new FormData();
  form.append("model", GROQ_STT_MODEL);
  if (GROQ_STT_LANGUAGE && GROQ_STT_LANGUAGE.toLowerCase() !== "auto") form.append("language", GROQ_STT_LANGUAGE);
  form.append("response_format", "json");
  form.append("temperature", "0");
  form.append("prompt", prompt);
  form.append("file", new Blob([arrayBuffer], { type: mimeType || "audio/webm" }), "reze-voice.webm");

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
  });
  const bodyText = await response.text();
  if (!response.ok) throw new Error(`Groq STT ${response.status}: ${bodyText}`);
  const data = JSON.parse(bodyText);
  const rawText = String(data.text || "").trim();
  const text = normalizeSpeechTranscript(rawText);

  if (debug) {
    try {
      await fs.promises.writeFile(`${debug.base}.raw.txt`, rawText, "utf8");
      await fs.promises.writeFile(`${debug.base}.final.txt`, text, "utf8");
      await fs.promises.writeFile(`${debug.base}.meta.json`, JSON.stringify({
        createdAt: new Date().toISOString(),
        audioPath: debug.audioPath,
        bytes: Buffer.byteLength(Buffer.from(arrayBuffer)),
        mimeType: mimeType || "audio/webm",
        model: GROQ_STT_MODEL,
        language: GROQ_STT_LANGUAGE || "auto",
        rawTranscript: rawText,
        finalTranscript: text,
      }, null, 2), "utf8");
      console.log(`[STT DEBUG] Zapisano próbkę: ${debug.audioPath}`);
      console.log(`[STT DEBUG] RAW: ${rawText}`);
      console.log(`[STT DEBUG] FINAL: ${text}`);
    } catch (error) {
      console.warn("[STT DEBUG] Nie udało się zapisać wyników:", error.message);
    }
  }

  return { text, rawText, debugDir: debug?.dir || null, debugAudioPath: debug?.audioPath || null };
}

async function callGroq(messages) {
  if (!process.env.GROQ_API_KEY) throw new Error("Brak GROQ_API_KEY w pliku .env.");

  const payload = {
    model: GROQ_TEXT_MODEL,
    temperature: 0.1,
    reasoning_effort: "low",
    reasoning_format: "hidden",
    tool_choice: "auto",
    parallel_tool_calls: false,
    tools: GROQ_TOOLS,
    max_completion_tokens: 700,
    messages: compactGroqMessages(messages),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      const data = await response.json();
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error("Groq nie zwrócił odpowiedzi.");
      return message;
    }

    const errorText = await response.text();

    // Groq może odrzucić tool call GPT-OSS, jeśli model doklei do nazwy
    // wewnętrzny token sterujący. Jeśli z failed_generation da się bezpiecznie
    // odzyskać jedno z narzędzi z naszej allowlisty, kontynuujemy bez kolejnego requestu.
    if (response.status === 400) {
      const recovered = recoverGroqToolCall(errorText);
      if (recovered) return recovered;
    }

    if (response.status === 429 && attempt < 2) {
      const waitMs = retryDelayMs(response, errorText, attempt);
      sendAgentStatus("rate_limit_wait", {
        waitMs,
        seconds: Math.max(1, Math.ceil(waitMs / 1000)),
        attempt: attempt + 1,
      });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      sendAgentStatus("rate_limit_resume", { attempt: attempt + 1 });
      continue;
    }
    throw new Error(`Groq ${response.status}: ${errorText}`);
  }

  throw new Error("Groq nadal zgłasza limit po ponowieniu próby.");
}

function parseToolArguments(toolCall) {
  const raw = toolCall?.function?.arguments;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Niepoprawne argumenty narzędzia ${toolCall?.function?.name || "unknown"}: ${raw}`);
  }
}

function assistantMessageForHistory(message) {
  const result = {
    role: "assistant",
    content: message.content ?? null,
  };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    result.tool_calls = message.tool_calls;
  }
  return result;
}

async function continueAgent(messages, startStep = 0) {
  for (let step = startStep; step < MAX_AGENT_STEPS; step += 1) {
    let aiMessage = await callGroq(messages);
    let toolCalls = Array.isArray(aiMessage.tool_calls) ? aiMessage.tool_calls : [];

    if (toolCalls.length === 0) {
      const lastUserText = [...messages].reverse().find((m) => m?.role === "user")?.content || "";
      if (looksLikeActionRequest(lastUserText)) {
        // GPT-OSS potrafi czasem opisać, jakie narzędzie powinien wywołać, zamiast je wywołać.
        // Robimy jeden wymuszony retry. Jeśli nadal nie ma tool calla, nie pokazujemy użytkownikowi
        // wewnętrznego rozumowania modelu.
        aiMessage = await callGroq([
          ...messages,
          {
            role: "system",
            content: "To jest polecenie wykonawcze. Nie opisuj rozumowania ani planu. Wywołaj teraz dokładnie właściwe narzędzie z poprawnymi argumentami. Jeśli nie możesz wykonać zadania narzędziem, odpowiedz jednym krótkim zdaniem po polsku.",
          },
        ]);
        toolCalls = Array.isArray(aiMessage.tool_calls) ? aiMessage.tool_calls : [];
        if (toolCalls.length === 0) {
          const safeMessage = "Nie udało mi się poprawnie uruchomić tej akcji. Spróbuj jeszcze raz.";
          remember("assistant", safeMessage);
          return { success: false, route: "GROQ", message: safeMessage, steps: step + 1 };
        }
      } else {
        const finalMessage = String(aiMessage.content || "Gotowe.").trim() || "Gotowe.";
        remember("assistant", finalMessage);
        return { success: true, route: "GROQ", message: finalMessage, steps: step + 1 };
      }
    }

    // GPT-OSS 20B nie obsługuje równoległego tool use, więc wykonujemy pierwszy call.
    const toolCall = toolCalls[0];
    const action = toolCall?.function?.name;
    const args = parseToolArguments(toolCall);
    if (!action) throw new Error("Groq zwrócił tool call bez nazwy narzędzia.");

    const risk = getActionRisk(action, args);
    if (risk.risky) {
      const confirmationId = crypto.randomUUID();
      pendingConfirmations.set(confirmationId, {
        action,
        args,
        toolCall,
        assistantMessage: assistantMessageForHistory(aiMessage),
        messages,
        nextStep: step + 1,
      });

      return {
        success: false,
        route: "GROQ",
        requiresConfirmation: true,
        confirmationId,
        confirmation: risk.reason,
        message: aiMessage.content || risk.reason,
      };
    }

    let result;
    try {
      result = await executeCoreAction(action, args);
    } catch (error) {
      result = { message: `BŁĄD narzędzia ${action}: ${error.message}` };
    }

    messages.push(assistantMessageForHistory(aiMessage));
    messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      name: action,
      content: String(result?.message || "OK"),
    });
  }

  const finalMessage = "Zatrzymałem zadanie po osiągnięciu limitu kroków bezpieczeństwa.";
  remember("assistant", finalMessage);
  return { success: false, route: "GROQ", message: finalMessage };
}


function looksLikeActionRequest(text) {
  const value = String(text || "").trim().toLowerCase();
  return /\b(?:otwórz|otworz|odpal|uruchom|włącz|wlacz|wyłącz|wylacz|zamknij|puść|pusc|zagraj|odtwórz|odtworz|ścisz|scisz|podgłośnij|podglosnij|ustaw|kliknij|wpisz|wyszukaj|znajdź|znajdz|wyślij|wyslij|dodaj|usuń|usun)\b/i.test(value);
}

function normalizeLocalAssistantMessage(message) {
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls.map((call, index) => ({
    id: call.id || `local_${crypto.randomUUID()}_${index}`,
    type: "function",
    function: {
      name: call?.function?.name,
      arguments: typeof call?.function?.arguments === "string"
        ? call.function.arguments
        : JSON.stringify(call?.function?.arguments || {}),
    },
  })) : [];
  return { role: "assistant", content: message?.content || "", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
}

async function continueLocalAgent(messages, originalPrompt, startStep = 0) {
  for (let step = startStep; step < MAX_LOCAL_AGENT_STEPS; step += 1) {
    const raw = await callLocalModel(messages, LOCAL_TOOLS);
    const selectedLocalModel = raw?._rezeModel || getCurrentLocalModel();
    sendAgentStatus("local_thinking", { model: selectedLocalModel, step: step + 1 });
    const aiMessage = normalizeLocalAssistantMessage(raw);
    const toolCalls = aiMessage.tool_calls || [];

    if (!toolCalls.length) {
      // Mały Qwen czasem odpowiada tekstem typu „Otwieram Discorda” zamiast
      // faktycznie wywołać narzędzie. Dla polecenia wykonawczego traktujemy to
      // jako nieudaną interpretację i natychmiast przekazujemy zadanie do Groq.
      if (looksLikeActionRequest(originalPrompt)) {
        sendAgentStatus("local_delegate", { reason: "local_no_tool_call" });
        return null;
      }
      const finalMessage = String(aiMessage.content || "Gotowe.").trim() || "Gotowe.";
      remember("assistant", finalMessage);
      return { success: true, route: "LOCAL QWEN", model: selectedLocalModel, message: finalMessage, steps: step + 1 };
    }

    const toolCall = toolCalls[0];
    const action = toolCall.function?.name;
    const args = parseToolArguments(toolCall);
    if (action === "delegate_to_groq") {
      sendAgentStatus("local_delegate", { reason: args.reason || "complex_task" });
      return null;
    }
    if (!action || !GROQ_TOOLS.some((tool) => tool.function.name === action)) {
      return null;
    }

    const risk = getActionRisk(action, args);
    if (risk.risky || ["ui_click", "ui_set_text"].includes(action)) {
      const confirmationId = crypto.randomUUID();
      const reason = risk.risky ? risk.reason : `REZE chce sterować interfejsem Windows: ${action}`;
      pendingConfirmations.set(confirmationId, {
        engine: "LOCAL",
        action,
        args,
        toolCall,
        assistantMessage: aiMessage,
        messages,
        originalPrompt,
        nextStep: step + 1,
      });
      return { success: false, route: "LOCAL QWEN", requiresConfirmation: true, confirmationId, confirmation: reason, message: reason };
    }

    let result;
    try { result = await executeCoreAction(action, args); }
    catch (error) { result = { message: `BŁĄD narzędzia ${action}: ${error.message}` }; }

    messages.push(aiMessage);
    messages.push({ role: "tool", tool_name: action, content: String(result?.message || "OK") });
  }

  sendAgentStatus("local_delegate", { reason: "local_step_limit" });
  return null;
}

async function runGroqAgent(original, persistentSnapshot = null) {
  const persistent = persistentSnapshot || await getContext();
  const historyForRequest = persistent.messages;
  const factsText = persistent.facts.length
    ? `\n\nTRWAŁA PAMIĘĆ UŻYTKOWNIKA (używaj tylko gdy istotna):\n${persistent.facts.map((f) => `- [${f.category}] ${f.text}`).join("\n")}`
    : "";
  const messages = [
    { role: "system", content: `${SYSTEM_PROMPT}${factsText}\n\nAKTUALNY CZAS SYSTEMU: ${new Date().toString()}\nSTREFA CZASOWA: ${Intl.DateTimeFormat().resolvedOptions().timeZone || "local"}` },
    ...historyForRequest,
    { role: "user", content: original },
  ];
  return await continueAgent(messages, 0);
}

async function runHybridAgent(original, persistentSnapshot = null) {
  const persistent = persistentSnapshot || await getContext();
  const status = await getLocalAiStatus();
  if (status.available && status.installed) {
    try {
      const factsText = persistent.facts.length
        ? `\n\nPamięć użytkownika:\n${persistent.facts.slice(-20).map((f) => `- ${f.text}`).join("\n")}`
        : "";
      const messages = [
        { role: "system", content: `${LOCAL_SYSTEM_PROMPT}${factsText}\nAktualny czas: ${new Date().toString()}` },
        ...persistent.messages.slice(-8),
        { role: "user", content: original },
      ];
      const localResult = await continueLocalAgent(messages, original, 0);
      if (localResult) return localResult;
    } catch (error) {
      console.warn("LOCAL AI FALLBACK:", error.message);
      sendAgentStatus("local_error", { message: error.message });
    }
  } else {
    sendAgentStatus("local_unavailable", { model: LOCAL_AI_MODEL, reason: status.reason || (status.available ? "model_not_installed" : "ollama_offline") });
  }

  return await runGroqAgent(original, persistent);
}

ipcMain.handle("agent-command", async (_event, prompt) => {
  try {
    const original = String(prompt || "").trim();
    if (!original) return { success: false, message: "Brak polecenia." };

    const direct = await tryFastRoute(original);
    if (direct) {
      remember("user", original);
      remember("assistant", direct.message);
      return direct;
    }

    const persistent = await getContext();
    remember("user", original);
    return await runHybridAgent(original, persistent);
  } catch (error) {
    console.error("AGENT ERROR:", error);
    return { success: false, route: "HYBRID", message: `Błąd agenta: ${error.message}` };
  }
});

ipcMain.handle("confirm-agent-action", async (_event, confirmationId, approved) => {
  const pending = pendingConfirmations.get(confirmationId);
  if (!pending) return { success: false, message: "To potwierdzenie wygasło albo nie istnieje." };
  pendingConfirmations.delete(confirmationId);

  if (!approved) {
    const message = "Anulowałem ryzykowną akcję.";
    remember("assistant", message);
    return { success: true, route: "CONFIRM", message };
  }

  try {
    const result = await executeCoreAction(pending.action, pending.args);
    if (pending.engine === "GEMINI") {
      const message = String(result?.message || "Gotowe.");
      remember("assistant", message);
      return { success: true, route: "GEMINI LIVE", message };
    }
    const messages = pending.messages;
    messages.push(pending.assistantMessage);
    if (pending.engine === "LOCAL") {
      messages.push({ role: "tool", tool_name: pending.action, content: String(result?.message || "OK") });
      const localResult = await continueLocalAgent(messages, pending.originalPrompt || "", pending.nextStep);
      if (localResult) return localResult;
      return await runGroqAgent(pending.originalPrompt || "Kontynuuj poprzednie zadanie.");
    }
    messages.push({
      role: "tool",
      tool_call_id: pending.toolCall.id,
      name: pending.action,
      content: String(result?.message || "OK"),
    });
    return await continueAgent(messages, pending.nextStep);
  } catch (error) {
    return { success: false, message: `Nie udało się wykonać zatwierdzonej akcji: ${error.message}` };
  }
});

ipcMain.handle("clear-agent-memory", async () => {
  conversationHistory.length = 0;
  await clearPersistentMemory();
  return { success: true, message: "Pamięć rozmowy i trwałe fakty zostały wyczyszczone." };
});

ipcMain.handle("open-app", async (_event, appName) => {
  try { return { success: true, ...(await executeCoreAction("open_app", { appName })) }; }
  catch (error) { return { success: false, message: error.message }; }
});
ipcMain.handle("close-app", async (_event, appName) => {
  try { return { success: true, ...(await executeCoreAction("close_app", { appName })) }; }
  catch (error) { return { success: false, message: error.message }; }
});
ipcMain.handle("set-volume", async (_event, volume) => {
  try { return { success: true, ...(await executeCoreAction("set_volume", { volume })) }; }
  catch (error) { return { success: false, message: error.message }; }
});
ipcMain.handle("mute-volume", async () => ({ success: true, ...(await executeCoreAction("mute_volume")) }));
ipcMain.handle("unmute-volume", async () => ({ success: true, ...(await executeCoreAction("unmute_volume")) }));
ipcMain.handle("change-volume", async (_event, amount) => ({ success: true, ...(await executeCoreAction("change_volume", { amount })) }));
ipcMain.handle("get-system-info", async () => ({ success: true, data: { text: systemInfoMessage() }, message: systemInfoMessage() }));
ipcMain.handle("open-url", async (_event, url) => {
  try { return { success: true, ...(await executeCoreAction("open_url", { url })) }; }
  catch (error) { return { success: false, message: error.message }; }
});


ipcMain.handle("wake-word-start", async () => startWakeWordSidecar());
ipcMain.on("wake-word-audio", (_event, arrayBuffer) => {
  sendWakeWordPcm(arrayBuffer);
});
ipcMain.handle("wake-word-stop", async () => {
  stopWakeWordSidecar();
  return { success: true };
});
ipcMain.handle("wake-word-status", async () => ({
  success: true,
  running: Boolean(wakeWordProcess),
  ready: wakeWordReady,
  lastScore: wakeWordLastScore,
  threshold: REZE_WAKE_THRESHOLD,
  vadThreshold: REZE_WAKE_VAD_THRESHOLD,
}));

ipcMain.handle("gemini-live-start", async () => {
  try { return startGeminiLive(); }
  catch (error) { return { success: false, message: error.message }; }
});

ipcMain.on("gemini-live-audio", (_event, arrayBuffer) => {
  const current = geminiLiveSession;
  if (!current || current.finished || current.audioEnded) return;
  const pcm = Buffer.from(arrayBuffer);
  if (!pcm.length) return;
  current.receivedAudioBytes = (current.receivedAudioBytes || 0) + pcm.length;
  current.receivedAudioChunks = (current.receivedAudioChunks || 0) + 1;
  if (current.ready) sendGeminiPcm(current, pcm);
  else {
    current.audioQueue.push(pcm);
    // Max ~5 seconds of 16 kHz mono PCM while connecting.
    let bytes = current.audioQueue.reduce((sum, item) => sum + item.length, 0);
    while (bytes > 160000 && current.audioQueue.length > 1) {
      bytes -= current.audioQueue.shift().length;
    }
  }
});

ipcMain.handle("gemini-live-end-audio", async () => {
  const current = geminiLiveSession;
  if (!current) return { success: false, message: "Brak aktywnej sesji Gemini Live." };
  current.endRequested = true;
  if (current.ready) sendGeminiAudioEnd(current);
  return { success: true };
});

ipcMain.handle("gemini-live-stop", async () => {
  closeGeminiLive("client_stop");
  return { success: true };
});

ipcMain.handle("gemini-live-status", async () => ({
  success: true,
  configured: Boolean(GEMINI_API_KEY),
  active: Boolean(geminiLiveSession),
  ready: Boolean(geminiLiveSession?.ready),
  model: GEMINI_LIVE_MODEL,
}));

ipcMain.handle("transcribe-audio", async (_event, payload = {}) => {
  try {
    const result = await transcribeAudio(payload.arrayBuffer, payload.mimeType);
    return { success: true, ...result, model: GROQ_STT_MODEL };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle("local-ai-status", async () => {
  return { success: true, ...(await getLocalAiStatus()) };
});

ipcMain.handle("tts-status", async () => {
  try {
    configureTts(app.getPath("userData"));
    return { success: true, ...getTtsEngineStatus() };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle("tts-import-reference", async () => {
  try {
    configureTts(app.getPath("userData"));
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: "Wybierz próbkę głosu REZE",
      properties: ["openFile"],
      filters: [{ name: "Próbka głosu WAV", extensions: ["wav"] }],
    });
    if (picked.canceled || !picked.filePaths?.[0]) return { success: false, canceled: true, message: "Anulowano wybór pliku." };
    return { success: true, ...importTtsReference(picked.filePaths[0]) };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle("tts-synthesize", async (_event, payload = {}) => {
  try {
    configureTts(app.getPath("userData"));
    return await synthesizeTts(payload.text, payload.options || {});
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle("browser-settings", async () => {
  try {
    configureBrowser(app.getPath("userData"));
    return { success: true, ...getBrowserSettings() };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle("browser-set-preferred", async (_event, name) => {
  try {
    configureBrowser(app.getPath("userData"));
    return { success: true, ...(await setPreferredBrowser(name)) };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle("youtube-music-login", async () => {
  try {
    configureBrowser(app.getPath("userData"));
    return { success: true, ...(await youtubeMusicLogin()) };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle("google-status", async () => {
  try { return { success: true, ...(await googleStatus()) }; }
  catch (error) { return { success: false, message: error.message }; }
});

ipcMain.handle("google-connect", async () => {
  try { return { success: true, ...(await googleConnect()) }; }
  catch (error) { return { success: false, message: error.message }; }
});

ipcMain.handle("get-autostart", async () => {
  const settings = app.getLoginItemSettings();
  return { success: true, enabled: Boolean(settings.openAtLogin) };
});

ipcMain.handle("set-autostart", async (_event, enabled) => {
  const settings = loginItemSettings(Boolean(enabled));
  return { success: true, enabled: Boolean(settings.openAtLogin), message: settings.openAtLogin ? "Autostart REZE włączony." : "Autostart REZE wyłączony." };
});

app.whenReady().then(() => {
  configureTts(app.getPath("userData"));
  configureBrowser(app.getPath("userData"));
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === "media");
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });

  createWindow();
  createTray();

  const commandShortcut = globalShortcut.register("Control+Space", () => showMainWindow({ focusInput: true }));
  const voiceShortcut = globalShortcut.register("Control+Shift+Space", () => showMainWindow({ toggleVoice: true }));
  console.log(`GLOBAL SHORTCUT Ctrl+Space: ${commandShortcut ? "OK" : "FAILED"}`);
  console.log(`GLOBAL SHORTCUT Ctrl+Shift+Space: ${voiceShortcut ? "OK" : "FAILED"}`);

  app.on("activate", () => showMainWindow({ focusInput: true }));
});

app.on("before-quit", () => {
  stopWakeWordSidecar(); isQuitting = true; shutdownTts(); });
app.on("will-quit", () => globalShortcut.unregisterAll());

// Na Windows zamknięcie okna tylko chowa REZE do traya.
app.on("window-all-closed", () => {});
