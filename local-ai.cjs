const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const DEFAULT_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const MODE = String(process.env.LOCAL_AI_MODE || 'auto').toLowerCase();
const HEAVY_MODEL = process.env.LOCAL_AI_HEAVY_MODEL || 'qwen3:4b';
const LIGHT_MODEL = process.env.LOCAL_AI_LIGHT_MODEL || process.env.LOCAL_AI_MODEL || 'qwen3:1.7b';
const KEEP_ALIVE = process.env.LOCAL_AI_KEEP_ALIVE || '90s';
const VRAM_DOWN_MB = Number(process.env.LOCAL_AI_VRAM_DOWN_MB || 3800);
const VRAM_UP_MB = Number(process.env.LOCAL_AI_VRAM_UP_MB || 5200);
const RAM_DOWN_MB = Number(process.env.LOCAL_AI_RAM_DOWN_MB || 5000);
const UPGRADE_DELAY_MS = Number(process.env.LOCAL_AI_UPGRADE_DELAY_MS || 30000);

let activeModel = MODE === 'light' ? LIGHT_MODEL : HEAVY_MODEL;
let upgradeCandidateSince = 0;
let lastResourceState = null;

function url(path) { return `${DEFAULT_HOST.replace(/\/$/, '')}${path}`; }

async function fetchWithTimeout(resource, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(resource, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function queryNvidiaVram() {
  if (process.platform !== 'win32') return null;
  try {
    const gpu = await execFileAsync('nvidia-smi', ['--query-gpu=memory.total,memory.free', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 1500 });
    const first = String(gpu.stdout || '').trim().split(/\r?\n/)[0];
    const [totalMb, freeMb] = first.split(',').map((v) => Number(v.trim()));
    if (!Number.isFinite(totalMb) || !Number.isFinite(freeMb)) return null;
    return { totalMb, freeMb };
  } catch { return null; }
}

function sameModelName(a, b) {
  const left = String(a || '').toLowerCase();
  const right = String(b || '').toLowerCase();
  return left === right || left.startsWith(`${right}:`) || right.startsWith(`${left}:`);
}

async function queryRezeOllamaVram() {
  try {
    const response = await fetchWithTimeout(url('/api/ps'), {}, 1800);
    if (!response.ok) return null;
    const data = await response.json();
    let rezeLoadedVramMb = 0;
    const loadedModels = [];
    for (const item of data.models || []) {
      const name = item.name || item.model || '';
      if (!sameModelName(name, HEAVY_MODEL) && !sameModelName(name, LIGHT_MODEL)) continue;
      const bytes = Number(item.size_vram || 0);
      const mb = Number.isFinite(bytes) ? Math.round(bytes / 1024 / 1024) : 0;
      rezeLoadedVramMb += mb;
      loadedModels.push({ name, vramMb: mb });
    }
    return { rezeLoadedVramMb, loadedModels };
  } catch { return null; }
}

async function getResourceState() {
  const [vram, ollamaRuntime] = await Promise.all([queryNvidiaVram(), queryRezeOllamaVram()]);
  const freeRamMb = Math.round(os.freemem() / 1024 / 1024);

  // Kluczowa poprawka: nie traktujemy VRAM-u zajętego przez aktualnie załadowany
  // model REZE jako "zużytego przez grę". Ollama /api/ps raportuje size_vram
  // znacznie pewniej niż lista procesów nvidia-smi na Windows/WDDM.
  const rezeLoadedVramMb = ollamaRuntime?.rezeLoadedVramMb || 0;
  const availableForRezeMb = vram
    ? Math.min(vram.totalMb, vram.freeMb + rezeLoadedVramMb)
    : null;

  lastResourceState = {
    vram: vram ? { ...vram, rezeLoadedVramMb, availableForRezeMb } : null,
    ollamaRuntime,
    freeRamMb,
    checkedAt: Date.now(),
  };
  return lastResourceState;
}

async function unloadModel(model) {
  if (!model) return;
  try {
    await fetchWithTimeout(url('/api/generate'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: 0 }),
    }, 2500);
  } catch { /* przełączenie nadal może się udać */ }
}

async function selectAdaptiveModel() {
  if (MODE === 'light') return LIGHT_MODEL;
  if (MODE === 'heavy') return HEAVY_MODEL;

  const resources = await getResourceState();
  const availableVram = resources.vram?.availableForRezeMb;
  const lowRam = resources.freeRamMb < RAM_DOWN_MB;
  const lowVram = Number.isFinite(availableVram) && availableVram < VRAM_DOWN_MB;
  const enoughVramForUpgrade = !Number.isFinite(availableVram) || availableVram >= VRAM_UP_MB;

  if (lowRam || lowVram) {
    upgradeCandidateSince = 0;
    if (activeModel !== LIGHT_MODEL) {
      const previous = activeModel;
      activeModel = LIGHT_MODEL;
      await unloadModel(previous);
    }
    return activeModel;
  }

  if (activeModel === LIGHT_MODEL) {
    if (enoughVramForUpgrade && resources.freeRamMb >= RAM_DOWN_MB) {
      if (!upgradeCandidateSince) upgradeCandidateSince = Date.now();
      if (Date.now() - upgradeCandidateSince >= UPGRADE_DELAY_MS) {
        const previous = activeModel;
        activeModel = HEAVY_MODEL;
        upgradeCandidateSince = 0;
        await unloadModel(previous);
      }
    } else upgradeCandidateSince = 0;
  } else {
    activeModel = HEAVY_MODEL;
  }
  return activeModel;
}

function isInstalled(models, wanted) {
  const base = wanted.split(':')[0];
  return models.some((name) => name === wanted || name.startsWith(`${wanted}:`) || name.startsWith(`${base}:`));
}

async function getLocalAiStatus() {
  try {
    const response = await fetchWithTimeout(url('/api/tags'), {}, 1800);
    if (!response.ok) return { available: false, model: activeModel, mode: MODE, reason: `Ollama HTTP ${response.status}` };
    const data = await response.json();
    const models = (data.models || []).map((m) => m.name || m.model).filter(Boolean);
    const selected = await selectAdaptiveModel();
    return {
      available: true,
      installed: isInstalled(models, selected),
      model: selected,
      mode: MODE,
      heavyModel: HEAVY_MODEL,
      lightModel: LIGHT_MODEL,
      heavyInstalled: isInstalled(models, HEAVY_MODEL),
      lightInstalled: isInstalled(models, LIGHT_MODEL),
      resources: lastResourceState,
      models,
    };
  } catch (error) {
    return { available: false, installed: false, model: activeModel, mode: MODE, reason: error.name === 'AbortError' ? 'Ollama nie odpowiada' : error.message };
  }
}

async function callLocalModel(messages, tools) {
  const model = await selectAdaptiveModel();
  const payload = {
    model, messages, tools, stream: false, think: false, keep_alive: KEEP_ALIVE,
    options: {
      temperature: 0.05,
      num_ctx: Number(process.env.LOCAL_AI_CONTEXT || 4096),
      num_predict: Number(process.env.LOCAL_AI_MAX_TOKENS || 220),
      top_p: 0.9,
    },
  };

  let response = await fetchWithTimeout(url('/api/chat'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }, Number(process.env.LOCAL_AI_TIMEOUT_MS || 7000));

  if (!response.ok) {
    const firstError = await response.text();
    if (/think/i.test(firstError)) {
      delete payload.think;
      response = await fetchWithTimeout(url('/api/chat'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }, Number(process.env.LOCAL_AI_TIMEOUT_MS || 7000));
    } else throw new Error(`Ollama ${response.status}: ${firstError}`);
  }

  if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
  const data = await response.json();
  if (!data.message) throw new Error('Lokalny model nie zwrócił wiadomości.');
  data.message._rezeModel = model;
  return data.message;
}

function getCurrentLocalModel() { return activeModel; }

module.exports = {
  getLocalAiStatus,
  callLocalModel,
  getCurrentLocalModel,
  LOCAL_AI_MODEL: MODE === 'auto' ? `AUTO (${HEAVY_MODEL} / ${LIGHT_MODEL})` : activeModel,
};
