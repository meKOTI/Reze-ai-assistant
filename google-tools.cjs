const fs = require("fs/promises");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { app, shell } = require("electron");

const OAUTH_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}/oauth2callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

function authFile() {
  return path.join(app.getPath("userData"), "google-auth.json");
}

function config() {
  return {
    clientId: String(process.env.GOOGLE_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.GOOGLE_CLIENT_SECRET || "").trim(),
  };
}

async function loadTokens() {
  try {
    return JSON.parse(await fs.readFile(authFile(), "utf8"));
  } catch {
    return null;
  }
}

async function saveTokens(tokens) {
  const previous = await loadTokens();
  const merged = { ...previous, ...tokens, savedAt: Date.now() };
  if (!tokens.refresh_token && previous?.refresh_token) merged.refresh_token = previous.refresh_token;
  await fs.mkdir(path.dirname(authFile()), { recursive: true });
  await fs.writeFile(authFile(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

async function googleStatus() {
  const { clientId } = config();
  const tokens = await loadTokens();
  return {
    configured: Boolean(clientId && config().clientSecret),
    connected: Boolean(tokens?.refresh_token || tokens?.access_token),
    scopes: SCOPES,
  };
}

function base64Url(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function exchangeCode(code, codeVerifier) {
  const { clientId, clientSecret } = config();
  const params = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });
  if (clientSecret) params.set("client_secret", clientSecret);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google OAuth ${response.status}: ${text}`);
  const tokens = JSON.parse(text);
  tokens.expires_at = Date.now() + (Number(tokens.expires_in || 3600) * 1000);
  return await saveTokens(tokens);
}

async function googleConnect() {
  const { clientId, clientSecret } = config();
  if (!clientId || !clientSecret) {
    throw new Error("Brak GOOGLE_CLIENT_ID lub GOOGLE_CLIENT_SECRET w pliku .env. Utwórz klienta OAuth typu Desktop app w Google Cloud Console.");
  }

  const state = crypto.randomBytes(24).toString("hex");
  const codeVerifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { server.close(); } catch {}
      fn(value);
    };

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, REDIRECT_URI);
        if (url.pathname !== "/oauth2callback") {
          res.writeHead(404).end("Not found");
          return;
        }
        if (url.searchParams.get("state") !== state) throw new Error("Nieprawidłowy stan OAuth.");
        const oauthError = url.searchParams.get("error");
        if (oauthError) throw new Error(`Google OAuth: ${oauthError}`);
        const code = url.searchParams.get("code");
        if (!code) throw new Error("Google nie zwrócił kodu autoryzacyjnego.");
        await exchangeCode(code, codeVerifier);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h2>REZE połączona z Google.</h2><p>Możesz zamknąć tę kartę i wrócić do REZE.</p>");
        finish(resolve, { connected: true, message: "Połączono konto Google z ARIĄ." });
      } catch (error) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Błąd połączenia REZE: ${error.message}`);
        finish(reject, error);
      }
    });

    server.on("error", (error) => finish(reject, new Error(`Nie mogę uruchomić lokalnego callbacku OAuth: ${error.message}`)));
    server.listen(OAUTH_PORT, "127.0.0.1", async () => {
      await shell.openExternal(authUrl.toString());
    });

    const timeout = setTimeout(() => finish(reject, new Error("Logowanie Google przekroczyło limit 2 minut.")), 120000);
  });
}

async function refreshAccessToken(tokens) {
  const { clientId, clientSecret } = config();
  if (!tokens?.refresh_token) throw new Error("Konto Google nie jest połączone. Użyj google_connect.");
  const params = new URLSearchParams({
    client_id: clientId,
    refresh_token: tokens.refresh_token,
    grant_type: "refresh_token",
  });
  if (clientSecret) params.set("client_secret", clientSecret);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Odświeżenie Google OAuth ${response.status}: ${text}`);
  const fresh = JSON.parse(text);
  fresh.expires_at = Date.now() + (Number(fresh.expires_in || 3600) * 1000);
  return await saveTokens(fresh);
}

async function accessToken() {
  let tokens = await loadTokens();
  if (!tokens) throw new Error("Konto Google nie jest połączone. Użyj google_connect.");
  if (!tokens.access_token || !tokens.expires_at || Date.now() > tokens.expires_at - 60000) {
    tokens = await refreshAccessToken(tokens);
  }
  return tokens.access_token;
}

async function googleFetch(url, options = {}) {
  const token = await accessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google API ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function header(headers, name) {
  return headers?.find((item) => String(item.name).toLowerCase() === name.toLowerCase())?.value || "";
}

async function gmailMessageMetadata(id) {
  const params = new URLSearchParams({ format: "metadata" });
  for (const h of ["Subject", "From", "Date", "To"]) params.append("metadataHeaders", h);
  const data = await googleFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${params}`);
  return {
    id: data.id,
    threadId: data.threadId,
    snippet: data.snippet || "",
    subject: header(data.payload?.headers, "Subject"),
    from: header(data.payload?.headers, "From"),
    to: header(data.payload?.headers, "To"),
    date: header(data.payload?.headers, "Date"),
  };
}

async function gmailList({ query = "", limit = 10 } = {}) {
  const maxResults = Math.max(1, Math.min(20, Number(limit) || 10));
  const params = new URLSearchParams({ maxResults: String(maxResults) });
  if (query) params.set("q", query);
  const data = await googleFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`);
  const messages = data.messages || [];
  return await Promise.all(messages.slice(0, maxResults).map((m) => gmailMessageMetadata(m.id)));
}

function decodeBody(data) {
  if (!data) return "";
  try {
    const normalized = String(data).replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function collectTextParts(part, result = []) {
  if (!part) return result;
  if (part.mimeType === "text/plain" && part.body?.data) result.push(decodeBody(part.body.data));
  for (const child of part.parts || []) collectTextParts(child, result);
  return result;
}

async function gmailRead({ id } = {}) {
  if (!id) throw new Error("Brak ID wiadomości Gmail.");
  const data = await googleFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
  const direct = data.payload?.body?.data ? decodeBody(data.payload.body.data) : "";
  const parts = collectTextParts(data.payload);
  const body = (direct || parts.join("\n\n") || data.snippet || "").slice(0, 12000);
  return {
    id: data.id,
    threadId: data.threadId,
    subject: header(data.payload?.headers, "Subject"),
    from: header(data.payload?.headers, "From"),
    to: header(data.payload?.headers, "To"),
    date: header(data.payload?.headers, "Date"),
    body,
  };
}

async function gmailSend({ to, subject = "", body = "" } = {}) {
  if (!to) throw new Error("Brak odbiorcy wiadomości.");
  const encodedSubject = `=?UTF-8?B?${Buffer.from(String(subject), "utf8").toString("base64")}?=`;
  const raw = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    String(body),
  ].join("\r\n");
  const payload = { raw: base64Url(Buffer.from(raw, "utf8")) };
  const data = await googleFetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { id: data.id, threadId: data.threadId, to, subject };
}

async function calendarList({ timeMin, timeMax, limit = 10 } = {}) {
  const now = new Date();
  const start = timeMin ? new Date(timeMin) : now;
  const end = timeMax ? new Date(timeMax) : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error("Nieprawidłowy zakres dat kalendarza.");
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    maxResults: String(Math.max(1, Math.min(50, Number(limit) || 10))),
  });
  const data = await googleFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
  return (data.items || []).map((event) => ({
    id: event.id,
    summary: event.summary || "(bez tytułu)",
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    location: event.location || "",
    description: event.description || "",
    htmlLink: event.htmlLink || "",
  }));
}

async function calendarCreate({ summary, start, end, description = "", location = "" } = {}) {
  if (!summary || !start) throw new Error("Wydarzenie wymaga tytułu i czasu rozpoczęcia.");
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) throw new Error("Nieprawidłowa data rozpoczęcia.");
  const endDate = end ? new Date(end) : new Date(startDate.getTime() + 60 * 60 * 1000);
  if (Number.isNaN(endDate.getTime())) throw new Error("Nieprawidłowa data zakończenia.");
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Warsaw";
  const payload = {
    summary,
    description,
    location,
    start: { dateTime: startDate.toISOString(), timeZone },
    end: { dateTime: endDate.toISOString(), timeZone },
  };
  const data = await googleFetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { id: data.id, summary: data.summary, start: data.start?.dateTime, end: data.end?.dateTime, htmlLink: data.htmlLink };
}

async function calendarDelete({ id } = {}) {
  if (!id) throw new Error("Brak ID wydarzenia.");
  const token = await accessToken();
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google Calendar ${response.status}: ${text}`);
  return { deleted: true, id };
}

module.exports = {
  googleStatus,
  googleConnect,
  gmailList,
  gmailRead,
  gmailSend,
  calendarList,
  calendarCreate,
  calendarDelete,
};
