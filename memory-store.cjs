const fs = require('fs/promises');
const path = require('path');
const { app } = require('electron');

const MAX_MESSAGES = 40;
const MAX_FACTS = 100;

function memoryPath() {
  return path.join(app.getPath('userData'), 'reze-memory.json');
}

function legacyMemoryPath() {
  return path.join(app.getPath('userData'), ['a', 'ria-memory.json'].join(''));
}

async function loadMemory() {
  try {
    let raw;
    try {
      raw = await fs.readFile(memoryPath(), 'utf8');
    } catch {
      raw = await fs.readFile(legacyMemoryPath(), 'utf8');
      await fs.writeFile(memoryPath(), raw, 'utf8').catch(() => {});
    }
    const parsed = JSON.parse(raw);
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages.slice(-MAX_MESSAGES) : [],
      facts: Array.isArray(parsed.facts) ? parsed.facts.slice(-MAX_FACTS) : [],
    };
  } catch {
    return { messages: [], facts: [] };
  }
}

async function saveMemory(memory) {
  const data = {
    messages: (memory.messages || []).slice(-MAX_MESSAGES),
    facts: (memory.facts || []).slice(-MAX_FACTS),
  };
  await fs.mkdir(path.dirname(memoryPath()), { recursive: true });
  await fs.writeFile(memoryPath(), JSON.stringify(data, null, 2), 'utf8');
}

async function addMessage(role, content) {
  const memory = await loadMemory();
  memory.messages.push({ role, content: String(content), at: new Date().toISOString() });
  await saveMemory(memory);
}

async function rememberFact(text, category = 'general') {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Brak treści do zapamiętania.');
  const memory = await loadMemory();
  const normalized = clean.toLocaleLowerCase('pl');
  memory.facts = memory.facts.filter((item) => String(item.text || '').toLocaleLowerCase('pl') !== normalized);
  memory.facts.push({ text: clean, category: String(category || 'general'), at: new Date().toISOString() });
  await saveMemory(memory);
  return clean;
}

async function recallFacts(query = '') {
  const memory = await loadMemory();
  const terms = String(query || '').toLocaleLowerCase('pl').split(/\s+/).filter(Boolean);
  const facts = memory.facts
    .map((item) => {
      const haystack = `${item.category || ''} ${item.text || ''}`.toLocaleLowerCase('pl');
      const score = terms.length ? terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0) : 1;
      return { ...item, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)))
    .slice(0, 12)
    .map(({ score, ...item }) => item);
  return facts;
}

async function getContext() {
  const memory = await loadMemory();
  return {
    messages: memory.messages.slice(-20).map(({ role, content }) => ({ role, content })),
    facts: memory.facts.slice(-20),
  };
}

async function clearMemory() {
  await saveMemory({ messages: [], facts: [] });
}

module.exports = { addMessage, rememberFact, recallFacts, getContext, clearMemory };
