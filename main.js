const {
  app,
  BrowserWindow,
  globalShortcut,
  desktopCapturer,
  screen,
  clipboard,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  shell,
  safeStorage,
} = require("electron");

const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
const { execFile } = require("child_process");

const BACKEND_URL = "https://study-buddy-brain.onrender.com";

let SETTINGS_PATH = "";
let PACKS_PATH = "";
let REMOTE_CONFIG_PATH = "";

let hudWin = null;
let spotlightWin = null;
let sidecarWin = null;
let tray = null;

let isPinned = false;
let isBusy = false;
let activeRequestId = 0;
let busyWatchdog = null;
let snipCorner1 = null;
let snipCornerTimer = null;

let escRegistered = false;
let hideTimer = null;
let followTimer = null;
let keepAliveTimer = null;
let pendingHudState = null;

let history = [];
let historyIdx = -1;
let lastContextSummary = "";
let lastGoodByok = null;
let lockedW = 54;
let lockedH = 24;
let lastWinX = -9999;
let lastWinY = -9999;

// Global crash immunity: app never silently exits mid-session
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err && err.message ? err.message : err);
  isBusy = false;
  clearTimeout(busyWatchdog);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  isBusy = false;
  clearTimeout(busyWatchdog);
});

let settings = {
  userApiKey: "",
  autoCopy: true,
  localOcr: false, // Keep OFF for zero-process stealth on SHL/AMCAT; toggle ON in Tray for Turbo OCR
  activePack: "default",
  deviceId: crypto.randomUUID(),
};

const DEFAULT_BYOK_MODELS = {
  groq_text: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"],
  groq_vision: ["qwen/qwen3.8-27b"],
  nvidia_text: [
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "nvidia/nemotron-3.5-bolt-e4b",
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "mistralai/mistral-large-4-1t-a52b",
  ],
  nvidia_vision: [
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "mistralai/mistral-large-4-1t-a52b",
    "nvidia/nemotron-3.5-bolt-e4b",
  ],
  gemini: ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.1-flash-lite"],
  openrouter_text: ["openrouter/free", "google/gemma-4-31b-it:free"],
  openrouter_vision: [
    "openrouter/free",
    "nvidia/nemotron-3.5-super-vl:free",
    "google/gemma-4-31b-it:free",
  ],
  cerebras_text: ["gpt-oss-120b", "qwen-3.8-27b"],
  cerebras_vision: ["qwen-3.8-27b"],
  mistral_text: ["mistral-small-latest"],
  mistral_vision: ["mistral-small-latest"],
};

let remoteConfig = {
  latest_version: "",
  release_url: "https://github.com/burhanuddinkhandwala786/cursor-companion/releases/latest",
  notice: "",
  byok_models: { ...DEFAULT_BYOK_MODELS },
};

let modePacks = {};

const DEFAULT_MODE_PACKS = {
  default: {
    label: "Exam & Academic Solver (Default)",
    prompt: "",
  },
  coding: {
    label: "Coding & DSA Interview Pack",
    prompt:
      'You are an expert software engineer. Fill "verification" FIRST with time/space complexity and edge cases, then put the exact concise fix or output in "cursor_pill" and clean runnable code in "copy_value". Return ONLY raw JSON: {"verification":"edge cases checked","detected_type":"CODE_FIX","cursor_pill":"concise fix","copy_value":"exact code","expanded_note":"complexity note"}',
  },
  excel: {
    label: "Excel & Finance Formula Pack",
    prompt:
      'You are an Excel and finance expert. Fill "verification" FIRST checking cell references and syntax, then put the exact Excel formula in both "cursor_pill" and "copy_value". Return ONLY raw JSON: {"verification":"formula verified","detected_type":"DIRECT_VALUE","cursor_pill":"=XLOOKUP(...)","copy_value":"=XLOOKUP(...)","expanded_note":"1-line usage note"}',
  },
};

const LOCAL_CACHE = new Map();
const LOCAL_CACHE_TTL = 45 * 60 * 1000;
const BYOK_COOLDOWN = new Map();

function isByokCoolingDown(key, model, modality = "txt") {
  const cacheKey = `${key}:${model}:${modality}`;
  const until = BYOK_COOLDOWN.get(cacheKey);
  if (!until) return false;
  if (Date.now() >= until) {
    BYOK_COOLDOWN.delete(cacheKey);
    return false;
  }
  return true;
}

function setByokCooldown(key, model, ms, modality = "txt") {
  BYOK_COOLDOWN.set(`${key}:${model}:${modality}`, Date.now() + ms);
  if (BYOK_COOLDOWN.size > 500) {
    const now = Date.now();
    for (const [cacheKey, until] of BYOK_COOLDOWN) {
      if (until <= now) BYOK_COOLDOWN.delete(cacheKey);
    }
    while (BYOK_COOLDOWN.size > 500) {
      BYOK_COOLDOWN.delete(BYOK_COOLDOWN.keys().next().value);
    }
  }
}

function sanitizeApiKeys(raw) {
  const cleaned = String(raw || "").replace(
    /\b(?:bearer|api_key|key)\s*[:=]?\s*/gi,
    ""
  );
  return cleaned
    .split(/[\s,;]+/)
    .map((k) => k.trim().replace(/^["']|["']$/g, ""))
    .filter((k) => k.length > 10);
}

function normalizeLocalKey(text, mode) {
  const normalized = String(text || "")
    .replace(
      /^\s*(?:q(?:uestion)?\s*\d+[.):\-]*|\d+[.):\-]+|\[\d+\s*marks?\])\s*/i,
      ""
    )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

  return normalized.length >= 25 ? `${mode}:${settings.activePack}:${normalized}` : "";
}

function getLocalCache(key, hasPersonalKey = false) {
  if (!key || !LOCAL_CACHE.has(key)) return null;
  const entry = LOCAL_CACHE.get(key);
  if (Date.now() - entry.ts > LOCAL_CACHE_TTL) {
    LOCAL_CACHE.delete(key);
    return null;
  }
  return {
    ...entry.data,
    key_source: hasPersonalKey ? "BYOK_CACHE" : "CACHE",
  };
}

function setLocalCache(key, data) {
  if (!key || !data || data.detected_type === "ERROR") return;
  if (/unclear crop/i.test(String(data.cursor_pill || ""))) return;
  LOCAL_CACHE.set(key, {
    ts: Date.now(),
    data: { ...data },
  });
  if (LOCAL_CACHE.size > 250) {
    LOCAL_CACHE.delete(LOCAL_CACHE.keys().next().value);
  }
}

function initSettingsPath() {
  const userDir = app.getPath("userData");
  SETTINGS_PATH = path.join(userDir, "v3-settings.json");
  PACKS_PATH = path.join(userDir, "mode-packs.json");
  REMOTE_CONFIG_PATH = path.join(userDir, "remote-config.json");
}

function loadModePacks() {
  modePacks = { ...DEFAULT_MODE_PACKS };
  try {
    if (PACKS_PATH && fs.existsSync(PACKS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(PACKS_PATH, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        modePacks = { ...DEFAULT_MODE_PACKS, ...parsed };
      }
    } else if (PACKS_PATH) {
      fs.mkdirSync(path.dirname(PACKS_PATH), { recursive: true });
      fs.writeFileSync(PACKS_PATH, JSON.stringify(DEFAULT_MODE_PACKS, null, 2), "utf8");
    }
  } catch (_) {}
}

function getActiveCustomPrompt() {
  const pack = modePacks[settings.activePack];
  return pack && typeof pack.prompt === "string" && pack.prompt.trim()
    ? pack.prompt.trim()
    : "";
}

// Hardware-backed Windows DPAPI encryption for personal API keys at rest
function encryptKeyForDisk(plainKey) {
  if (!plainKey) return { userApiKeyEnc: "", userApiKey: "" };
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return {
        userApiKeyEnc: safeStorage.encryptString(plainKey).toString("base64"),
        userApiKey: "",
      };
    }
  } catch (_) {}
  return { userApiKeyEnc: "", userApiKey: plainKey };
}

function decryptKeyFromDisk(saved) {
  if (saved && typeof saved.userApiKeyEnc === "string" && saved.userApiKeyEnc) {
    try {
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(saved.userApiKeyEnc, "base64"));
      }
    } catch (_) {}
  }
  return saved && typeof saved.userApiKey === "string" ? saved.userApiKey : "";
}

function loadSettings() {
  let saved = {};
  try {
    if (SETTINGS_PATH && fs.existsSync(SETTINGS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        saved = parsed;
      }
    }
  } catch (_) {}

  return {
    userApiKey: decryptKeyFromDisk(saved),
    autoCopy: typeof saved.autoCopy === "boolean" ? saved.autoCopy : true,
    localOcr: typeof saved.localOcr === "boolean" ? saved.localOcr : false,
    activePack: typeof saved.activePack === "string" && saved.activePack ? saved.activePack : "default",
    deviceId:
      typeof saved.deviceId === "string" && saved.deviceId.trim()
        ? saved.deviceId
        : crypto.randomUUID(),
  };
}

function saveSettings(next) {
  settings = { ...settings, ...next };
  if (!SETTINGS_PATH) return;
  try {
    const encryptedFields = encryptKeyForDisk(settings.userApiKey || "");
    const toPersist = {
      autoCopy: settings.autoCopy,
      localOcr: settings.localOcr,
      activePack: settings.activePack,
      deviceId: settings.deviceId,
      userApiKeyEnc: encryptedFields.userApiKeyEnc,
      ...(encryptedFields.userApiKey ? { userApiKey: encryptedFields.userApiKey } : {}),
    };
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(toPersist, null, 2), "utf8");
  } catch (error) {
    console.error("Unable to save settings:", error.message);
  }
}

function mergeRemoteConfig(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const mergedModels = { ...DEFAULT_BYOK_MODELS };
  if (data.byok_models && typeof data.byok_models === "object") {
    for (const [k, v] of Object.entries(data.byok_models)) {
      if (Array.isArray(v) && v.length > 0 && v.every((m) => typeof m === "string" && m.trim())) {
        mergedModels[k] = v.map((m) => m.trim());
      }
    }
  }
  remoteConfig = {
    latest_version: typeof data.latest_version === "string" ? data.latest_version.trim() : remoteConfig.latest_version,
    release_url:
      typeof data.release_url === "string" && data.release_url.startsWith("https://")
        ? data.release_url.trim()
        : remoteConfig.release_url,
    notice: typeof data.notice === "string" ? data.notice.trim() : "",
    byok_models: mergedModels,
  };
}

function loadCachedRemoteConfig() {
  try {
    if (REMOTE_CONFIG_PATH && fs.existsSync(REMOTE_CONFIG_PATH)) {
      mergeRemoteConfig(JSON.parse(fs.readFileSync(REMOTE_CONFIG_PATH, "utf8")));
    }
  } catch (_) {}
}

function getByokModels(slot) {
  const list = remoteConfig.byok_models && remoteConfig.byok_models[slot];
  if (Array.isArray(list) && list.length > 0) return list;
  return DEFAULT_BYOK_MODELS[slot] || [];
}

function isNewerVersion(remoteVer, currentVer) {
  if (!remoteVer || !currentVer) return false;
  const rParts = String(remoteVer).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const cParts = String(currentVer).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(rParts.length, cParts.length); i++) {
    const r = rParts[i] || 0;
    const c = cParts[i] || 0;
    if (r > c) return true;
    if (r < c) return false;
  }
  return false;
}

// Native C++ WDA_EXCLUDEFROMCAPTURE + strict WebContents navigation lockdown
function hardenWindow(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setContentProtection(true);
  } catch (_) {}
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
  } catch (_) {}
}

function enforceCaptureInvisibility(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setContentProtection(true);
  } catch (_) {}
}

function beginRequest() {
  activeRequestId += 1;
  const reqId = activeRequestId;
  isBusy = true;
  clearTimeout(busyWatchdog);
  busyWatchdog = setTimeout(() => {
    if (activeRequestId === reqId && isBusy) {
      isBusy = false;
      showHud({ mode: "error", cursor_pill: "Timed out — press F8/Alt+A" }, 2600);
    }
  }, 27000);
  return reqId;
}

function finishRequest(reqId) {
  if (activeRequestId === reqId) {
    clearTimeout(busyWatchdog);
    busyWatchdog = null;
    isBusy = false;
  }
}

function clearSnipCorner() {
  snipCorner1 = null;
  clearTimeout(snipCornerTimer);
  snipCornerTimer = null;
}

function dismissAllOverlays() {
  isPinned = false;
  activeRequestId += 1;
  isBusy = false;
  clearTimeout(busyWatchdog);
  busyWatchdog = null;
  clearSnipCorner();
  clearTimeout(hideTimer);
  stopCursorFollow();

  for (const win of [spotlightWin, sidecarWin, hudWin]) {
    if (win && !win.isDestroyed()) win.hide();
  }

  syncEscapeShortcut();
}

function syncEscapeShortcut() {
  const anyOpen =
    Boolean(snipCorner1) ||
    [hudWin, spotlightWin, sidecarWin].some(
      (win) => win && !win.isDestroyed() && win.isVisible()
    );

  if (anyOpen && !escRegistered) {
    try {
      escRegistered = globalShortcut.register("Escape", dismissAllOverlays);
    } catch (_) {}
  } else if (!anyOpen && escRegistered) {
    try {
      globalShortcut.unregister("Escape");
    } catch (_) {}
    escRegistered = false;
  }
}

// Force IPv4 (family: 4) to prevent Windows IPv6 DNS stalls
function httpsJsonRequest(urlStr, headers, bodyObj, timeoutMs = 13000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const url = new URL(urlStr);

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: "POST",
        family: 4,
        timeout: timeoutMs,
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Connection: "close",
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("error", reject);
        res.on("aborted", () => reject(new Error("Response aborted")));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            text: data,
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Timeout"));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function httpsGetJson(urlStr, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      urlStr,
      { agent: false, family: 4, timeout: timeoutMs },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Timeout")));
    req.on("error", reject);
  });
}

async function syncRemoteConfig() {
  try {
    const data = await httpsGetJson(BACKEND_URL + "/v3_1/config", 12000);
    if (data && typeof data === "object") {
      mergeRemoteConfig(data);
      if (REMOTE_CONFIG_PATH) {
        try {
          fs.mkdirSync(path.dirname(REMOTE_CONFIG_PATH), { recursive: true });
          fs.writeFileSync(REMOTE_CONFIG_PATH, JSON.stringify(remoteConfig, null, 2), "utf8");
        } catch (_) {}
      }
      rebuildTrayMenu();
    }
  } catch (_) {}
}

// Brace-safe JSON parser: never breaks on code/math containing {}
function parseModelJsonResponse(rawText) {
  const cleaned = String(rawText || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "")
    .replace(/```(?:json)?|```/gi, "")
    .trim();

  let bestObj = null;

  try {
    const direct = JSON.parse(cleaned);
    const item = Array.isArray(direct) ? direct[0] : direct;
    if (item && typeof item === "object" && item.cursor_pill) {
      bestObj = item;
    }
  } catch (_) {}

  if (!bestObj) {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        const sliced = JSON.parse(cleaned.slice(first, last + 1));
        if (sliced && typeof sliced === "object" && sliced.cursor_pill) {
          bestObj = sliced;
        }
      } catch (_) {}
    }
  }

  if (bestObj && String(bestObj.cursor_pill).trim()) {
    const pill = String(bestObj.cursor_pill).trim();
    return {
      detected_type: bestObj.detected_type || "DIRECT_VALUE",
      cursor_pill: pill,
      copy_value: String(bestObj.copy_value || pill),
      expanded_note: String(bestObj.expanded_note || ""),
      key_source: "BYOK",
    };
  }

  const pillMatch = cleaned.match(/"cursor_pill"\s*:\s*"([^"]+)"/);
  if (pillMatch && pillMatch[1].trim()) {
    const pill = pillMatch[1].trim();
    const copyMatch = cleaned.match(/"copy_value"\s*:\s*"([^"]*)"/);
    const noteMatch = cleaned.match(/"expanded_note"\s*:\s*"([^"]*)"/);
    return {
      detected_type: "DIRECT_VALUE",
      cursor_pill: pill,
      copy_value: copyMatch ? copyMatch[1] : pill,
      expanded_note: noteMatch ? noteMatch[1] : "",
      key_source: "BYOK",
    };
  }

  return null;
}

function buildByokInstruction(actionMode) {
  const custom = getActiveCustomPrompt();
  if (actionMode === "solve" && custom) {
    return custom;
  }
  if (actionMode === "rewrite") {
    return 'Rewrite cleanly and politely while keeping exact meaning. Return ONLY raw JSON: {"verification":"tone checked","detected_type":"REWRITE","cursor_pill":"1-line preview","copy_value":"full rewrite","expanded_note":"tone note"}';
  }
  if (actionMode === "explain") {
    return 'Explain clearly in plain English without guessing. Return ONLY raw JSON: {"verification":"facts checked","detected_type":"CONCEPT_EXPLAIN","cursor_pill":"1-line summary","copy_value":"1-line summary","expanded_note":"3 short bullets"}';
  }
  return [
    "You are a 10/10 academic and engineering verification engine. Accuracy is strictly #1.",
    'In the "verification" field FIRST, briefly solve the problem, check for negations (NOT/EXCEPT/INCORRECT), and check ALL options (A/B/C/D/E) including combined choices ("both A and B", "both B and C", "all of the above"). Do NOT trust highlighted radio buttons.',
    'Only AFTER "verification", output the exact matching option letter + text in "cursor_pill". If cut off or illegible, set cursor_pill to "Unclear crop — retry".',
    'Return ONLY raw JSON: {"verification":"concise step-by-step check","detected_type":"MCQ","cursor_pill":"B. Exact option text","copy_value":"","expanded_note":"1-sentence summary"}',
  ].join("\n");
}

async function querySingleGeminiModel(key, model, sysInstruction, promptText, imgB64, reqTimeout) {
  const modality = imgB64 ? "img" : "txt";
  const parts = [{ text: `${sysInstruction}\n\n${promptText}` }];
  if (imgB64) {
    parts.push({
      inline_data: {
        mime_type: "image/jpeg",
        data: imgB64,
      },
    });
  }

  const generationConfig = {
    responseMimeType: "application/json",
    maxOutputTokens: 900,
  };

  if (!model.includes("lite")) {
    generationConfig.thinkingConfig = { thinkingLevel: "LOW" };
  }

  let res = await httpsJsonRequest(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    {},
    { contents: [{ parts }], generationConfig },
    reqTimeout
  );

  if (res.status === 400 && generationConfig.thinkingConfig) {
    delete generationConfig.thinkingConfig;
    res = await httpsJsonRequest(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {},
      { contents: [{ parts }], generationConfig },
      reqTimeout
    );
  }

  if (res.status === 200) {
    const parsed = JSON.parse(res.text);
    const txt =
      parsed?.candidates?.[0]?.content?.parts
        ?.filter((part) => !part.thought)
        ?.map((part) => part.text || "")
        .join("\n") || "";
    const cleanObj = parseModelJsonResponse(txt);
    if (cleanObj) {
      lastGoodByok = { key, model };
      cleanObj.key_source = "BYOK";
      return cleanObj;
    }
    throw new Error(`${model}:nonJSON`);
  }

  if (res.status === 402) {
    setByokCooldown(key, model, 86400000, modality);
  } else if (res.status === 429 || res.status === 503 || res.status === 504) {
    setByokCooldown(key, model, 45000, modality);
  } else if (res.status === 404 || res.status === 400) {
    setByokCooldown(key, model, 3600000, modality);
  }
  throw new Error(`${model}:${res.status}`);
}

async function querySingleOpenAiCompat(key, endpoint, model, providerTag, sysInstruction, promptText, imgB64, reqTimeout) {
  const modality = imgB64 ? "img" : "txt";
  const messages = imgB64
    ? [
        {
          role: "user",
          content: [
            { type: "text", text: `${sysInstruction}\n\n${promptText}` },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${imgB64}` },
            },
          ],
        },
      ]
    : [
        { role: "system", content: sysInstruction },
        { role: "user", content: promptText },
      ];

  const body = {
    model,
    messages,
    temperature: 0.0,
    max_tokens: 1100,
  };

  if (providerTag === "groq" && model.includes("gpt-oss")) {
    body.reasoning_effort = "medium";
  }
  if ((providerTag === "groq" || providerTag === "cerebras" || providerTag === "mistral") && !imgB64) {
    body.response_format = { type: "json_object" };
  }

  const headers = { Authorization: `Bearer ${key}` };
  if (providerTag === "openrouter") {
    headers["HTTP-Referer"] = "https://study-buddy-brain.onrender.com";
    headers["X-Title"] = "Cursor Companion";
  }

  let res = await httpsJsonRequest(endpoint, headers, body, reqTimeout);

  if (res.status === 400 && (body.response_format || body.reasoning_effort)) {
    delete body.response_format;
    delete body.reasoning_effort;
    res = await httpsJsonRequest(endpoint, headers, body, reqTimeout);
  }

  if (res.status === 200) {
    const parsed = JSON.parse(res.text);
    const msg = parsed?.choices?.[0]?.message || {};
    const cleanObj = parseModelJsonResponse(msg.content || "");
    if (cleanObj) {
      lastGoodByok = { key, model };
      cleanObj.key_source = "BYOK";
      return cleanObj;
    }
    throw new Error(`${model}:nonJSON`);
  }

  if (res.status === 402) {
    setByokCooldown(key, model, 86400000, modality);
  } else if (res.status === 429 || res.status === 503 || res.status === 504) {
    setByokCooldown(key, model, 30000, modality);
  } else if (res.status === 400 || res.status === 404) {
    setByokCooldown(key, model, 3600000, modality);
  }
  throw new Error(`${model}:${res.status}`);
}

async function executeDirectByok(keysRaw, promptText, imgB64, actionMode) {
  const keys = sanitizeApiKeys(keysRaw);

  if (!keys.length) {
    return {
      detected_type: "ERROR",
      cursor_pill: "Invalid key format in Alt+K",
      copy_value: "",
      expanded_note: "Paste a valid key: gsk_, nvapi-, AIza, AQ., sk-or-, csk-, mistral:, or sk-",
      key_source: "BYOK",
    };
  }

  const sysInstruction = buildByokInstruction(actionMode);
  const reqTimeout = imgB64 ? 14000 : 11000;
  const modality = imgB64 ? "img" : "txt";
  const failReasons = [];

  for (const rawKey of keys) {
    if (rawKey.startsWith("AIza") || rawKey.startsWith("AQ.")) {
      const models = getByokModels("gemini");
      for (const model of models) {
        if (isByokCoolingDown(rawKey, model, modality)) continue;
        try {
          return await querySingleGeminiModel(rawKey, model, sysInstruction, promptText, imgB64, reqTimeout);
        } catch (err) {
          if (String(err.message || "").includes("Timeout")) {
            setByokCooldown(rawKey, model, 45000, modality);
          }
          failReasons.push(err.message || "err");
        }
      }
    } else if (
      rawKey.startsWith("gsk_") ||
      rawKey.startsWith("nvapi-") ||
      rawKey.startsWith("sk-") ||
      rawKey.startsWith("csk-") ||
      rawKey.toLowerCase().startsWith("mistral:")
    ) {
      const isGroq = rawKey.startsWith("gsk_");
      const isNvidia = rawKey.startsWith("nvapi-");
      const isOr = rawKey.startsWith("sk-or-");
      const isCerebras = rawKey.startsWith("csk-");
      const isMistral = rawKey.toLowerCase().startsWith("mistral:");

      const actualKey = isMistral ? rawKey.slice(8).trim() : rawKey;
      const providerTag = isGroq
        ? "groq"
        : isNvidia
          ? "nvidia"
          : isOr
            ? "openrouter"
            : isCerebras
              ? "cerebras"
              : isMistral
                ? "mistral"
                : "openai";

      const endpoint = isGroq
        ? "https://api.groq.com/openai/v1/chat/completions"
        : isNvidia
          ? "https://integrate.api.nvidia.com/v1/chat/completions"
          : isOr
            ? "https://openrouter.ai/api/v1/chat/completions"
            : isCerebras
              ? "https://api.cerebras.ai/v1/chat/completions"
              : isMistral
                ? "https://api.mistral.ai/v1/chat/completions"
                : "https://api.openai.com/v1/chat/completions";

      const modelList = isGroq
        ? getByokModels(imgB64 ? "groq_vision" : "groq_text")
        : isNvidia
          ? getByokModels(imgB64 ? "nvidia_vision" : "nvidia_text")
          : isOr
            ? getByokModels(imgB64 ? "openrouter_vision" : "openrouter_text")
            : isCerebras
              ? getByokModels(imgB64 ? "cerebras_vision" : "cerebras_text")
              : isMistral
                ? getByokModels(imgB64 ? "mistral_vision" : "mistral_text")
                : ["gpt-4o-mini"];

      for (const model of modelList) {
        if (isByokCoolingDown(actualKey, model, modality)) continue;
        try {
          return await querySingleOpenAiCompat(
            actualKey,
            endpoint,
            model,
            providerTag,
            sysInstruction,
            promptText,
            imgB64,
            reqTimeout
          );
        } catch (err) {
          failReasons.push(err.message || "err");
        }
      }
    } else {
      failReasons.push(`BadPrefix(${rawKey.slice(0, 4)})`);
    }
  }

  return {
    detected_type: "ERROR",
    cursor_pill: `Personal key issue (${failReasons.slice(0, 2).join(", ") || "retry"})`,
    copy_value: "",
    expanded_note: failReasons.join(" | "),
    key_source: "BYOK",
  };
}

// Zero duplicate client retries — Render handles the full 5-provider cascade internally
async function postJsonWithJitterRetry(endpoint, payload, retries = 0) {
  const url = new URL(endpoint, BACKEND_URL);
  const reqTimeout = payload.image_base64 ? 23000 : 20000;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await httpsJsonRequest(
        url.toString(),
        { "X-Device-ID": settings.deviceId },
        payload,
        reqTimeout
      );

      if (res.status >= 500 && attempt < retries) {
        await new Promise((resolve) =>
          setTimeout(resolve, 250 + Math.floor(Math.random() * 350))
        );
        continue;
      }

      try {
        return JSON.parse(res.text);
      } catch (_) {
        throw new Error("Invalid response");
      }
    } catch (error) {
      if (attempt >= retries) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 250 + Math.floor(Math.random() * 350))
      );
    }
  }

  throw new Error("Request failed");
}

function warmBackend() {
  try {
    const req = https.get(
      BACKEND_URL + "/healthz",
      { agent: false, family: 4, timeout: 10000 },
      (res) => {
        res.on("error", () => {});
        res.resume();
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => {});
  } catch (_) {}
}

// Opt-in Windows built-in WinRT OCR (0 MB added, OFF by default for exam stealth)
function runWindowsLocalOcr(jpegBuffer) {
  if (!settings.localOcr || process.platform !== "win32" || !jpegBuffer) {
    return Promise.resolve("");
  }

  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `cc_ocr_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    try {
      fs.writeFileSync(tmpFile, jpegBuffer);
    } catch (_) {
      return resolve("");
    }

    const escaped = tmpFile.replace(/'/g, "''");
    const ps = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $t) { $m = $asTask.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(2200) | Out-Null; if ($task.IsCompleted) { return $task.Result } else { return $null } }
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime] | Out-Null
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${escaped}')) ([Windows.Storage.StorageFile])
if ($null -eq $file) { exit 0 }
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
if ($null -ne $res) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $res.Text }
`;

    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
      { windowsHide: true, timeout: 2800, maxBuffer: 512 * 1024 },
      (err, stdout) => {
        try {
          fs.unlinkSync(tmpFile);
        } catch (_) {}
        if (err || !stdout) return resolve("");
        resolve(String(stdout).trim());
      }
    );
  });
}

function createHudWindow() {
  const win = new BrowserWindow({
    width: 54,
    height: 24,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    thickFrame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  hudWin = win;

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  hardenWindow(win);

  win.webContents.on("did-finish-load", () => {
    if (!win.isDestroyed() && pendingHudState) {
      win.webContents.send("hud-state", pendingHudState);
    }
  });

  win.on("closed", () => {
    if (hudWin === win) {
      hudWin = null;
      stopCursorFollow();
    }
    syncEscapeShortcut();
  });

  win.loadFile(path.join(__dirname, "index.html"));
}

function snapToCursor(force = false) {
  if (!hudWin || hudWin.isDestroyed() || !hudWin.isVisible() || isPinned) {
    return;
  }

  const pt = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(pt);
  const wa = disp.workArea;

  let x = pt.x + 12;
  let y = pt.y + 12;

  if (x + lockedW > wa.x + wa.width - 6) x = pt.x - lockedW - 10;
  if (y + lockedH > wa.y + wa.height - 6) y = pt.y - lockedH - 10;

  x = Math.round(Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - lockedW - 4)));
  y = Math.round(Math.max(wa.y + 4, Math.min(y, wa.y + wa.height - lockedH - 4)));

  if (force || x !== lastWinX || y !== lastWinY) {
    lastWinX = x;
    lastWinY = y;
    hudWin.setBounds({
      x,
      y,
      width: Math.round(lockedW),
      height: Math.round(lockedH),
    });
  }
}

function startCursorFollow() {
  stopCursorFollow();
  followTimer = setInterval(() => snapToCursor(false), 16);
}

function stopCursorFollow() {
  if (followTimer) {
    clearInterval(followTimer);
    followTimer = null;
  }
}

function showHud(payload, autoHideMs = 0) {
  if (!hudWin || hudWin.isDestroyed()) createHudWindow();

  clearTimeout(hideTimer);

  const isLoading = payload.mode === "loading";
  const textLen = String(payload.cursor_pill || "").length;
  const badgeReserve =
    payload.key_source === "BYOK" ||
    payload.key_source === "BYOK_CACHE" ||
    payload.key_source === "CACHE" ||
    payload.key_source === "PRO"
      ? 72
      : 58;

  lockedW = isLoading
    ? 54
    : Math.max(126, Math.min(360, Math.round(textLen * 7.5 + badgeReserve)));
  lockedH = 24;

  hudWin.setFocusable(false);
  hudWin.setIgnoreMouseEvents(true, { forward: true });

  lastWinX = -9999;
  lastWinY = -9999;

  if (isPinned) {
    const bounds = hudWin.getBounds();
    hudWin.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: lockedW,
      height: lockedH,
    });
  }

  if (!hudWin.isVisible()) {
    hudWin.showInactive();
  }
  enforceCaptureInvisibility(hudWin);
  try {
    hudWin.moveTop();
  } catch (_) {}

  snapToCursor(true);
  syncEscapeShortcut();

  if (!isPinned) {
    startCursorFollow();
  } else {
    stopCursorFollow();
  }

  pendingHudState = {
    ...payload,
    isPinned,
    hasUserKey: Boolean(settings.userApiKey),
  };

  if (!hudWin.webContents.isLoadingMainFrame()) {
    hudWin.webContents.send("hud-state", pendingHudState);
  }

  if (autoHideMs > 0 && !isPinned) {
    hideTimer = setTimeout(() => {
      if (hudWin && !hudWin.isDestroyed() && !isPinned) {
        stopCursorFollow();
        hudWin.hide();
        syncEscapeShortcut();
      }
    }, autoHideMs);
  }
}

function openSpotlight(initialMode = "ask") {
  const pt = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(pt).workArea;

  const width = 440;
  const height = 44;
  const x = Math.round(wa.x + (wa.width - width) / 2);
  const y = Math.round(wa.y + 42);

  const state = {
    spotlightMode: initialMode,
    userApiKey: settings.userApiKey || "",
    hasContext: Boolean(lastContextSummary),
  };

  if (spotlightWin && !spotlightWin.isDestroyed()) {
    spotlightWin.setBounds({ x, y, width, height });
    spotlightWin.show();
    spotlightWin.focus();
    enforceCaptureInvisibility(spotlightWin);
    syncEscapeShortcut();

    if (!spotlightWin.webContents.isLoadingMainFrame()) {
      spotlightWin.webContents.send("hud-state", state);
    } else {
      const existingWin = spotlightWin;
      existingWin.webContents.once("did-finish-load", () => {
        if (!existingWin.isDestroyed()) {
          existingWin.webContents.send("hud-state", state);
        }
      });
    }
    return;
  }

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    thickFrame: false,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  spotlightWin = win;

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hardenWindow(win);

  win.webContents.once("did-finish-load", () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
    enforceCaptureInvisibility(win);
    syncEscapeShortcut();
    win.webContents.send("hud-state", state);
  });

  win.on("blur", () => {
    if (!win.isDestroyed()) win.hide();
    syncEscapeShortcut();
  });

  win.on("closed", () => {
    if (spotlightWin === win) spotlightWin = null;
    syncEscapeShortcut();
  });

  win.loadFile(path.join(__dirname, "index.html"), {
    hash: "spotlight",
  });
}

function toggleSidecar() {
  if (sidecarWin && !sidecarWin.isDestroyed() && sidecarWin.isVisible()) {
    sidecarWin.hide();
    syncEscapeShortcut();
    return;
  }

  const pt = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(pt).workArea;

  const width = 276;
  const height = Math.max(1, Math.min(480, wa.height - 48));
  const x = Math.round(wa.x + wa.width - width - 12);
  const y = Math.round(wa.y + 24);

  if (sidecarWin && !sidecarWin.isDestroyed()) {
    sidecarWin.setBounds({ x, y, width, height });
    sidecarWin.showInactive();
    enforceCaptureInvisibility(sidecarWin);
    try {
      sidecarWin.moveTop();
    } catch (_) {}
    syncEscapeShortcut();
    syncSidecar();
    return;
  }

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    thickFrame: false,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  sidecarWin = win;

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hardenWindow(win);

  win.webContents.once("did-finish-load", () => {
    if (win.isDestroyed()) return;
    win.showInactive();
    enforceCaptureInvisibility(win);
    try {
      win.moveTop();
    } catch (_) {}
    syncEscapeShortcut();
    syncSidecar();
  });

  win.on("closed", () => {
    if (sidecarWin === win) sidecarWin = null;
    syncEscapeShortcut();
  });

  win.loadFile(path.join(__dirname, "index.html"), {
    hash: "sidecar",
  });
}

function syncSidecar() {
  if (
    sidecarWin &&
    !sidecarWin.isDestroyed() &&
    sidecarWin.isVisible() &&
    !sidecarWin.webContents.isLoadingMainFrame()
  ) {
    sidecarWin.webContents.send("hud-state", {
      history,
      activeIdx: historyIdx,
      hasUserKey: Boolean(settings.userApiKey),
    });
  }
}

async function captureDisplayNative(display) {
  const sf = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    fetchWindowIcons: false,
    thumbnailSize: {
      width: Math.round(display.bounds.width * sf),
      height: Math.round(display.bounds.height * sf),
    },
  });

  const match =
    sources.find((source) => String(source.display_id) === String(display.id)) ||
    sources[0];

  if (!match || match.thumbnail.isEmpty()) {
    throw new Error("Capture unavailable");
  }

  return { image: match.thumbnail, sf };
}

async function captureAroundCursorBuffer(boxW = 1120, boxH = 760, fullScreen = false) {
  const pt = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(pt);
  const { image, sf } = await captureDisplayNative(disp);
  const sz = image.getSize();

  if (fullScreen) {
    return image.toJPEG(80);
  }

  const relX = pt.x - disp.bounds.x;
  const relY = pt.y - disp.bounds.y;

  const cropW = Math.min(Math.round(boxW * sf), sz.width);
  const cropH = Math.min(Math.round(boxH * sf), sz.height);

  if (cropW < 1 || cropH < 1) {
    throw new Error("Invalid capture dimensions");
  }

  const left = Math.max(
    0,
    Math.min(Math.round(relX * sf - cropW * 0.45), sz.width - cropW)
  );
  const top = Math.max(
    0,
    Math.min(Math.round(relY * sf - cropH * 0.25), sz.height - cropH)
  );

  return image.crop({ x: left, y: top, width: cropW, height: cropH }).toJPEG(82);
}

async function captureBetweenPointsBuffer(p1, p2) {
  const disp = screen.getDisplayNearestPoint(p1);
  const { image, sf } = await captureDisplayNative(disp);
  const sz = image.getSize();

  const relX1 = p1.x - disp.bounds.x;
  const relY1 = p1.y - disp.bounds.y;
  const relX2 = p2.x - disp.bounds.x;
  const relY2 = p2.y - disp.bounds.y;

  const rawW = Math.abs(relX2 - relX1);
  const rawH = Math.abs(relY2 - relY1);

  if (rawW < 20 || rawH < 20) {
    return captureAroundCursorBuffer(1120, 760, false);
  }

  const pad = Math.round(28 * sf);
  const x = Math.max(0, Math.round(Math.min(relX1, relX2) * sf - pad));
  const y = Math.max(0, Math.round(Math.min(relY1, relY2) * sf - pad));
  const w = Math.min(sz.width - x, Math.round(rawW * sf + pad * 2));
  const h = Math.min(sz.height - y, Math.round(rawH * sf + pad * 2));

  if (w < 10 || h < 10) {
    return captureAroundCursorBuffer(1120, 760, false);
  }

  return image.crop({ x, y, width: w, height: h }).toJPEG(84);
}

async function analyzeCapturedBuffer(jpegBuffer, actionMode = "solve") {
  if (settings.localOcr) {
    const ocrText = await runWindowsLocalOcr(jpegBuffer);
    if (ocrText && ocrText.length >= 30) {
      const textRes = await runAnalysisPipeline({
        textContent: ocrText,
        actionMode,
      });
      if (textRes && textRes.detected_type !== "ERROR" && !/unclear crop/i.test(String(textRes.cursor_pill || ""))) {
        return textRes;
      }
    }
  }
  return runAnalysisPipeline({
    imageBase64: jpegBuffer.toString("base64"),
    actionMode,
  });
}

function grabSelectedTextDirectly() {
  if (process.platform !== "win32") {
    return Promise.resolve("");
  }

  return new Promise((resolve) => {
    const sentinel = `__CC_WAIT_${Date.now()}__`;
    const prev = clipboard.readText();

    clipboard.writeText(sentinel);

    const ps = `
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);' -Name K -Namespace U;
[U.K]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero);
[U.K]::keybd_event(0xA4, 0, 2, [UIntPtr]::Zero);
[U.K]::keybd_event(0xA5, 0, 2, [UIntPtr]::Zero);
Start-Sleep -Milliseconds 30;
[U.K]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero);
[U.K]::keybd_event(0x43, 0, 0, [UIntPtr]::Zero);
Start-Sleep -Milliseconds 20;
[U.K]::keybd_event(0x43, 0, 2, [UIntPtr]::Zero);
[U.K]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero);
`;

    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
      { windowsHide: true },
      () => {}
    );

    let checks = 0;

    const poll = setInterval(() => {
      checks++;
      const current = clipboard.readText();

      if (current && current !== sentinel) {
        clearInterval(poll);
        clipboard.writeText(prev);
        resolve(current.trim());
      } else if (checks >= 10) {
        clearInterval(poll);
        clipboard.writeText(prev);
        resolve("");
      }
    }, 20);
  });
}

function ghostPasteActiveValue() {
  const current = history[historyIdx];
  const textToPaste =
    (current && (current.copy_value || current.cursor_pill)) || "";

  if (!textToPaste) return;

  clipboard.writeText(String(textToPaste));
  showHud({ ...current, cursor_pill: "Pasted ✓" }, 1400);

  if (process.platform !== "win32") return;

  const ps = `
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);' -Name K -Namespace U;
[U.K]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero);
[U.K]::keybd_event(0xA4, 0, 2, [UIntPtr]::Zero);
[U.K]::keybd_event(0xA5, 0, 2, [UIntPtr]::Zero);
Start-Sleep -Milliseconds 40;
[U.K]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero);
[U.K]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero);
Start-Sleep -Milliseconds 25;
[U.K]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero);
[U.K]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero);
`;

  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
    { windowsHide: true },
    () => {}
  );
}

async function runAnalysisPipeline({
  textContent,
  imageBase64,
  followUp,
  priorContext,
  actionMode,
}) {
  const mode = actionMode || "solve";
  const userKey = String(settings.userApiKey || "").trim();
  const customPrompt = mode === "solve" ? getActiveCustomPrompt() : "";

  const promptText = followUp
    ? `Context:\n${priorContext || ""}\n\nFollow-up:\n${followUp}`
    : textContent || "Solve the primary problem shown in this image accurately.";

  if (
    String(textContent || "").trim().toUpperCase().startsWith("TEST:") ||
    userKey.toLowerCase() === "test"
  ) {
    const label =
      String(textContent || "Verified").replace(/^test:\s*/i, "") || "Verified";

    return {
      detected_type: "DIRECT_VALUE",
      cursor_pill: `✓ ${label.slice(0, 55)}`,
      copy_value: label,
      expanded_note: "Zero-token test mode — 0 API quota used.",
      key_source: "TEST",
    };
  }

  const localCacheKey =
    !followUp && textContent ? normalizeLocalKey(textContent, mode) : "";

  const localHit = getLocalCache(localCacheKey, Boolean(userKey));
  if (localHit) return localHit;

  if (userKey) {
    const byokResult = await executeDirectByok(
      userKey,
      promptText,
      imageBase64,
      mode
    );
    if (byokResult && byokResult.detected_type !== "ERROR") {
      setLocalCache(localCacheKey, byokResult);
    }
    return byokResult;
  }

  const poolResult = await postJsonWithJitterRetry("/v3_1/analyze", {
    text_content: textContent || null,
    image_base64: imageBase64 || null,
    follow_up: followUp || null,
    prior_context: priorContext || null,
    action_mode: mode,
    device_id: settings.deviceId,
    custom_prompt: customPrompt || null,
  });

  if (
    poolResult &&
    typeof poolResult === "object" &&
    !Array.isArray(poolResult) &&
    poolResult.detected_type !== "ERROR"
  ) {
    setLocalCache(localCacheKey, poolResult);
  }

  return poolResult;
}

async function handleInstantScan() {
  if (isBusy) return;
  clearSnipCorner();
  const reqId = beginRequest();
  const t0 = Date.now();

  try {
    showHud({ mode: "loading", cursor_pill: "•••" });
    const buf = await captureAroundCursorBuffer(1120, 760, false);
    if (activeRequestId !== reqId) return;

    let res = await analyzeCapturedBuffer(buf, "solve");
    if (activeRequestId !== reqId) return;

    if (res && /unclear crop/i.test(String(res.cursor_pill || ""))) {
      const fullBuf = await captureAroundCursorBuffer(1280, 860, true);
      if (activeRequestId !== reqId) return;
      res = await runAnalysisPipeline({
        imageBase64: fullBuf.toString("base64"),
        actionMode: "solve",
      });
    }

    if (activeRequestId !== reqId) return;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + "s";
    handleResult(res, elapsed, "[Smart Screen Scan]");
  } catch (_) {
    if (activeRequestId === reqId) {
      showHud({ mode: "error", cursor_pill: "Retry F8 / Alt+A" }, 2400);
    }
  } finally {
    finishRequest(reqId);
  }
}

async function handleTwoCornerSnip() {
  if (isBusy) return;

  const pt = screen.getCursorScreenPoint();

  if (!snipCorner1) {
    snipCorner1 = { x: pt.x, y: pt.y, ts: Date.now() };
    clearTimeout(snipCornerTimer);
    snipCornerTimer = setTimeout(() => {
      clearSnipCorner();
      syncEscapeShortcut();
    }, 15000);
    showHud(
      {
        mode: "result",
        detected_type: "DIRECT_VALUE",
        cursor_pill: "⌜ Corner 1 set → press F9/Alt+Q at bottom-right",
        elapsed: "1/2",
      },
      6000
    );
    return;
  }

  const p1 = snipCorner1;
  clearSnipCorner();
  const reqId = beginRequest();
  const t0 = Date.now();

  try {
    showHud({ mode: "loading", cursor_pill: "•••" });
    const buf = await captureBetweenPointsBuffer(p1, pt);
    if (activeRequestId !== reqId) return;

    const res = await analyzeCapturedBuffer(buf, "solve");
    if (activeRequestId !== reqId) return;

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + "s";
    handleResult(res, elapsed, "[2-Corner Snip]");
  } catch (_) {
    if (activeRequestId === reqId) {
      showHud({ mode: "error", cursor_pill: "Retry F9 / Alt+Q" }, 2400);
    }
  } finally {
    finishRequest(reqId);
  }
}

async function handleTextAction(actionMode = "solve") {
  if (isBusy) return;
  clearSnipCorner();
  const reqId = beginRequest();
  const t0 = Date.now();

  try {
    showHud({ mode: "loading", cursor_pill: "•••" });
    const selected = await grabSelectedTextDirectly();
    if (activeRequestId !== reqId) return;

    let res;
    let sourceLabel = selected;

    if (selected) {
      res = await runAnalysisPipeline({
        textContent: selected,
        actionMode,
      });
    } else {
      const buf = await captureAroundCursorBuffer(1120, 760, false);
      if (activeRequestId !== reqId) return;
      sourceLabel = `[Highlighted ${actionMode} Scan]`;
      res = await analyzeCapturedBuffer(buf, actionMode);
      if (
        activeRequestId === reqId &&
        res &&
        /unclear crop/i.test(String(res.cursor_pill || ""))
      ) {
        const fullBuf = await captureAroundCursorBuffer(1280, 860, true);
        if (activeRequestId !== reqId) return;
        res = await runAnalysisPipeline({
          imageBase64: fullBuf.toString("base64"),
          actionMode,
        });
      }
    }

    if (activeRequestId !== reqId) return;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + "s";
    handleResult(res, elapsed, sourceLabel);
  } catch (_) {
    if (activeRequestId === reqId) {
      showHud({ mode: "error", cursor_pill: "Retry hotkey" }, 2400);
    }
  } finally {
    finishRequest(reqId);
  }
}

function handleResult(res, elapsed, sourceContext) {
  if (
    !res ||
    typeof res !== "object" ||
    Array.isArray(res) ||
    res.detected_type === "ERROR" ||
    !res.cursor_pill
  ) {
    showHud(
      {
        mode: "error",
        cursor_pill:
          (res && typeof res.cursor_pill === "string" && res.cursor_pill) ||
          "High traffic — retry",
        key_source: (res && res.key_source) || undefined,
      },
      3200
    );
    return;
  }

  const context = String(sourceContext || "");
  const isUnclear = /unclear crop/i.test(String(res.cursor_pill));

  const item = {
    ...res,
    cursor_pill: String(res.cursor_pill),
    elapsed,
    mode: isUnclear ? "error" : "result",
    sourceLabel: context.slice(0, 60),
  };

  if (settings.autoCopy && res.copy_value && !isUnclear) {
    clipboard.writeText(String(res.copy_value));
  }

  lastContextSummary = `${context}\nAnswer: ${res.cursor_pill}`.trim();

  history.unshift(item);
  if (history.length > 15) history.pop();
  historyIdx = 0;

  showHud(item, 8500);
  syncSidecar();
}

async function processSpotlightQuery(_event, query) {
  if (spotlightWin && !spotlightWin.isDestroyed()) {
    spotlightWin.hide();
    syncEscapeShortcut();
  }

  if (typeof query !== "string" || !query.trim() || isBusy) return;

  query = query.trim();
  const reqId = beginRequest();
  const t0 = Date.now();

  try {
    showHud({ mode: "loading", cursor_pill: "•••" });

    const res = lastContextSummary
      ? await runAnalysisPipeline({
          followUp: query,
          priorContext: lastContextSummary,
          actionMode: "solve",
        })
      : await runAnalysisPipeline({
          textContent: query,
          actionMode: "solve",
        });

    if (activeRequestId !== reqId) return;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + "s";
    handleResult(res, elapsed, query);
  } catch (_) {
    if (activeRequestId === reqId) {
      showHud({ mode: "error", cursor_pill: "Retry Alt+G" }, 2400);
    }
  } finally {
    finishRequest(reqId);
  }
}

ipcMain.on("hud-spotlight-query", processSpotlightQuery);
ipcMain.on("hud-followup", processSpotlightQuery);

ipcMain.on("hud-save-key", async (_event, key) => {
  if (typeof key !== "string") return;

  if (spotlightWin && !spotlightWin.isDestroyed()) {
    spotlightWin.hide();
    syncEscapeShortcut();
  }

  lastGoodByok = null;
  BYOK_COOLDOWN.clear();
  LOCAL_CACHE.clear();

  const trimmed = key.trim();
  if (trimmed.toLowerCase().startsWith("share:")) {
    const sharedKey = trimmed.slice(6).trim();
    showHud({ mode: "loading", cursor_pill: "•••" });
    try {
      const resp = await postJsonWithJitterRetry("/v3_1/contribute-key", {
        api_key: sharedKey,
        device_id: settings.deviceId,
      });
      if (resp && resp.ok) {
        settings.userApiKey = "";
        saveSettings({ userApiKey: "" });
        syncSidecar();
        showHud(
          {
            mode: "result",
            detected_type: "DIRECT_VALUE",
            cursor_pill: resp.message || "Pro Pool Unlocked ✓",
            key_source: "PRO",
            elapsed: "★",
          },
          3200
        );
      } else {
        showHud(
          {
            mode: "error",
            cursor_pill: (resp && resp.message) || "Could not verify shared key",
          },
          3400
        );
      }
    } catch (_) {
      showHud({ mode: "error", cursor_pill: "Share check failed — retry" }, 2800);
    }
    return;
  }

  const cleanKey = sanitizeApiKeys(trimmed).join(", ");
  settings.userApiKey = cleanKey;
  saveSettings({ userApiKey: cleanKey });
  syncSidecar();

  if (!cleanKey) {
    showHud(
      {
        mode: "result",
        detected_type: "DIRECT_VALUE",
        cursor_pill: "Cloud pool active",
        key_source: "POOL",
        elapsed: "✓",
      },
      2200
    );
    return;
  }

  showHud({ mode: "loading", cursor_pill: "•••" });
  const t0 = Date.now();
  const check = await executeDirectByok(
    cleanKey,
    'Return ONLY JSON: {"verification":"ok","detected_type":"DIRECT_VALUE","cursor_pill":"Key verified ✓","copy_value":"","expanded_note":""}',
    null,
    "solve"
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + "s";

  if (check && check.detected_type !== "ERROR") {
    showHud(
      {
        mode: "result",
        detected_type: "DIRECT_VALUE",
        cursor_pill: "Personal key verified ✓",
        key_source: "BYOK",
        elapsed,
      },
      2600
    );
  } else {
    showHud(
      {
        mode: "error",
        cursor_pill: (check && check.cursor_pill) || "Invalid key (Alt+K)",
        key_source: "BYOK",
        elapsed,
      },
      3600
    );
  }
});

ipcMain.on("hud-copy", (_event, text) => {
  if (typeof text === "string" && text) {
    clipboard.writeText(text);
  }
});

ipcMain.on("hud-select-history", (_event, idx) => {
  if (Number.isInteger(idx) && idx >= 0 && history[idx]) {
    historyIdx = idx;
    showHud(history[idx], 0);
    syncSidecar();
  }
});

ipcMain.on("hud-close-spotlight", () => {
  if (spotlightWin && !spotlightWin.isDestroyed()) {
    spotlightWin.hide();
    syncEscapeShortcut();
  }
});

ipcMain.on("hud-close-sidecar", () => {
  if (sidecarWin && !sidecarWin.isDestroyed()) {
    sidecarWin.hide();
    syncEscapeShortcut();
  }
});

ipcMain.on("hud-hide", dismissAllOverlays);

function rebuildTrayMenu() {
  if (!tray) return;

  const currentVersion = app.getVersion() || "3.1.0";
  const hasUpdate = isNewerVersion(remoteConfig.latest_version, currentVersion);

  const packSubmenu = Object.entries(modePacks).map(([id, pack]) => ({
    label: pack.label || id,
    type: "radio",
    checked: settings.activePack === id,
    click: () => {
      saveSettings({ activePack: id });
      LOCAL_CACHE.clear();
      rebuildTrayMenu();
      showHud(
        {
          mode: "result",
          detected_type: "DIRECT_VALUE",
          cursor_pill: `Pack: ${pack.label || id}`,
          elapsed: "✓",
        },
        2000
      );
    },
  }));

  const template = [
    { label: `Cursor Companion v${currentVersion}`, enabled: false },
  ];

  if (hasUpdate) {
    template.push({
      label: `⬇ Update Available (v${remoteConfig.latest_version})`,
      click: () => shell.openExternal(remoteConfig.release_url),
    });
  }

  if (remoteConfig.notice) {
    template.push({
      label: `ℹ ${remoteConfig.notice.slice(0, 48)}`,
      enabled: false,
    });
  }

  template.push(
    { type: "separator" },
    { label: "Smart Scan (F8 / Alt + A)", click: () => handleInstantScan() },
    { label: "2-Corner Snip (F9 / Alt + Q)", click: () => handleTwoCornerSnip() },
    { label: "Solve Selection (Alt + C)", click: () => handleTextAction("solve") },
    { label: "Rewrite Selection (Alt + W)", click: () => handleTextAction("rewrite") },
    { label: "Explain Selection (Alt + E)", click: () => handleTextAction("explain") },
    { type: "separator" },
    { label: "Mode Packs", submenu: packSubmenu },
    {
      label: "Turbo Local OCR (OFF = Exam Stealth)",
      type: "checkbox",
      checked: Boolean(settings.localOcr),
      click: (menuItem) => {
        saveSettings({ localOcr: Boolean(menuItem.checked) });
        showHud(
          {
            mode: "result",
            detected_type: "DIRECT_VALUE",
            cursor_pill: menuItem.checked ? "Turbo OCR ON ⚡" : "Exam Stealth Mode ✓",
            elapsed: "✓",
          },
          2000
        );
      },
    },
    { type: "separator" },
    { label: "Spotlight Bar (Alt + G)", click: () => openSpotlight("ask") },
    { label: "Study Sidecar (Alt + D)", click: () => toggleSidecar() },
    { label: "Personal Key / Share Pro (Alt + K)", click: () => openSpotlight("key") },
    { label: "Cancel / Reset (F10 / Alt + X)", click: () => dismissAllOverlays() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() }
  );

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("Cursor Companion V3.1");
  rebuildTrayMenu();
}

function registerShortcut(accelerator, handler) {
  try {
    const registered = globalShortcut.register(accelerator, handler);
    if (!registered) {
      console.warn(`Shortcut unavailable: ${accelerator}`);
    }
  } catch (error) {
    console.error(`Unable to register ${accelerator}:`, error.message);
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.whenReady()
    .then(() => {
      initSettingsPath();
      loadModePacks();
      loadCachedRemoteConfig();
      settings = loadSettings();
      saveSettings({});

      createHudWindow();
      createTray();
      syncRemoteConfig();

      keepAliveTimer = setInterval(warmBackend, 240000);

      // Zero-modifier proctor-safe aliases
      registerShortcut("F8", handleInstantScan);
      registerShortcut("F9", handleTwoCornerSnip);
      registerShortcut("F10", dismissAllOverlays);

      // Standard hotkeys
      registerShortcut("Alt+A", handleInstantScan);
      registerShortcut("Alt+Q", handleTwoCornerSnip);
      registerShortcut("Alt+C", () => handleTextAction("solve"));
      registerShortcut("Alt+W", () => handleTextAction("rewrite"));
      registerShortcut("Alt+E", () => handleTextAction("explain"));

      registerShortcut("Alt+Enter", ghostPasteActiveValue);
      registerShortcut("Alt+G", () => openSpotlight("ask"));
      registerShortcut("Alt+F", () => openSpotlight("followup"));
      registerShortcut("Alt+K", () => openSpotlight("key"));
      registerShortcut("Alt+D", toggleSidecar);

      registerShortcut("Alt+P", () => {
        isPinned = !isPinned;
        clearTimeout(hideTimer);

        if (history[historyIdx]) {
          showHud(history[historyIdx], 0);
        } else if (!isPinned && hudWin && !hudWin.isDestroyed()) {
          if (hudWin.isVisible()) startCursorFollow();
        }
      });

      registerShortcut("Alt+H", () => {
        if (!history.length) return;
        historyIdx = (historyIdx + 1) % history.length;
        showHud(history[historyIdx], 0);
        syncSidecar();
      });

      registerShortcut("Alt+X", dismissAllOverlays);
    })
    .catch((error) => {
      console.error("Application startup failed:", error);
      app.quit();
    });
}

app.on("will-quit", () => {
  clearTimeout(hideTimer);
  clearTimeout(busyWatchdog);
  clearTimeout(snipCornerTimer);
  clearInterval(keepAliveTimer);
  stopCursorFollow();
  globalShortcut.unregisterAll();
});
