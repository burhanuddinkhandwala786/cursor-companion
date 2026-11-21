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
const https = require("https");
const crypto = require("crypto");
const { execFile } = require("child_process");

const BACKEND_URL = "https://study-buddy-brain.onrender.com";
const GITHUB_RELEASES_API =
  "https://api.github.com/repos/burhanuddinkhandwala786/cursor-companion/releases/latest";

let SETTINGS_PATH = "";
let PACKS_PATH = "";
let REMOTE_CONFIG_PATH = "";
let SHORTCUT_PRELOAD_PATH = "";
let SHORTCUT_HTML_PATH = "";

let hudWin = null;
let spotlightWin = null;
let sidecarWin = null;
let shortcutWin = null;
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
let updateCheckTimer = null;
let pendingHudState = null;

let history = [];
let historyIdx = -1;
let lastContextSummary = "";
let lastGoodByok = null;
let lockedW = 68;
let lockedH = 34;
let lastWinX = -9999;
let lastWinY = -9999;

const failedShortcuts = new Set();

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

const DEFAULT_SHORTCUTS = {
  smartScan: "F8",
  smartScanAlt: "Alt+A",
  twoCornerSnip: "F9",
  twoCornerSnipAlt: "Alt+Q",
  solveText: "Alt+C",
  rewriteText: "Alt+W",
  explainText: "Alt+E",
  ghostPaste: "Alt+Enter",
  spotlight: "Alt+G",
  followup: "Alt+F",
  apiKey: "Alt+K",
  sidecar: "Alt+D",
  pinHud: "Alt+P",
  cycleHistory: "Alt+H",
  hideOnly: "Alt+X",
  forceReset: "F10",
};

const SHORTCUT_LABELS = [
  ["smartScan", "Smart Screen Scan", "Capture & Vision"],
  ["smartScanAlt", "Smart Screen Scan (Alt)", "Capture & Vision"],
  ["twoCornerSnip", "2-Corner Zero-Focus Snip", "Capture & Vision"],
  ["twoCornerSnipAlt", "2-Corner Snip (Alt)", "Capture & Vision"],
  ["solveText", "Solve Highlighted Text", "Capture & Vision"],
  ["rewriteText", "Rewrite Highlighted Text", "Capture & Vision"],
  ["explainText", "Explain Highlighted Text", "Capture & Vision"],
  ["hideOnly", "Vanish Overlay Only", "Overlay & History"],
  ["cycleHistory", "Recall / Cycle Answers", "Overlay & History"],
  ["pinHud", "Pin / Unpin HUD Pill", "Overlay & History"],
  ["sidecar", "Study Sidecar Panel", "Overlay & History"],
  ["ghostPaste", "Ghost Paste Answer", "Overlay & History"],
  ["forceReset", "Force Cancel & Reset", "Overlay & History"],
  ["spotlight", "Spotlight Command Bar", "Intelligence & Keys"],
  ["followup", "Follow-Up on Last Answer", "Intelligence & Keys"],
  ["apiKey", "Personal API Key / Pro Pool", "Intelligence & Keys"],
];

let settings = {
  userApiKey: "",
  autoCopy: true,
  activePack: "default",
  deviceId: crypto.randomUUID(),
  shortcuts: { ...DEFAULT_SHORTCUTS },
  notifiedVersion: "",
  dismissedUpdateVersion: "",
};

const DEFAULT_BYOK_MODELS = {
  groq_text: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"],
  groq_vision: ["qwen/qwen3.8-27b"],
  gemini: ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.1-flash-lite"],
  nvidia_text: [
    "nvidia/nemotron-3.5-bolt-e4b",
    "nvidia/nemotron-3.5-lightning-30b-a3b",
  ],
  nvidia_vision: [
    "nvidia/nemotron-3.5-bolt-e4b",
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
  ],
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
  SHORTCUT_PRELOAD_PATH = path.join(userDir, "shortcut-preload.js");
  SHORTCUT_HTML_PATH = path.join(userDir, "shortcut-editor.html");
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

function sanitizeShortcutsMap(rawMap) {
  const merged = { ...DEFAULT_SHORTCUTS };
  if (rawMap && typeof rawMap === "object" && !Array.isArray(rawMap)) {
    for (const key of Object.keys(DEFAULT_SHORTCUTS)) {
      if (typeof rawMap[key] === "string") {
        merged[key] = rawMap[key].trim();
      }
    }
  }
  return merged;
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
    activePack: typeof saved.activePack === "string" && saved.activePack ? saved.activePack : "default",
    deviceId:
      typeof saved.deviceId === "string" && saved.deviceId.trim()
        ? saved.deviceId
        : crypto.randomUUID(),
    shortcuts: sanitizeShortcutsMap(saved.shortcuts),
    notifiedVersion: typeof saved.notifiedVersion === "string" ? saved.notifiedVersion : "",
    dismissedUpdateVersion: typeof saved.dismissedUpdateVersion === "string" ? saved.dismissedUpdateVersion : "",
  };
}

function saveSettings(next) {
  settings = {
    ...settings,
    ...next,
    shortcuts: sanitizeShortcutsMap(next.shortcuts || settings.shortcuts),
  };
  if (!SETTINGS_PATH) return;
  try {
    const encryptedFields = encryptKeyForDisk(settings.userApiKey || "");
    const toPersist = {
      autoCopy: settings.autoCopy,
      activePack: settings.activePack,
      deviceId: settings.deviceId,
      shortcuts: settings.shortcuts,
      notifiedVersion: settings.notifiedVersion || "",
      dismissedUpdateVersion: settings.dismissedUpdateVersion || "",
      userApiKeyEnc: encryptedFields.userApiKeyEnc,
      ...(encryptedFields.userApiKey ? { userApiKey: encryptedFields.userApiKey } : {}),
    };
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(toPersist, null, 2), "utf8");
  } catch (error) {
    console.error("Unable to save settings:", error.message);
  }
}

function cleanVersionString(v) {
  return String(v || "").trim().replace(/^v/i, "").split("-")[0];
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
  const nextVer = typeof data.latest_version === "string" ? cleanVersionString(data.latest_version) : "";
  remoteConfig = {
    latest_version: nextVer || remoteConfig.latest_version,
    release_url:
      typeof data.release_url === "string" && data.release_url.startsWith("https://")
        ? data.release_url.trim()
        : remoteConfig.release_url,
    notice: typeof data.notice === "string" ? data.notice.trim() : remoteConfig.notice,
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
  const rClean = cleanVersionString(remoteVer);
  const cClean = cleanVersionString(currentVer);
  if (!rClean || !cClean) return false;
  const rParts = rClean.split(".").map((n) => parseInt(n, 10) || 0);
  const cParts = cClean.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(rParts.length, cParts.length); i++) {
    const r = rParts[i] || 0;
    const c = cParts[i] || 0;
    if (r > c) return true;
    if (r < c) return false;
  }
  return false;
}

function getUpdateInfo() {
  const currentVersion = cleanVersionString(app.getVersion() || "3.1.1");
  const latest = cleanVersionString(remoteConfig.latest_version || "");
  const available = isNewerVersion(latest, currentVersion);
  return {
    available,
    version: latest,
    currentVersion,
    url: remoteConfig.release_url,
    notice: remoteConfig.notice || "",
    dismissed: Boolean(available && settings.dismissedUpdateVersion === latest),
  };
}

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
      showHud(
        {
          mode: "error",
          cursor_pill: "Timed out — retry scan",
          key_source: settings.userApiKey ? "BYOK" : "POOL",
        },
        2400
      );
    }
  }, 21000);
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

function hideOverlaysOnly() {
  clearTimeout(hideTimer);
  stopCursorFollow();

  for (const win of [spotlightWin, sidecarWin, hudWin]) {
    if (win && !win.isDestroyed()) win.hide();
  }

  syncEscapeShortcut();
}

function forceResetAll() {
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
  if (shortcutWin && !shortcutWin.isDestroyed()) return;
  const anyOpen = [hudWin, spotlightWin, sidecarWin].some(
    (win) => win && !win.isDestroyed() && win.isVisible()
  );

  if (anyOpen && !escRegistered) {
    try {
      escRegistered = globalShortcut.register("Escape", hideOverlaysOnly);
    } catch (_) {}
  } else if (!anyOpen && escRegistered) {
    try {
      globalShortcut.unregister("Escape");
    } catch (_) {}
    escRegistered = false;
  }
}

function httpsJsonRequest(urlStr, headers, bodyObj, timeoutMs = 11000) {
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

function httpsGetJson(urlStr, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.get(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        agent: false,
        family: 4,
        timeout: timeoutMs,
        headers: {
          "User-Agent": "Cursor-Companion-Desktop",
          Accept: "application/json",
        },
      },
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

async function syncRemoteConfigAndUpdates(manual = false) {
  let fetched = false;

  try {
    const data = await httpsGetJson(BACKEND_URL + "/v3_1/config", 9000);
    if (data && typeof data === "object") {
      mergeRemoteConfig(data);
      fetched = true;
    }
  } catch (_) {}

  try {
    const gh = await httpsGetJson(GITHUB_RELEASES_API, 8000);
    if (gh && typeof gh === "object" && gh.tag_name) {
      const ghVer = cleanVersionString(gh.tag_name);
      if (isNewerVersion(ghVer, remoteConfig.latest_version || app.getVersion() || "3.1.1")) {
        mergeRemoteConfig({
          latest_version: ghVer,
          release_url:
            typeof gh.html_url === "string" && gh.html_url.startsWith("https://")
              ? gh.html_url
              : remoteConfig.release_url,
        });
      }
      fetched = true;
    }
  } catch (_) {}

  if (fetched && REMOTE_CONFIG_PATH) {
    try {
      fs.mkdirSync(path.dirname(REMOTE_CONFIG_PATH), { recursive: true });
      fs.writeFileSync(REMOTE_CONFIG_PATH, JSON.stringify(remoteConfig, null, 2), "utf8");
    } catch (_) {}
  }

  rebuildTrayMenu();
  syncSidecar();

  const info = getUpdateInfo();
  if (info.available) {
    if (manual || (settings.notifiedVersion !== info.version && !isBusy)) {
      saveSettings({ notifiedVersion: info.version });
      showHud(
        {
          mode: "update",
          cursor_pill: `v${info.version} ready · Alt+D or Tray to update`,
        },
        5500
      );
    }
  } else if (manual) {
    showHud(
      {
        mode: "result",
        cursor_pill: `Up to date (v${info.currentVersion})`,
        elapsed: "✓",
      },
      2600
    );
  }
}

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
    max_tokens: 900,
  };

  if (providerTag === "groq" && model.includes("gpt-oss")) {
    body.reasoning_effort = "low";
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
  const reqTimeout = imgB64 ? 10500 : 8500;
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

async function postJsonWithJitterRetry(endpoint, payload, retries = 0) {
  const url = new URL(endpoint, BACKEND_URL);
  const reqTimeout = payload.image_base64 ? 18000 : 15000;

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
          setTimeout(resolve, 200 + Math.floor(Math.random() * 250))
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
        setTimeout(resolve, 200 + Math.floor(Math.random() * 250))
      );
    }
  }

  throw new Error("Request failed");
}

function createHudWindow() {
  const win = new BrowserWindow({
    width: 68,
    height: 34,
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

  let x = pt.x + 14;
  let y = pt.y + 14;

  if (x + lockedW > wa.x + wa.width - 6) x = pt.x - lockedW - 12;
  if (y + lockedH > wa.y + wa.height - 6) y = pt.y - lockedH - 12;

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
  const hasBadge = Boolean(payload.key_source || payload.mode === "update");
  const hasElapsed = Boolean(payload.elapsed);
  const extraWidth =
    42 +
    (hasBadge ? 64 : 0) +
    (hasElapsed ? 38 : 0) +
    (isPinned ? 12 : 0);

  lockedW = isLoading
    ? 68
    : Math.max(152, Math.min(460, Math.round(textLen * 7.6 + extraWidth)));
  lockedH = 34;

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

  const width = 520;
  const height = 60;
  const x = Math.round(wa.x + (wa.width - width) / 2);
  const y = Math.round(wa.y + 48);

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

  const width = 312;
  const height = Math.max(1, Math.min(540, wa.height - 48));
  const x = Math.round(wa.x + wa.width - width - 14);
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
      appVersion: cleanVersionString(app.getVersion() || "3.1.1"),
      updateInfo: getUpdateInfo(),
    });
  }
}

// --- Frameless Obsidian Shortcut Studio (Apple / Mercedes / Tesla Aesthetic) ---
function ensureShortcutEditorAssets() {
  const preloadCode = [
    'const { contextBridge, ipcRenderer } = require("electron");',
    'contextBridge.exposeInMainWorld("shortcutApi", {',
    '  getData: () => ipcRenderer.invoke("shortcuts-get"),',
    '  save: (map) => ipcRenderer.invoke("shortcuts-save", map),',
    '  reset: () => ipcRenderer.invoke("shortcuts-reset"),',
    '  close: () => ipcRenderer.send("shortcuts-close"),',
    "});",
  ].join("\n");

  const editorHtml = [
    "<!DOCTYPE html><html><head><meta charset='UTF-8'><title>Keyboard Shortcuts</title>",
    "<style>",
    "*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI Variable','Segoe UI',system-ui,sans-serif}",
    "html,body{width:100%;height:100%;overflow:hidden;background:transparent;color:#f5f5f7;user-select:none;-webkit-font-smoothing:antialiased}",
    "body{padding:4px}",
    ".panel{width:100%;height:100%;display:flex;flex-direction:column;border-radius:22px;background:linear-gradient(180deg,#18181b 0%,#0b0b0d 100%);border:1px solid rgba(255,255,255,0.14);box-shadow:0 0 0 1px rgba(0,0,0,0.82),inset 0 1px 0 rgba(255,255,255,0.12);overflow:hidden}",
    ".top{-webkit-app-region:drag;display:flex;align-items:center;justify-content:space-between;padding:18px 20px 14px;border-bottom:1px solid rgba(255,255,255,0.08)}",
    ".brand{display:flex;align-items:center;gap:10px}",
    ".mark{width:13px;height:13px;background:#f5f5f7;clip-path:polygon(0 0,100% 62%,56% 68%,78% 100%,58% 100%,38% 72%,0 90%)}",
    ".title-wrap h2{font-size:15px;font-weight:600;letter-spacing:-0.025em;line-height:1.15}",
    ".title-wrap p{font-size:11.5px;color:#86868b;margin-top:2px}",
    ".close{-webkit-app-region:no-drag;width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,0.09);background:rgba(255,255,255,0.06);color:#a1a1a6;font-size:15px;cursor:pointer;display:grid;place-items:center;transition:background 0.15s,color 0.15s}",
    ".close:hover{background:rgba(255,255,255,0.16);color:#fff}",
    ".scroll{flex:1;overflow-y:auto;padding:14px 18px 8px;display:flex;flex-direction:column;gap:16px}",
    ".scroll::-webkit-scrollbar{width:5px}.scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.14);border-radius:999px}",
    ".grp-title{font-size:10.5px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#6e6e73;padding:0 4px 7px}",
    ".grp-box{border-radius:16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);overflow:hidden}",
    ".row{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.06);gap:12px;transition:background 0.14s}",
    ".row:last-child{border-bottom:none}",
    ".row:hover{background:rgba(255,255,255,0.03)}",
    ".lbl{font-size:12.5px;font-weight:450;color:#e5e5ea;letter-spacing:-0.01em}",
    ".ctrl{display:flex;align-items:center;gap:7px}",
    ".keybtn{min-width:136px;height:30px;padding:0 10px;border-radius:10px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#f5f5f7;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:4px;transition:border-color 0.15s,background 0.15s}",
    ".keybtn:hover{border-color:rgba(255,255,255,0.22);background:rgba(255,255,255,0.08)}",
    ".keybtn.rec{border-color:rgba(10,132,255,0.8);background:rgba(10,132,255,0.14);color:#7dc4ff}",
    ".keybtn.clash{border-color:rgba(255,179,64,0.6);background:rgba(255,179,64,0.08)}",
    ".cap{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;padding:0 6px;border-radius:6px;font-size:11px;font-weight:600;color:#f5f5f7;background:linear-gradient(180deg,#323236 0%,#222225 100%);border:1px solid rgba(255,255,255,0.14);box-shadow:inset 0 1px 0 rgba(255,255,255,0.12)}",
    ".plus{font-size:10px;color:#6e6e73;font-weight:500}",
    ".off-txt{font-size:11px;color:#6e6e73;font-weight:500}",
    ".rec-txt{font-size:11px;color:#7dc4ff;font-weight:500;letter-spacing:0.01em}",
    ".clash-tag{font-size:9px;font-weight:600;color:#ffb340;margin-left:3px;text-transform:uppercase}",
    ".clr{width:24px;height:24px;border-radius:50%;border:1px solid transparent;background:transparent;color:#6e6e73;font-size:13px;cursor:pointer;display:grid;place-items:center;transition:all 0.15s}",
    ".clr:hover{background:rgba(255,255,255,0.09);color:#fff}",
    ".clr.dim{opacity:0.25;pointer-events:none}",
    ".foot{padding:12px 18px 16px;border-top:1px solid rgba(255,255,255,0.08);background:rgba(0,0,0,0.22)}",
    ".msg{font-size:11.5px;color:#34d399;min-height:16px;margin-bottom:10px;padding:0 2px}",
    ".msg.warn{color:#ffb340}",
    ".bar{display:flex;justify-content:space-between;align-items:center;gap:8px}",
    ".btn{height:34px;padding:0 16px;border-radius:999px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:#e5e5ea;font-size:12px;font-weight:500;cursor:pointer;transition:background 0.15s,border-color 0.15s}",
    ".btn:hover{background:rgba(255,255,255,0.13);border-color:rgba(255,255,255,0.2)}",
    ".btn.primary{background:#0071e3;border-color:#0071e3;color:#fff;font-weight:600}",
    ".btn.primary:hover{background:#0077ed}",
    "</style></head><body>",
    "<div class='panel'>",
    "  <div class='top'>",
    "    <div class='brand'>",
    "      <span class='mark'></span>",
    "      <div class='title-wrap'><h2>Keyboard Shortcuts</h2><p>Click any keycap to rebind, or × to disable</p></div>",
    "    </div>",
    "    <button class='close' id='topClose' type='button' title='Close'>×</button>",
    "  </div>",
    "  <div class='scroll' id='list'></div>",
    "  <div class='foot'>",
    "    <div class='msg' id='msg'></div>",
    "    <div class='bar'>",
    "      <button class='btn' id='resetBtn' type='button'>Reset Defaults</button>",
    "      <div style='display:flex;gap:8px'>",
    "        <button class='btn' id='closeBtn' type='button'>Cancel</button>",
    "        <button class='btn primary' id='saveBtn' type='button'>Save &amp; Apply</button>",
    "      </div>",
    "    </div>",
    "  </div>",
    "</div>",
    "<script>",
    "let state = {}; let labels = []; let failed = new Set(); let activeKey = null;",
    "function keyToAccel(e) {",
    "  const mods = [];",
    "  if (e.ctrlKey) mods.push('Control');",
    "  if (e.altKey) mods.push('Alt');",
    "  if (e.shiftKey) mods.push('Shift');",
    "  if (e.metaKey) mods.push('Super');",
    "  const k = e.key;",
    "  const c = e.code || '';",
    "  if (['Control','Alt','Shift','Meta'].includes(k)) return null;",
    "  if (k === 'Escape') return 'CANCEL';",
    "  let main = '';",
    "  if (/^F([1-9]|1[0-2])$/i.test(k)) main = k.toUpperCase();",
    "  else if (/^Key([A-Z])$/.test(c)) main = c.slice(3);",
    "  else if (/^Digit([0-9])$/.test(c)) main = c.slice(5);",
    "  else if (k === ' ') main = 'Space';",
    "  else if (k === 'Enter') main = 'Enter';",
    "  else if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(k)) main = k.replace('Arrow','');",
    "  else if (['Tab','Backspace','Delete','Insert','Home','End','PageUp','PageDown'].includes(k)) main = k;",
    "  else if (k.length === 1) main = k.toUpperCase();",
    "  else return null;",
    "  if (mods.length === 0 && !/^F([1-9]|1[0-2])$/.test(main)) return null;",
    "  return mods.concat([main]).join('+');",
    "}",
    "function formatCap(tok) {",
    "  if (tok === 'Control') return 'Ctrl';",
    "  if (tok === 'Super') return 'Win';",
    "  return tok;",
    "}",
    "function fillKeyButton(btn, id, val) {",
    "  btn.textContent = '';",
    "  if (activeKey === id) {",
    "    const s = document.createElement('span'); s.className = 'rec-txt'; s.textContent = 'Press keys...'; btn.appendChild(s); return;",
    "  }",
    "  if (!val) {",
    "    const s = document.createElement('span'); s.className = 'off-txt'; s.textContent = 'Disabled'; btn.appendChild(s); return;",
    "  }",
    "  const parts = val.split('+').filter(Boolean);",
    "  parts.forEach((p, i) => {",
    "    if (i > 0) { const pl = document.createElement('span'); pl.className = 'plus'; pl.textContent = '+'; btn.appendChild(pl); }",
    "    const cap = document.createElement('span'); cap.className = 'cap'; cap.textContent = formatCap(p); btn.appendChild(cap);",
    "  });",
    "  if (failed.has(id)) { const cl = document.createElement('span'); cl.className = 'clash-tag'; cl.textContent = 'Clash'; btn.appendChild(cl); }",
    "}",
    "function render() {",
    "  const list = document.getElementById('list');",
    "  list.textContent = '';",
    "  const groups = new Map();",
    "  labels.forEach(([id, title, grp]) => {",
    "    const g = grp || 'Shortcuts';",
    "    if (!groups.has(g)) groups.set(g, []);",
    "    groups.get(g).push([id, title]);",
    "  });",
    "  groups.forEach((items, gName) => {",
    "    const sec = document.createElement('div');",
    "    const gt = document.createElement('div'); gt.className = 'grp-title'; gt.textContent = gName; sec.appendChild(gt);",
    "    const box = document.createElement('div'); box.className = 'grp-box';",
    "    items.forEach(([id, title]) => {",
    "      const row = document.createElement('div'); row.className = 'row';",
    "      const lbl = document.createElement('div'); lbl.className = 'lbl'; lbl.textContent = title;",
    "      const ctrl = document.createElement('div'); ctrl.className = 'ctrl';",
    "      const val = state[id] || '';",
    "      const btn = document.createElement('button'); btn.type = 'button';",
    "      btn.className = 'keybtn' + (activeKey === id ? ' rec' : '') + (failed.has(id) ? ' clash' : '');",
    "      fillKeyButton(btn, id, val);",
    "      btn.onclick = () => { activeKey = (activeKey === id ? null : id); render(); };",
    "      const clr = document.createElement('button'); clr.type = 'button';",
    "      clr.className = 'clr' + (val ? '' : ' dim'); clr.textContent = '×'; clr.title = 'Disable shortcut';",
    "      clr.onclick = () => { state[id] = ''; activeKey = null; failed.delete(id); render(); };",
    "      ctrl.appendChild(btn); ctrl.appendChild(clr);",
    "      row.appendChild(lbl); row.appendChild(ctrl); box.appendChild(row);",
    "    });",
    "    sec.appendChild(box); list.appendChild(sec);",
    "  });",
    "}",
    "window.addEventListener('keydown', (e) => {",
    "  if (!activeKey) { if (e.key === 'Escape') window.shortcutApi.close(); return; }",
    "  e.preventDefault(); e.stopPropagation();",
    "  const acc = keyToAccel(e);",
    "  if (acc === 'CANCEL') { activeKey = null; render(); return; }",
    "  if (acc) { state[activeKey] = acc; failed.delete(activeKey); activeKey = null; render(); }",
    "});",
    "document.getElementById('saveBtn').onclick = async () => {",
    "  const res = await window.shortcutApi.save(state);",
    "  state = res.shortcuts; failed = new Set(res.failed || []);",
    "  const m = document.getElementById('msg');",
    "  m.className = 'msg' + (failed.size ? ' warn' : '');",
    "  m.textContent = failed.size ? 'Saved — amber shortcuts clashed with another app.' : 'Shortcuts saved and active.';",
    "  render();",
    "};",
    "document.getElementById('resetBtn').onclick = async () => {",
    "  const res = await window.shortcutApi.reset();",
    "  state = res.shortcuts; failed = new Set(res.failed || []);",
    "  const m = document.getElementById('msg'); m.className = 'msg';",
    "  m.textContent = 'Restored default shortcuts.';",
    "  render();",
    "};",
    "document.getElementById('closeBtn').onclick = () => window.shortcutApi.close();",
    "document.getElementById('topClose').onclick = () => window.shortcutApi.close();",
    "window.shortcutApi.getData().then((d) => { state = d.shortcuts; labels = d.labels; failed = new Set(d.failed || []); render(); });",
    "</script></body></html>",
  ].join("\n");

  fs.mkdirSync(path.dirname(SHORTCUT_PRELOAD_PATH), { recursive: true });
  fs.writeFileSync(SHORTCUT_PRELOAD_PATH, preloadCode, "utf8");
  fs.writeFileSync(SHORTCUT_HTML_PATH, editorHtml, "utf8");
}

function openShortcutEditor() {
  if (shortcutWin && !shortcutWin.isDestroyed()) {
    shortcutWin.show();
    shortcutWin.focus();
    return;
  }

  ensureShortcutEditorAssets();
  globalShortcut.unregisterAll();
  escRegistered = false;

  const win = new BrowserWindow({
    width: 560,
    height: 600,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    thickFrame: false,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    title: "Cursor Companion — Shortcuts",
    webPreferences: {
      preload: SHORTCUT_PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  shortcutWin = win;
  hardenWindow(win);

  win.on("closed", () => {
    if (shortcutWin === win) shortcutWin = null;
    registerAllShortcuts();
    rebuildTrayMenu();
  });

  win.loadFile(SHORTCUT_HTML_PATH);
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

async function captureAroundCursorBuffer(boxW = 960, boxH = 680, fullScreen = false, vBias = 0.35) {
  const pt = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(pt);
  const { image, sf } = await captureDisplayNative(disp);
  const sz = image.getSize();

  if (fullScreen) {
    return image.toJPEG(74);
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
    Math.min(Math.round(relY * sf - cropH * vBias), sz.height - cropH)
  );

  return image.crop({ x: left, y: top, width: cropW, height: cropH }).toJPEG(78);
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
    return captureAroundCursorBuffer(960, 680, false, 0.35);
  }

  const pad = Math.round(28 * sf);
  const x = Math.max(0, Math.round(Math.min(relX1, relX2) * sf - pad));
  const y = Math.max(0, Math.round(Math.min(relY1, relY2) * sf - pad));
  const w = Math.min(sz.width - x, Math.round(rawW * sf + pad * 2));
  const h = Math.min(sz.height - y, Math.round(rawH * sf + pad * 2));

  if (w < 10 || h < 10) {
    return captureAroundCursorBuffer(960, 680, false, 0.35);
  }

  return image.crop({ x, y, width: w, height: h }).toJPEG(80);
}

function grabSelectedTextDirectly() {
  if (process.platform !== "win32") {
    return Promise.resolve("");
  }

  return new Promise((resolve) => {
    const sentinel = `__CC_WAIT_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    const prev = clipboard.readText();
    let settled = false;
    let psExitedAt = 0;

    clipboard.writeText(sentinel);

    const ps = `
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);' -Name K -Namespace U;
try {
  [U.K]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero);
  [U.K]::keybd_event(0xA4, 0, 2, [UIntPtr]::Zero);
  [U.K]::keybd_event(0xA5, 0, 2, [UIntPtr]::Zero);
  [U.K]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero);
  Start-Sleep -Milliseconds 30;
  [U.K]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero);
  [U.K]::keybd_event(0x43, 0, 0, [UIntPtr]::Zero);
  Start-Sleep -Milliseconds 15;
} finally {
  [U.K]::keybd_event(0x43, 0, 2, [UIntPtr]::Zero);
  [U.K]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero);
  [U.K]::keybd_event(0xA2, 0, 2, [UIntPtr]::Zero);
  [U.K]::keybd_event(0xA3, 0, 2, [UIntPtr]::Zero);
}
`;

    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
      { windowsHide: true },
      () => {
        psExitedAt = Date.now();
      }
    );

    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      setTimeout(() => {
        try {
          clipboard.writeText(prev);
        } catch (_) {}
        resolve(val);
      }, 35);
    };

    let checks = 0;
    const poll = setInterval(() => {
      checks++;
      const current = clipboard.readText();
      if (current && current !== sentinel) {
        finish(current.trim());
      } else if (psExitedAt > 0 && Date.now() - psExitedAt > 140) {
        finish("");
      } else if (checks >= 72) {
        finish("");
      }
    }, 25);
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
try {
  [U.K]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero);
  [U.K]::keybd_event(0xA4, 0, 2, [UIntPtr]::Zero);
  [U.K]::keybd_event(0xA5, 0, 2, [UIntPtr]::Zero);
  Start-Sleep -Milliseconds 35;
  [U.K]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero);
  [U.K]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero);
  Start-Sleep -Milliseconds 15;
} finally {
  [U.K]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero);
  [U.K]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero);
  [U.K]::keybd_event(0xA2, 0, 2, [UIntPtr]::Zero);
  [U.K]::keybd_event(0xA3, 0, 2, [UIntPtr]::Zero);
}
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
    const buf = await captureAroundCursorBuffer(960, 680, false, 0.35);
    if (activeRequestId !== reqId) return;

    let res = await runAnalysisPipeline({
      imageBase64: buf.toString("base64"),
      actionMode: "solve",
    });
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
      showHud(
        {
          mode: "error",
          cursor_pill: "Retry scan",
          key_source: settings.userApiKey ? "BYOK" : "POOL",
        },
        2400
      );
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
        cursor_pill: "Corner 1 set · tap bottom-right",
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

    const res = await runAnalysisPipeline({
      imageBase64: buf.toString("base64"),
      actionMode: "solve",
    });
    if (activeRequestId !== reqId) return;

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + "s";
    handleResult(res, elapsed, "[2-Corner Snip]");
  } catch (_) {
    if (activeRequestId === reqId) {
      showHud(
        {
          mode: "error",
          cursor_pill: "Retry snip",
          key_source: settings.userApiKey ? "BYOK" : "POOL",
        },
        2400
      );
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
      const buf = await captureAroundCursorBuffer(960, 680, false, 0.58);
      if (activeRequestId !== reqId) return;
      sourceLabel = `[Cursor ${actionMode} Scan]`;
      res = await runAnalysisPipeline({
        imageBase64: buf.toString("base64"),
        actionMode,
      });
    }

    if (activeRequestId !== reqId) return;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + "s";
    handleResult(res, elapsed, sourceLabel);
  } catch (_) {
    if (activeRequestId === reqId) {
      showHud(
        {
          mode: "error",
          cursor_pill: "Retry hotkey",
          key_source: settings.userApiKey ? "BYOK" : "POOL",
        },
        2400
      );
    }
  } finally {
    finishRequest(reqId);
  }
}

function handleResult(res, elapsed, sourceContext) {
  const defaultSrc = settings.userApiKey ? "BYOK" : "POOL";
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
        key_source: (res && res.key_source) || defaultSrc,
      },
      3200
    );
    return;
  }

  const context = String(sourceContext || "");
  const isUnclear = /unclear crop/i.test(String(res.cursor_pill));

  const item = {
    ...res,
    key_source: res.key_source || defaultSrc,
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
      showHud(
        {
          mode: "error",
          cursor_pill: "Retry Spotlight",
          key_source: settings.userApiKey ? "BYOK" : "POOL",
        },
        2400
      );
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
            cursor_pill: resp.message || "Pro Pool Unlocked",
            key_source: "PRO",
            elapsed: "✓",
          },
          3200
        );
      } else {
        showHud(
          {
            mode: "error",
            cursor_pill: (resp && resp.message) || "Could not verify shared key",
            key_source: "POOL",
          },
          3400
        );
      }
    } catch (_) {
      showHud(
        {
          mode: "error",
          cursor_pill: "Share check failed — retry",
          key_source: "POOL",
        },
        2800
      );
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
      2400
    );
    return;
  }

  showHud({ mode: "loading", cursor_pill: "•••" });
  const t0 = Date.now();
  const check = await executeDirectByok(
    cleanKey,
    'Return ONLY JSON: {"verification":"ok","detected_type":"DIRECT_VALUE","cursor_pill":"Key verified","copy_value":"","expanded_note":""}',
    null,
    "solve"
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + "s";

  if (check && check.detected_type !== "ERROR") {
    showHud(
      {
        mode: "result",
        detected_type: "DIRECT_VALUE",
        cursor_pill: "Personal key verified",
        key_source: "BYOK",
        elapsed,
      },
      2800
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

ipcMain.on("hud-hide", hideOverlaysOnly);

ipcMain.on("hud-open-update", () => {
  const info = getUpdateInfo();
  if (info.url && info.url.startsWith("https://")) {
    shell.openExternal(info.url);
  }
});

ipcMain.on("hud-dismiss-update", (_event, ver) => {
  if (typeof ver === "string" && ver.trim()) {
    saveSettings({ dismissedUpdateVersion: cleanVersionString(ver) });
    syncSidecar();
  }
});

ipcMain.on("hud-check-update", () => {
  syncRemoteConfigAndUpdates(true);
});

ipcMain.handle("shortcuts-get", () => ({
  shortcuts: settings.shortcuts,
  labels: SHORTCUT_LABELS,
  failed: Array.from(failedShortcuts),
}));

ipcMain.handle("shortcuts-save", (_event, nextMap) => {
  saveSettings({ shortcuts: sanitizeShortcutsMap(nextMap) });
  registerAllShortcuts();
  const clashes = Array.from(failedShortcuts);
  if (shortcutWin && !shortcutWin.isDestroyed()) {
    globalShortcut.unregisterAll();
    escRegistered = false;
  }
  rebuildTrayMenu();
  return { ok: true, shortcuts: settings.shortcuts, failed: clashes };
});

ipcMain.handle("shortcuts-reset", () => {
  saveSettings({ shortcuts: { ...DEFAULT_SHORTCUTS } });
  registerAllShortcuts();
  const clashes = Array.from(failedShortcuts);
  if (shortcutWin && !shortcutWin.isDestroyed()) {
    globalShortcut.unregisterAll();
    escRegistered = false;
  }
  rebuildTrayMenu();
  return { ok: true, shortcuts: settings.shortcuts, failed: clashes };
});

ipcMain.on("shortcuts-close", () => {
  if (shortcutWin && !shortcutWin.isDestroyed()) {
    shortcutWin.close();
  }
});

function getActionHandlers() {
  return {
    smartScan: handleInstantScan,
    smartScanAlt: handleInstantScan,
    twoCornerSnip: handleTwoCornerSnip,
    twoCornerSnipAlt: handleTwoCornerSnip,
    solveText: () => handleTextAction("solve"),
    rewriteText: () => handleTextAction("rewrite"),
    explainText: () => handleTextAction("explain"),
    ghostPaste: ghostPasteActiveValue,
    spotlight: () => openSpotlight("ask"),
    followup: () => openSpotlight("followup"),
    apiKey: () => openSpotlight("key"),
    sidecar: toggleSidecar,
    pinHud: () => {
      isPinned = !isPinned;
      clearTimeout(hideTimer);
      if (history[historyIdx]) {
        showHud(history[historyIdx], 0);
      } else if (!isPinned && hudWin && !hudWin.isDestroyed()) {
        if (hudWin.isVisible()) startCursorFollow();
      }
    },
    cycleHistory: () => {
      if (!history.length) return;
      const visible = hudWin && !hudWin.isDestroyed() && hudWin.isVisible();
      if (!visible) {
        historyIdx = 0;
      } else {
        historyIdx = (historyIdx + 1) % history.length;
      }
      showHud(history[historyIdx], 8500);
      syncSidecar();
    },
    hideOnly: hideOverlaysOnly,
    forceReset: forceResetAll,
  };
}

function registerAllShortcuts() {
  globalShortcut.unregisterAll();
  escRegistered = false;
  failedShortcuts.clear();

  const handlers = getActionHandlers();
  const seenAccels = new Set();

  for (const [id, handler] of Object.entries(handlers)) {
    const accel = String(settings.shortcuts[id] || "").trim();
    if (!accel) continue;
    const norm = accel.toLowerCase();
    if (seenAccels.has(norm)) {
      failedShortcuts.add(id);
      continue;
    }
    try {
      const ok = globalShortcut.register(accel, handler);
      if (ok) {
        seenAccels.add(norm);
      } else {
        failedShortcuts.add(id);
      }
    } catch (_) {
      failedShortcuts.add(id);
    }
  }
  syncEscapeShortcut();
}

function fmtKey(id) {
  return settings.shortcuts[id] || "Off";
}

function rebuildTrayMenu() {
  if (!tray) return;

  const info = getUpdateInfo();

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
    { label: `Cursor Companion v${info.currentVersion}`, enabled: false },
  ];

  if (info.available) {
    template.push({
      label: `⬇ Download Update (v${info.version})`,
      click: () => shell.openExternal(info.url),
    });
  }

  if (info.notice) {
    template.push({
      label: `ℹ ${info.notice.slice(0, 48)}`,
      enabled: false,
    });
  }

  template.push(
    { type: "separator" },
    { label: `Smart Scan (${fmtKey("smartScan")} / ${fmtKey("smartScanAlt")})`, click: () => handleInstantScan() },
    { label: `2-Corner Snip (${fmtKey("twoCornerSnip")} / ${fmtKey("twoCornerSnipAlt")})`, click: () => handleTwoCornerSnip() },
    { label: `Solve Selection (${fmtKey("solveText")})`, click: () => handleTextAction("solve") },
    { label: `Rewrite Selection (${fmtKey("rewriteText")})`, click: () => handleTextAction("rewrite") },
    { label: `Explain Selection (${fmtKey("explainText")})`, click: () => handleTextAction("explain") },
    { type: "separator" },
    { label: "Mode Packs", submenu: packSubmenu },
    {
      label:
        failedShortcuts.size > 0
          ? `⚠ Customize Shortcuts (${failedShortcuts.size} clash)...`
          : "Customize Shortcuts...",
      click: () => openShortcutEditor(),
    },
    { type: "separator" },
    { label: `Spotlight Bar (${fmtKey("spotlight")})`, click: () => openSpotlight("ask") },
    { label: `Study Sidecar (${fmtKey("sidecar")})`, click: () => toggleSidecar() },
    { label: `Personal Key / Share Pro (${fmtKey("apiKey")})`, click: () => openSpotlight("key") },
    { label: `Vanish Overlay (${fmtKey("hideOnly")})`, click: () => hideOverlaysOnly() },
    { label: `Force Cancel / Reset (${fmtKey("forceReset")})`, click: () => forceResetAll() },
    { type: "separator" },
    { label: "Check for Updates...", click: () => syncRemoteConfigAndUpdates(true) },
    { label: "Quit", click: () => app.quit() }
  );

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("Cursor Companion");
  rebuildTrayMenu();
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
      registerAllShortcuts();
      createTray();

      setTimeout(() => syncRemoteConfigAndUpdates(false), 4000);
      updateCheckTimer = setInterval(() => syncRemoteConfigAndUpdates(false), 6 * 60 * 60 * 1000);
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
  clearInterval(updateCheckTimer);
  stopCursorFollow();
  globalShortcut.unregisterAll();
});
