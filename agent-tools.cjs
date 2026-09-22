const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { app, shell, desktopCapturer, clipboard, screen } = require("electron");

const execFileAsync = promisify(execFile);

let programCatalogCache = null;
let programCatalogBuiltAt = 0;
const PROGRAM_CATALOG_TTL_MS = 5 * 60 * 1000;

function getPaths() {
  return {
    HOME: app.getPath("home") || os.homedir(),
    DESKTOP: app.getPath("desktop"),
    DOWNLOADS: app.getPath("downloads"),
    DOCUMENTS: app.getPath("documents"),
  };
}

function expandPath(input = "") {
  const { HOME, DESKTOP, DOWNLOADS, DOCUMENTS } = getPaths();
  const aliases = {
    desktop: DESKTOP,
    pulpit: DESKTOP,
    downloads: DOWNLOADS,
    pobrane: DOWNLOADS,
    documents: DOCUMENTS,
    dokumenty: DOCUMENTS,
    home: HOME,
  };

  const raw = String(input).trim();
  const normalized = raw.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();

  if (aliases[lower]) return aliases[lower];

  for (const [alias, root] of Object.entries(aliases)) {
    if (lower.startsWith(alias + "/")) {
      const rest = normalized.slice(alias.length + 1);
      return path.join(root, ...rest.split("/").filter(Boolean));
    }
  }

  if (normalized.startsWith("~/")) {
    return path.join(HOME, ...normalized.slice(2).split("/").filter(Boolean));
  }

  return path.resolve(raw || HOME);
}

function assertSafePath(input) {
  const { HOME, DESKTOP, DOWNLOADS, DOCUMENTS } = getPaths();
  const roots = [HOME, DESKTOP, DOWNLOADS, DOCUMENTS]
    .filter(Boolean)
    .map((p) => path.resolve(p).toLowerCase());

  const resolved = expandPath(input);
  const lower = resolved.toLowerCase();

  if (!roots.some((root) => lower === root || lower.startsWith(root + path.sep))) {
    throw new Error("Dostęp do tej lokalizacji jest zablokowany. Dozwolony jest katalog użytkownika.");
  }

  return resolved;
}

async function listFiles(dir = "home") {
  const target = assertSafePath(dir);
  const entries = await fs.readdir(target, { withFileTypes: true });
  return entries.slice(0, 200).map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "folder" : "file",
    path: path.join(target, entry.name),
  }));
}

async function findFiles({ dir = "home", query = "", extension = "", limit = 30 }) {
  const root = assertSafePath(dir);
  const needle = String(query || "").toLowerCase();
  const ext = String(extension || "").toLowerCase().replace(/^\./, "");
  const maxResults = Math.max(1, Math.min(100, Number(limit) || 30));
  const results = [];

  async function walk(current, depth) {
    if (depth > 4) return;

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (!["node_modules", ".git", "AppData"].includes(entry.name)) {
          await walk(full, depth + 1);
        }
        continue;
      }

      const name = entry.name.toLowerCase();
      const matchesName = !needle || name.includes(needle);
      const matchesExt = !ext || name.endsWith(`.${ext}`);
      if (!matchesName || !matchesExt) continue;

      try {
        const stat = await fs.stat(full);
        results.push({
          name: entry.name,
          path: full,
          modifiedAt: stat.mtime.toISOString(),
          sizeBytes: stat.size,
        });
      } catch {
        // Pomijamy plik, którego metadanych nie da się odczytać.
      }
    }
  }

  await walk(root, 0);

  results.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  return results.slice(0, maxResults);
}

async function readFile(filePath) {
  const target = assertSafePath(filePath);
  const stat = await fs.stat(target);
  if (stat.size > 1024 * 1024) throw new Error("Plik jest większy niż 1 MB.");
  return await fs.readFile(target, "utf8");
}

async function writeFile({ filePath, content = "", overwrite = false }) {
  const target = assertSafePath(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });

  if (!overwrite) {
    try {
      await fs.access(target);
      throw new Error("Plik już istnieje. Nadpisanie wymaga potwierdzenia.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  await fs.writeFile(target, String(content), "utf8");
  return target;
}

async function openFile(filePath) {
  const target = assertSafePath(filePath);
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return target;
}

function normalizeProgramName(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreProgramMatch(query, candidate) {
  const q = normalizeProgramName(query);
  const c = normalizeProgramName(candidate);
  if (!q || !c) return 0;
  if (c === q) return 1000;
  if (c.startsWith(q)) return 800 - Math.max(0, c.length - q.length);
  if (c.includes(q)) return 650 - Math.max(0, c.length - q.length);

  const qWords = q.split(/\s+/).filter(Boolean);
  const cWords = c.split(/\s+/).filter(Boolean);
  const matched = qWords.filter((word) => cWords.some((candidateWord) => candidateWord.startsWith(word))).length;
  if (matched === qWords.length) return 500 + matched * 10;
  return matched * 50;
}

async function readStartApps() {
  const script = `
$apps = Get-StartApps | Select-Object Name, AppID
$apps | ConvertTo-Json -Compress
`;

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 10000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }
    );

    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout.trim());
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter((item) => item?.Name && item?.AppID)
      .map((item) => ({
        name: String(item.Name),
        appId: String(item.AppID),
        source: "start_apps",
      }));
  } catch (error) {
    console.warn("Nie udało się pobrać Get-StartApps:", error.message);
    return [];
  }
}

async function scanShortcutDirectory(root, source) {
  const results = [];
  if (!root) return results;

  async function walk(current, depth) {
    if (depth > 5) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }

      if (!entry.name.toLowerCase().endsWith(".lnk")) continue;
      results.push({
        name: path.basename(entry.name, path.extname(entry.name)),
        shortcutPath: full,
        source,
      });
    }
  }

  await walk(root, 0);
  return results;
}

async function buildProgramCatalog(force = false) {
  const now = Date.now();
  if (!force && programCatalogCache && now - programCatalogBuiltAt < PROGRAM_CATALOG_TTL_MS) {
    return programCatalogCache;
  }

  const startMenuUser = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs");
  const startMenuAll = path.join(process.env.ProgramData || "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs");

  const [startApps, userShortcuts, allShortcuts] = await Promise.all([
    readStartApps(),
    scanShortcutDirectory(startMenuUser, "user_start_menu"),
    scanShortcutDirectory(startMenuAll, "all_start_menu"),
  ]);

  const seen = new Set();
  const catalog = [];
  for (const item of [...startApps, ...userShortcuts, ...allShortcuts]) {
    const key = `${normalizeProgramName(item.name)}|${item.appId || item.shortcutPath || ""}`;
    if (!normalizeProgramName(item.name) || seen.has(key)) continue;
    seen.add(key);
    catalog.push(item);
  }

  programCatalogCache = catalog;
  programCatalogBuiltAt = now;
  return catalog;
}

async function findProgram({ name, limit = 8, refresh = false } = {}) {
  const query = String(name || "").trim();
  if (!query) throw new Error("Podaj nazwę programu do wyszukania.");

  const catalog = await buildProgramCatalog(Boolean(refresh));
  const maxResults = Math.max(1, Math.min(20, Number(limit) || 8));

  return catalog
    .map((item) => ({ ...item, score: scoreProgramMatch(query, item.name) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "pl"))
    .slice(0, maxResults);
}

async function openProgram(name) {
  const matches = await findProgram({ name, limit: 5 });
  if (!matches.length || matches[0].score < 450) {
    // Jedna próba z odświeżonym katalogiem, gdy aplikację zainstalowano niedawno.
    const refreshed = await findProgram({ name, limit: 5, refresh: true });
    if (!refreshed.length || refreshed[0].score < 450) {
      throw new Error(`Nie znalazłem pewnego dopasowania programu: ${name}`);
    }
    matches.length = 0;
    matches.push(...refreshed);
  }

  const selected = matches[0];

  if (selected.shortcutPath) {
    const error = await shell.openPath(selected.shortcutPath);
    if (error) throw new Error(error);
    return selected;
  }

  if (selected.appId) {
    await new Promise((resolve, reject) => {
      execFile(
        "explorer.exe",
        [`shell:AppsFolder\\${selected.appId}`],
        { windowsHide: false },
        (error) => (error ? reject(error) : resolve())
      );
    });
    return selected;
  }

  throw new Error(`Nie wiem jak uruchomić program: ${selected.name}`);
}

async function runProgram(program, args = []) {
  const allowed = new Set([
    "notepad.exe",
    "calc.exe",
    "mspaint.exe",
    "explorer.exe",
    "cmd.exe",
  ]);
  const exe = String(program).toLowerCase();
  if (!allowed.has(exe)) throw new Error(`Program ${program} nie jest jeszcze na liście dozwolonych.`);
  execFile(program, Array.isArray(args) ? args.map(String) : [], { windowsHide: false });
  return program;
}

async function runPowerShell(command) {
  const text = String(command).trim();
  const blocked = /\b(Remove-Item|rm\b|del\b|erase\b|Format-|Clear-Disk|Initialize-Disk|Stop-Computer|Restart-Computer|Set-ExecutionPolicy|Invoke-Expression|iex\b|Start-Process|New-LocalUser|Set-LocalUser|net\s+user|reg\s+(add|delete)|shutdown)\b/i;
  const allowedStart = /^(Get-|Test-Path\b|Resolve-Path\b|Measure-Object\b|Select-Object\b|Where-Object\b|Sort-Object\b)/i;

  if (blocked.test(text) || !allowedStart.test(text)) {
    throw new Error("Ta komenda PowerShell jest zablokowana przez warstwę bezpieczeństwa.");
  }

  const { stdout, stderr } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", text],
    { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true }
  );

  return (stdout || stderr || "Brak wyniku.").trim();
}

async function captureScreenPng() {
  const display = screen.getPrimaryDisplay();
  const width = Math.max(800, Math.round(display?.bounds?.width || 1920));
  const height = Math.max(600, Math.round(display?.bounds?.height || 1080));
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  });
  if (!sources.length) throw new Error("Nie znaleziono ekranu do przechwycenia.");
  const source = sources[0];
  return {
    png: source.thumbnail.toPNG(),
    width: source.thumbnail.getSize().width,
    height: source.thumbnail.getSize().height,
  };
}

async function captureScreenDataUrl() {
  const shot = await captureScreenPng();
  return {
    dataUrl: `data:image/png;base64,${shot.png.toString("base64")}`,
    width: shot.width,
    height: shot.height,
  };
}

async function takeScreenshot(targetPath = "") {
  const { DESKTOP } = getPaths();
  const defaultName = `reze-screenshot-${Date.now()}.png`;
  const finalPath = targetPath ? assertSafePath(targetPath) : path.join(DESKTOP, defaultName);
  const shot = await captureScreenPng();
  await fs.writeFile(finalPath, shot.png);
  return finalPath;
}

async function mouseClick({ x, y, button = "left" }) {
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error("Nieprawidłowe współrzędne myszy.");

  const left = String(button).toLowerCase() !== "right";
  const down = left ? "0x0002" : "0x0008";
  const up = left ? "0x0004" : "0x0010";
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MouseNative {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
'@
[MouseNative]::SetCursorPos(${px}, ${py}) | Out-Null
Start-Sleep -Milliseconds 80
[MouseNative]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)
[MouseNative]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)
`;

  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 5000,
    windowsHide: true,
  });
  return `Kliknięto ${button} przy (${px}, ${py}).`;
}

async function typeText(text) {
  clipboard.writeText(String(text));
  const script = `$wshell = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 100; $wshell.SendKeys('^v')`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 5000,
    windowsHide: true,
  });
  return "Wpisano tekst przez schowek.";
}

async function pressKey(combo) {
  const raw = String(combo || "").trim();
  const normalized = raw.toUpperCase().replace(/\s+/g, "");
  const special = {
    ENTER: "{ENTER}", TAB: "{TAB}", ESC: "{ESC}", ESCAPE: "{ESC}", SPACE: " ",
    BACKSPACE: "{BACKSPACE}", DELETE: "{DELETE}", DEL: "{DELETE}", INSERT: "{INSERT}",
    HOME: "{HOME}", END: "{END}", PAGEUP: "{PGUP}", PAGEDOWN: "{PGDN}",
    UP: "{UP}", DOWN: "{DOWN}", LEFT: "{LEFT}", RIGHT: "{RIGHT}",
  };

  function keyToken(key) {
    if (special[key]) return special[key];
    if (/^F(?:[1-9]|1[0-2])$/.test(key)) return `{${key}}`;
    if (/^[A-Z0-9]$/.test(key)) return key.toLowerCase();
    throw new Error(`Nieobsługiwany klawisz: ${key}`);
  }

  const parts = normalized.split("+").filter(Boolean);
  const modifiers = new Set(parts.slice(0, -1));
  const key = parts[parts.length - 1];
  if (!key) throw new Error("Brak klawisza.");
  if ([...modifiers].some((m) => !["CTRL", "CONTROL", "ALT", "SHIFT"].includes(m))) {
    throw new Error("Nieobsługiwany skrót klawiaturowy.");
  }

  let sendKeys = keyToken(key);
  let prefix = "";
  if (modifiers.has("CTRL") || modifiers.has("CONTROL")) prefix += "^";
  if (modifiers.has("ALT")) prefix += "%";
  if (modifiers.has("SHIFT")) prefix += "+";
  sendKeys = prefix + sendKeys;

  const escaped = sendKeys.replace(/'/g, "''");
  const script = `$wshell = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 80; $wshell.SendKeys('${escaped}')`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 5000,
    windowsHide: true,
  });
  return `Wysłano klawisz: ${normalized}`;
}

function getActionRisk(action, args = {}) {
  if (action === "write_file" && args.overwrite) {
    return { risky: true, reason: `REZE chce nadpisać plik: ${args.path}` };
  }

  if (action === "press_key" && String(args.combo).toUpperCase().includes("ALT+F4")) {
    return { risky: true, reason: "REZE chce zamknąć aktywne okno skrótem Alt+F4." };
  }

  if (["mouse_click", "type_text", "press_key", "ui_click", "ui_set_text"].includes(action)) {
    return { risky: true, reason: `REZE chce sterować komputerem: ${action}` };
  }

  if (["browser_click", "browser_type", "browser_press"].includes(action)) {
    return { risky: true, reason: `REZE chce wykonać akcję na stronie WWW: ${action}` };
  }

  if (action === "gmail_send") {
    return { risky: true, reason: `REZE chce wysłać e-mail do ${args.to || "odbiorcy"} z tematem „${args.subject || "(bez tematu)"}”.` };
  }

  if (action === "calendar_create") {
    return { risky: true, reason: `REZE chce dodać wydarzenie do kalendarza: ${args.summary || "wydarzenie"} (${args.start || "brak daty"}).` };
  }

  if (action === "calendar_delete") {
    return { risky: true, reason: `REZE chce usunąć wydarzenie z Kalendarza Google (ID: ${args.id || "?"}).` };
  }

  return { risky: false, reason: "" };
}

async function executeAgentAction(action, args = {}) {
  switch (action) {
    case "list_files": return { message: JSON.stringify(await listFiles(args.dir), null, 2) };
    case "find_files": return { message: JSON.stringify(await findFiles(args), null, 2) };
    case "read_file": return { message: await readFile(args.path) };
    case "write_file": return { message: `Zapisano: ${await writeFile({ filePath: args.path, content: args.content, overwrite: args.overwrite })}` };
    case "open_file": return { message: `Otwieram: ${await openFile(args.path)}` };
    case "find_program": return { message: JSON.stringify(await findProgram({ name: args.name, limit: args.limit, refresh: args.refresh }), null, 2) };
    case "open_program": {
      const opened = await openProgram(args.name);
      return { message: `Uruchomiono: ${opened.name}` };
    }
    case "run_program": return { message: `Uruchamiam: ${await runProgram(args.program, args.args)}` };
    case "run_powershell": return { message: await runPowerShell(args.command) };
    case "take_screenshot": return { message: `Screenshot zapisany: ${await takeScreenshot(args.path)}` };
    case "mouse_click": return { message: await mouseClick(args) };
    case "type_text": return { message: await typeText(args.text) };
    case "press_key": return { message: await pressKey(args.combo) };
    default: return null;
  }
}

module.exports = {
  executeAgentAction,
  getActionRisk,
  captureScreenDataUrl,
};
