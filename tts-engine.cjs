const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let serverProcess = null;
let serverStarting = null;
let userDataPath = null;

const PORT = Number(process.env.REZE_TTS_PORT || 8765);
const HOST = '127.0.0.1';

function configureTts(basePath) {
  userDataPath = basePath;
}

function getPaths() {
  if (!userDataPath) throw new Error('TTS nie został skonfigurowany.');
  const voiceDir = path.join(userDataPath, 'voices');
  const referencePath = path.join(voiceDir, 'reze-reference.wav');
  const venvPython = process.platform === 'win32'
    ? path.join(__dirname, '.venv-chatterbox', 'Scripts', 'python.exe')
    : path.join(__dirname, '.venv-chatterbox', 'bin', 'python');
  return { voiceDir, referencePath, venvPython };
}

function status() {
  const { referencePath, venvPython } = getPaths();
  return {
    engine: 'chatterbox-multilingual-v3',
    installed: fs.existsSync(venvPython),
    referenceReady: fs.existsSync(referencePath),
    referencePath: fs.existsSync(referencePath) ? referencePath : '',
    running: Boolean(serverProcess && !serverProcess.killed),
    port: PORT,
  };
}

function importReference(sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('Nie znaleziono wybranego pliku audio.');
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext !== '.wav') throw new Error('Na ten moment wybierz plik WAV. Komiko pozwala pobrać próbkę właśnie w WAV.');
  const { voiceDir, referencePath } = getPaths();
  fs.mkdirSync(voiceDir, { recursive: true });
  fs.copyFileSync(sourcePath, referencePath);
  return { ...status(), message: 'Próbka głosu została ustawiona jako głos REZE.' };
}

async function waitForHealth(timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (serverProcess?.exitCode != null) throw new Error('Proces Chatterbox zakończył się podczas uruchamiania.');
    try {
      const response = await fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 650));
  }
  throw new Error('Chatterbox nie uruchomił się na czas. Pierwsze uruchomienie modelu może potrwać dłużej.');
}

async function ensureServer() {
  if (serverProcess && serverProcess.exitCode == null) {
    try {
      const r = await fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
    } catch {}
  }
  if (serverStarting) return serverStarting;

  const { venvPython } = getPaths();
  if (!fs.existsSync(venvPython)) {
    throw new Error('Chatterbox nie jest zainstalowany. Uruchom SETUP-CHATTERBOX.ps1 w katalogu projektu.');
  }

  serverStarting = (async () => {
    const script = path.join(__dirname, 'chatterbox-tts-server.py');
    serverProcess = spawn(venvPython, [script, '--host', HOST, '--port', String(PORT)], {
      cwd: __dirname,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    serverProcess.stdout?.on('data', (d) => console.log('[CHATTERBOX]', String(d).trim()));
    serverProcess.stderr?.on('data', (d) => console.warn('[CHATTERBOX]', String(d).trim()));
    serverProcess.on('exit', (code) => {
      console.log(`[CHATTERBOX] server exit ${code}`);
      serverProcess = null;
    });
    await waitForHealth();
  })();

  try { await serverStarting; }
  finally { serverStarting = null; }
}

async function synthesize(text, options = {}) {
  const input = String(text || '').trim().slice(0, 900);
  if (!input) throw new Error('Brak tekstu do przeczytania.');
  const { referencePath } = getPaths();
  if (!fs.existsSync(referencePath)) throw new Error('Najpierw zaimportuj próbkę WAV głosu REZE.');

  await ensureServer();
  const payload = {
    text: input,
    language_id: 'pl',
    reference_path: referencePath,
    exaggeration: Math.max(0, Math.min(1.5, Number(options.exaggeration ?? 0.45))),
    cfg_weight: Math.max(0, Math.min(1, Number(options.cfgWeight ?? 0.0))),
  };
  const response = await fetch(`http://${HOST}:${PORT}/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Number(process.env.REZE_TTS_TIMEOUT_MS || 180000)),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.audio_base64) throw new Error(data?.error || `Chatterbox HTTP ${response.status}`);
  return {
    success: true,
    audioBase64: data.audio_base64,
    mimeType: 'audio/wav',
    device: data.device || '',
    generationMs: data.generation_ms || 0,
  };
}

function shutdown() {
  if (!serverProcess || serverProcess.exitCode != null) return;
  try { serverProcess.kill(); } catch {}
  serverProcess = null;
}

module.exports = { configureTts, status, importReference, synthesize, shutdown };
