const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

let context = null;
let page = null;
let activeBrowserName = null;
let userDataPath = null;
let settingsCache = null;
let musicPlayInFlight = null;
let lastMusicPlayKey = '';
let lastMusicPlayAt = 0;

function requirePlaywright() {
  try {
    return require('playwright-core');
  } catch {
    throw new Error('Brak playwright-core. Uruchom raz: npm install');
  }
}

function configureBrowser(basePath) {
  userDataPath = basePath;
  settingsCache = null;
}

function browserCandidates() {
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return {
    brave: [
      path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(pf86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ],
    chrome: [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    edge: [
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
  };
}

function normalizeBrowserName(name) {
  const value = String(name || '').trim().toLowerCase();
  if (!value || ['auto', 'default', 'domyślna', 'domyslna'].includes(value)) return 'auto';
  if (value.includes('brave')) return 'brave';
  if (value.includes('chrome')) return 'chrome';
  if (value.includes('edge')) return 'edge';
  return value;
}

function settingsPath() {
  if (!userDataPath) return '';
  return path.join(userDataPath, 'browser-settings.json');
}

function readSettings() {
  if (settingsCache) return settingsCache;
  const file = settingsPath();
  let selected = 'auto';
  if (file && fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      selected = normalizeBrowserName(data?.selectedBrowser || 'auto');
    } catch {}
  }
  settingsCache = { selectedBrowser: selected };
  return settingsCache;
}

function writeSettings(next) {
  settingsCache = { ...readSettings(), ...next };
  const file = settingsPath();
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settingsCache, null, 2), 'utf8');
  }
  return settingsCache;
}

function installedBrowsers() {
  const candidates = browserCandidates();
  return ['brave', 'chrome', 'edge'].map((name) => ({
    name,
    installed: Boolean((candidates[name] || []).find((item) => item && fs.existsSync(item))),
  }));
}

function getBrowserSettings() {
  return {
    ...readSettings(),
    activeBrowser: activeBrowserName,
    browsers: installedBrowsers(),
    persistentSession: true,
  };
}

async function setPreferredBrowser(name) {
  const normalized = normalizeBrowserName(name);
  if (!['auto', 'brave', 'chrome', 'edge'].includes(normalized)) throw new Error(`Nieobsługiwana przeglądarka: ${name}`);
  if (normalized !== 'auto') findBrowserExecutable(normalized);
  writeSettings({ selectedBrowser: normalized });

  if (context && activeBrowserName && normalized !== 'auto' && activeBrowserName !== normalized) {
    await closeContext();
  }
  return getBrowserSettings();
}

function findBrowserExecutable(requestedName = 'auto') {
  let requested = normalizeBrowserName(requestedName);
  if (requested === 'auto') {
    const preferred = normalizeBrowserName(readSettings().selectedBrowser);
    if (preferred !== 'auto') requested = preferred;
  }
  const candidates = browserCandidates();
  const order = requested === 'auto' ? ['brave', 'chrome', 'edge'] : [requested];
  for (const name of order) {
    const executablePath = (candidates[name] || []).find((item) => item && fs.existsSync(item));
    if (executablePath) return { name, executablePath };
  }
  if (requested !== 'auto') throw new Error(`Nie znaleziono przeglądarki ${requestedName}.`);
  throw new Error('Nie znaleziono Brave, Chrome ani Microsoft Edge.');
}

function profileDir(browserName) {
  const base = userDataPath || path.join(process.cwd(), '.reze-browser-data');
  return path.join(base, 'browser-profiles', browserName);
}

async function closeContext() {
  if (context) await context.close().catch(() => {});
  context = null;
  page = null;
  activeBrowserName = null;
}

async function ensurePage(browserName = 'auto') {
  const requested = normalizeBrowserName(browserName);
  const resolved = findBrowserExecutable(requested);
  const wantsDifferentBrowser = activeBrowserName && activeBrowserName !== resolved.name;

  if (page && !page.isClosed() && !wantsDifferentBrowser) return page;
  if (context && wantsDifferentBrowser) await closeContext();

  const { chromium } = requirePlaywright();
  const persistentDir = profileDir(resolved.name);
  fs.mkdirSync(persistentDir, { recursive: true });

  context = await chromium.launchPersistentContext(persistentDir, {
    headless: false,
    executablePath: resolved.executablePath,
    viewport: null,
    args: ['--start-maximized'],
  });
  activeBrowserName = resolved.name;
  const pages = context.pages();
  page = pages[0] || await context.newPage();
  page.on('close', () => {
    if (page?.isClosed()) page = context?.pages()?.find((item) => !item.isClosed()) || null;
  });
  return page;
}

function normalizeUrl(url) {
  const value = String(url || '').trim();
  if (!value) throw new Error('Brak adresu URL.');
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

async function browserStart(browserName = 'auto') {
  const current = await ensurePage(browserName);
  return { browser: activeBrowserName, url: current.url(), title: await current.title(), persistentSession: true };
}

async function browserOpen(url, browserName = 'auto') {
  const current = await ensurePage(browserName);
  const target = normalizeUrl(url);
  await current.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return { browser: activeBrowserName, url: current.url(), title: await current.title() };
}

async function browserSearch(query, browserName = 'auto') {
  const value = String(query || '').trim();
  if (!value) throw new Error('Brak zapytania do wyszukania.');
  const current = await ensurePage(browserName);
  const engine = activeBrowserName === 'brave'
    ? 'https://search.brave.com/search?q='
    : activeBrowserName === 'edge'
      ? 'https://www.bing.com/search?q='
      : 'https://www.google.com/search?q=';
  const target = `${engine}${encodeURIComponent(value)}`;
  await current.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return { browser: activeBrowserName, query: value, url: current.url(), title: await current.title() };
}

async function browserSnapshot() {
  const current = await ensurePage();
  const data = await current.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')]
      .filter(visible)
      .slice(0, 55)
      .map((el, index) => {
        const ref = `reze-${index}`;
        el.setAttribute('data-reze-agent-ref', ref);
        return ({
          ref,
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 100),
          href: el.href || '',
          type: el.getAttribute('type') || '',
          name: el.getAttribute('name') || '',
          placeholder: el.getAttribute('placeholder') || '',
        });
      });
    return {
      title: document.title,
      url: location.href,
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 3500),
      elements,
    };
  });
  return data;
}

async function locatorFor(current, target) {
  const value = String(target || '').trim();
  if (!value) throw new Error('Brak celu elementu.');
  if (/^reze-\d+$/i.test(value)) return current.locator(`[data-reze-agent-ref="${value}"]`);
  if (/^(css=|xpath=|text=|role=)/i.test(value) || value.startsWith('#') || value.startsWith('.') || value.startsWith('[')) {
    return current.locator(value.replace(/^css=/i, ''));
  }
  const byPlaceholder = current.getByPlaceholder(value, { exact: false });
  if (await byPlaceholder.count()) return byPlaceholder;
  const byLabel = current.getByLabel(value, { exact: false });
  if (await byLabel.count()) return byLabel;
  return current.getByText(value, { exact: false });
}

async function browserClick(target) {
  const current = await ensurePage();
  const locator = await locatorFor(current, target);
  await locator.first().click({ timeout: 10000 });
  return { url: current.url(), title: await current.title() };
}

async function browserType(target, text, submit = false) {
  const current = await ensurePage();
  const locator = await locatorFor(current, target);
  await locator.first().fill(String(text));
  if (submit) await locator.first().press('Enter');
  return { url: current.url(), title: await current.title() };
}

async function browserPress(key) {
  const current = await ensurePage();
  await current.keyboard.press(String(key));
  return { url: current.url(), title: await current.title() };
}

async function youtubeMusicLogin(browserName = 'auto') {
  const current = await ensurePage(browserName);
  await current.goto('https://music.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  return {
    browser: activeBrowserName,
    url: current.url(),
    title: await current.title(),
    message: 'YouTube Music otwarty w trwałym profilu REZE. Jeśli trzeba, zaloguj się raz — sesja zostanie zachowana.',
  };
}

function scoreText(text, query) {
  const hay = String(text || '').toLowerCase();
  const tokens = String(query || '').toLowerCase().split(/\s+/).filter((token) => token.length >= 2);
  return tokens.reduce((score, token) => score + (hay.includes(token) ? 1 : 0), 0);
}

function browserProcessName(browserName) {
  if (browserName === 'brave') return 'brave';
  if (browserName === 'edge') return 'msedge';
  return 'chrome';
}

async function resolveYouTubeVideoId(query, mode = 'song') {
  const searchText = mode === 'artist'
    ? `${query} official music`
    : `${query} official audio`;
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchText)}`;
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      'accept-language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    signal: AbortSignal.timeout(6500),
  });
  if (!response.ok) throw new Error(`YouTube search HTTP ${response.status}`);
  const html = await response.text();
  const ids = [];
  for (const match of html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)) {
    if (!ids.includes(match[1])) ids.push(match[1]);
    if (ids.length >= 8) break;
  }
  if (!ids.length) throw new Error('YouTube nie zwrócił identyfikatora utworu.');
  if (mode === 'artist' && ids.length > 1) {
    return ids[Math.floor(Math.random() * Math.min(ids.length, 5))];
  }
  return ids[0];
}

async function navigateNativeBrowser(url, browserName = 'auto') {
  const resolved = findBrowserExecutable(browserName);
  const processName = browserProcessName(resolved.name);
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$targetUrl = ${JSON.stringify(url)}
$procName = ${JSON.stringify(processName)}
$procs = Get-Process -Name $procName | Where-Object { $_.MainWindowHandle -ne 0 }
$wsh = New-Object -ComObject WScript.Shell

function Get-CurrentBrowserUrl {
  try {
    [System.Windows.Forms.SendKeys]::SendWait('^l')
    Start-Sleep -Milliseconds 45
    [System.Windows.Forms.SendKeys]::SendWait('^c')
    Start-Sleep -Milliseconds 45
    return [System.Windows.Forms.Clipboard]::GetText().Trim()
  } catch {
    return ''
  }
}

function Confirm-LeavePage([IntPtr]$handle, [int]$processId) {
  # Chromium renderuje beforeunload jako "tab-modal", który nie zawsze jest
  # potomkiem MainWindowHandle w drzewie UIA. Dlatego skanujemy cały pulpit,
  # ale ograniczamy elementy do procesu konkretnej przeglądarki.
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class RezeMouse {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@ -ErrorAction SilentlyContinue

  for ($try = 0; $try -lt 28; $try++) {
    Start-Sleep -Milliseconds 80
    try {
      $desktop = [System.Windows.Automation.AutomationElement]::RootElement
      $pidCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
        $processId
      )
      $all = $desktop.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $pidCondition
      )

      $hasLeaveDialog = $false
      $leaveButton = $null
      foreach ($el in $all) {
        try {
          $name = ([string]$el.Current.Name).Trim()
          if ($name -match 'Opuścić stronę|Opuscic strone|Leave site|Leave page|changes.*not.*saved|zmiany.*nie.*zostać.*zapisane|zmiany.*nie.*zostac.*zapisane') {
            $hasLeaveDialog = $true
          }
          if ($name -match '^(Wyjdź|Wyjdz|Opuść|Opusc|Leave|Exit|Discard)$') {
            $leaveButton = $el
          }
        } catch {}
      }

      # Sam przycisk "Wyjdź" w procesie Chromium jest wystarczająco mocnym
      # sygnałem, bo funkcja jest wywoływana tylko tuż po zmianie URL w YTM.
      if ($leaveButton) {
        $pattern = $null
        if ($leaveButton.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
          ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
          Start-Sleep -Milliseconds 120
          return $true
        }

        # Część wersji Brave nie udostępnia InvokePattern dla tego przycisku.
        # Klikamy wtedy jego faktyczny środek z UI Automation.
        try {
          $rect = $leaveButton.Current.BoundingRectangle
          if ($rect.Width -gt 2 -and $rect.Height -gt 2) {
            $x = [int]($rect.Left + ($rect.Width / 2))
            $y = [int]($rect.Top + ($rect.Height / 2))
            [RezeMouse]::SetCursorPos($x, $y) | Out-Null
            [RezeMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
            [RezeMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 120
            return $true
          }
        } catch {}
      }

      # Na screenie Brave domyślnie fokusuje "Wyjdź". Enter wysyłamy dopiero,
      # gdy naprawdę znaleźliśmy tekst dialogu w procesie przeglądarki.
      if ($hasLeaveDialog) {
        $wsh.AppActivate($processId) | Out-Null
        Start-Sleep -Milliseconds 60
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        Start-Sleep -Milliseconds 120
        return $true
      }
    } catch {}
  }
  return $false
}

function Open-InCurrentTab([System.Diagnostics.Process]$p) {
  # Wypisujemy marker PRZED nawigacją. Dzięki temu Node wie, że istniejąca
  # karta YTM została znaleziona nawet jeśli później UIA/dialog się przytnie.
  Write-Output 'FOUND_YTM'
  [System.Windows.Forms.SendKeys]::SendWait('^l')
  Start-Sleep -Milliseconds 45
  [System.Windows.Forms.Clipboard]::SetText($targetUrl)
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  $confirmed = Confirm-LeavePage $p.MainWindowHandle $p.Id
  if ($confirmed) { Write-Output 'REUSED_TAB_CONFIRMED'; return }
  Write-Output 'REUSED_TAB'
}

# Najpierw próbujemy znaleźć JUŻ OTWARTĄ kartę music.youtube.com w normalnym
# profilu użytkownika. Tytuł karty podczas odtwarzania jest nazwą piosenki,
# więc nie można polegać na MainWindowTitle. Skanujemy URL-e kart przez omnibox.
foreach ($p in $procs) {
  if (-not $wsh.AppActivate($p.Id)) { continue }
  Start-Sleep -Milliseconds 100

  $startUrl = Get-CurrentBrowserUrl
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  if ($startUrl -match '^https?://music\.youtube\.com/') {
    Open-InCurrentTab $p
    return
  }

  $advanced = 0
  for ($i = 0; $i -lt 12; $i++) {
    [System.Windows.Forms.SendKeys]::SendWait('^{TAB}')
    $advanced++
    Start-Sleep -Milliseconds 55
    $tabUrl = Get-CurrentBrowserUrl
    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')

    if ($tabUrl -match '^https?://music\.youtube\.com/') {
      Open-InCurrentTab $p
      return
    }
    if ($i -gt 0 -and $tabUrl -and $startUrl -and $tabUrl -eq $startUrl) { break }
  }

  # Nie znaleziono YTM w tym oknie — wracamy do pierwotnej karty, żeby nie
  # zostawiać użytkownikowi przeglądarki w losowym miejscu.
  for ($j = 0; $j -lt $advanced; $j++) {
    [System.Windows.Forms.SendKeys]::SendWait('^+{TAB}')
    Start-Sleep -Milliseconds 25
  }
}

'NEW'
`;
  let reused = false;
  let confirmedLeave = false;
  let shouldOpenNew = false;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      // UI Automation w Chromium bywa wolne. Wcześniej timeout mógł nastąpić
      // JUŻ PO zmianie karty, a JS uruchamiał jeszcze drugi URL -> 2 karty.
      timeout: 12000,
      windowsHide: true,
    });
    const result = String(stdout || '').trim();
    reused = result.includes('FOUND_YTM') || result.includes('REUSED_TAB');
    confirmedLeave = result.includes('CONFIRMED');
    // Nową kartę otwieramy tylko wtedy, gdy skrypt jednoznacznie stwierdził,
    // że nie ma otwartej karty YouTube Music. Nigdy jako fallback po timeout.
    shouldOpenNew = /(^|\r?\n)NEW(\r?\n|$)/.test(result);
  } catch (error) {
    // execFile przy timeout może zwrócić częściowy stdout. To kluczowe:
    // jeżeli zdążyliśmy znaleźć istniejącą kartę YTM, NIE otwieramy drugiej.
    // Jeżeli marker FOUND_YTM nie padł, bezpiecznie otwieramy URL normalnie,
    // żeby komenda nie kończyła się teraz kompletnym brakiem reakcji.
    const partial = String(error?.stdout || '');
    reused = partial.includes('FOUND_YTM') || partial.includes('REUSED_TAB');
    confirmedLeave = partial.includes('CONFIRMED');
    shouldOpenNew = !reused;
  }

  if (shouldOpenNew) {
    // Uruchomienie exe z URL-em korzysta z normalnego profilu użytkownika.
    const child = require('child_process').spawn(resolved.executablePath, [url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
  }
  return {
    browser: resolved.name,
    reusedExistingYouTubeMusic: reused,
    confirmedLeaveDialog: confirmedLeave,
  };
}

async function youtubeMusicLogin(browserName = 'auto') {
  const resolved = findBrowserExecutable(browserName);
  const opened = await navigateNativeBrowser('https://music.youtube.com/', resolved.name);
  return {
    browser: resolved.name,
    url: 'https://music.youtube.com/',
    title: 'YouTube Music',
    nativeProfile: true,
    reusedExistingYouTubeMusic: opened.reusedExistingYouTubeMusic,
    message: 'YouTube Music otwarty w Twoim normalnym profilu przeglądarki. Logowanie Google powinno działać normalnie.',
  };
}

async function youtubeMusicPlay(query, browserName = 'auto', mode = 'song') {
  const value = String(query || '').trim();
  if (!value) throw new Error('Brak tytułu lub wykonawcy do odtworzenia.');

  // Ochrona przed podwójnym wysłaniem tej samej komendy przez STT/UI.
  // Jeśli identyczne żądanie wpadnie drugi raz w krótkim odstępie, korzysta
  // z już rozpoczętej operacji zamiast otwierać kolejną kartę.
  const key = `${String(mode || 'song').toLowerCase()}::${value.toLowerCase()}`;
  const now = Date.now();
  if (musicPlayInFlight && key === lastMusicPlayKey && now - lastMusicPlayAt < 4000) {
    return musicPlayInFlight;
  }

  lastMusicPlayKey = key;
  lastMusicPlayAt = now;

  musicPlayInFlight = (async () => {
    const resolved = findBrowserExecutable(browserName);
    let videoId;
    try {
      videoId = await resolveYouTubeVideoId(value, mode);
    } catch (error) {
      throw new Error(`Nie udało się szybko znaleźć utworu: ${error.message}`);
    }

    const target = `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}&autoplay=1`;
    const opened = await navigateNativeBrowser(target, resolved.name);

    return {
      browser: resolved.name,
      query: value,
      mode,
      track: value,
      url: target,
      nativeProfile: true,
      reusedExistingYouTubeMusic: opened.reusedExistingYouTubeMusic,
      loginMayBeRequired: false,
    };
  })();

  try {
    return await musicPlayInFlight;
  } finally {
    if (key === lastMusicPlayKey) musicPlayInFlight = null;
  }
}

async function browserClose() {
  await closeContext();
  return 'Przeglądarka automatyzacji REZE została zamknięta.';
}

module.exports = {
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
};
