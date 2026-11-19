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
} = require("electron");

const path = require("path");
const fs = require("fs");
const https = require("https");
const crypto = require("crypto");
const { execFile } = require("child_process");

const BACKEND_URL = "https://study-buddy-brain.onrender.com";

let SETTINGS_PATH = "";

let hudWin = null;
let snipWin = null;
let spotlightWin = null;
let sidecarWin = null;
let tray = null;

let isPinned = false;
let isBusy = false;
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

let settings = {
  userApiKey: "",
  autoCopy: true,
  deviceId: crypto.randomUUID(),
};

const LOCAL_CACHE = new Map();
const LOCAL_CACHE_TTL = 45 * 60 * 1000;
const BYOK_COOLDOWN = new Map();

function isByokCoolingDown(key, model) {
  const cacheKey = `${key}:${model}`;
  const until = BYOK_COOLDOWN.get(cacheKey);
  if (!until) return false;
  if (Date.now() >= until) {
    BYOK_COOLDOWN.delete(cacheKey);
    return false;
  }
  return true;
}

function setByokCooldown(key, model, ms) {
  BYOK_COOLDOWN.set(`${key}:${model}`, Date.now() + ms);
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

  return normalized.length >= 25 ? `${mode}:${normalized}` : "";
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
  SETTINGS_PATH = path.join(app.getPath("userData"), "v3-settings.json");
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
    ...saved,
    userApiKey: typeof saved.userApiKey === "string" ? saved.userApiKey : "",
    autoCopy: typeof saved.autoCopy === "boolean" ? saved.autoCopy : true,
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
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
  } catch (error) {
    console.error("Unable to save settings:", error.message);
  }
}

function enforceCaptureInvisibility(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setContentProtection(true);
  } catch (_) {}

  if (process.platform === "win32") {
    const applyAffinity = () => {
      if (!win || win.isDestroyed()) return;
      try {
        const hwndBuf = win.getNativeWindowHandle();
        const hwnd =
          hwndBuf.length >= 8
            ? Number(hwndBuf.readBigUInt64LE(0))
            : hwndBuf.readUInt32LE(0);
        const ps = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);' -Name W32 -Namespace N; [N.W32]::SetWindowDisplayAffinity([IntPtr]${hwnd}, 0x00000011) | Out-Null`;
        execFile(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
          { windowsHide: true },
          () => {}
        );
      } catch (_) {}
    };
    applyAffinity();
    setTimeout(applyAffinity, 45);
  }
}

function dismissAllOverlays() {
  isPinned = false;
  clearTimeout(hideTimer);
  stopCursorFollow();

  if (snipWin && !snipWin.isDestroyed()) {
    snipWin.close();
    snipWin = null;
  }

  for (const win of [spotlightWin, sidecarWin, hudWin]) {
    if (win && !win.isDestroyed()) win.hide();
  }

  syncEscapeShortcut();
}

function syncEscapeShortcut() {
  const anyOpen = [hudWin, snipWin, spotlightWin, sidecarWin].some(
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

// Force IPv4 (family: 4) to prevent ASUS TUF / Windows IPv6 DNS stalls
function httpsJsonRequest(urlStr, headers, bodyObj, timeoutMs = 15000) {
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

function parseModelJsonResponse(rawText) {
  const cleaned = String(rawText || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "")
    .replace(/```(?:json)?|```/gi, "")
    .trim();

  let bestObj = null;
  const regex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  let match;

  while ((match = regex.exec(cleaned)) !== null) {
    try {
      const candidate = JSON.parse(match[0]);
      if (candidate && candidate.cursor_pill) {
        bestObj = candidate;
      }
    } catch (_) {}
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
    temperature: 0.0,
    maxOutputTokens: 1200,
  };

  // Bound thinking budget on 3.8/3.5 Flash so it verifies accurately without timing out
  if (!model.includes("lite")) {
    generationConfig.thinkingConfig = { thinkingBudget: 1024 };
  }

  let res = await httpsJsonRequest(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    {},
    { contents: [{ parts }], generationConfig },
    reqTimeout
  );

  // Clean fallback if a specific endpoint/key rejects thinkingConfig
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

  if (res.status === 429) {
    setByokCooldown(key, model, 20000);
  } else if (res.status === 404 || res.status === 400) {
    setByokCooldown(key, model, 3600000);
  }
  throw new Error(`${model}:${res.status}`);
}

async function querySingleOpenAiCompat(key, endpoint, model, isGroq, sysInstruction, promptText, imgB64, reqTimeout) {
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
    max_tokens: 1400,
  };

  if (isGroq && model.includes("gpt-oss")) {
    body.reasoning_effort = "medium";
  }
  if (isGroq && !imgB64) {
    body.response_format = { type: "json_object" };
  }

  let res = await httpsJsonRequest(
    endpoint,
    { Authorization: `Bearer ${key}` },
    body,
    reqTimeout
  );

  if (res.status === 400 && (body.response_format || body.reasoning_effort)) {
    delete body.response_format;
    delete body.reasoning_effort;
    res = await httpsJsonRequest(
      endpoint,
      { Authorization: `Bearer ${key}` },
      body,
      reqTimeout
    );
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

  if (res.status === 429) {
    setByokCooldown(key, model, 20000);
  } else if (res.status === 400 || res.status === 404) {
    setByokCooldown(key, model, 3600000);
  }
  throw new Error(`${model}:${res.status}`);
}

// Accuracy-first BYOK: prioritizes gemini-3.8-flash / gpt-oss-120b with 24s timeout
async function executeDirectByok(keysRaw, promptText, imgB64, actionMode) {
  const keys = sanitizeApiKeys(keysRaw);

  if (!keys.length) {
    return {
      detected_type: "ERROR",
      cursor_pill: "Invalid key format in Alt+K",
      copy_value: "",
      expanded_note: "Paste a valid API key starting with AIza, AQ., gsk_, nvapi-, sk-or-, or sk-",
      key_source: "BYOK",
    };
  }

  const sysInstruction = buildByokInstruction(actionMode);
  const reqTimeout = 24000;
  const failReasons = [];

  for (const key of keys) {
    if (key.startsWith("AIza") || key.startsWith("AQ.")) {
      const models = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
      for (const model of models) {
        if (isByokCoolingDown(key, model)) continue;
        try {
          return await querySingleGeminiModel(key, model, sysInstruction, promptText, imgB64, reqTimeout);
        } catch (err) {
          failReasons.push(err.message || "err");
        }
      }
    } else if (key.startsWith("gsk_") || key.startsWith("nvapi-") || key.startsWith("sk-")) {
      const isGroq = key.startsWith("gsk_");
      const isNvidia = key.startsWith("nvapi-");
      const isOr = key.startsWith("sk-or-");

      const endpoint = isGroq
        ? "https://api.groq.com/openai/v1/chat/completions"
        : isNvidia
          ? "https://integrate.api.nvidia.com/v1/chat/completions"
          : isOr
            ? "https://openrouter.ai/api/v1/chat/completions"
            : "https://api.openai.com/v1/chat/completions";

      const modelList = isGroq
        ? imgB64
          ? ["qwen/qwen3.8-27b", "openai/gpt-oss-120b"]
          : ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"]
        : isNvidia
          ? ["nvidia/nemotron-3.5-super-vl-120b-a12b", "nvidia/nemotron-3.5-lightning-30b-a3b"]
          : isOr
            ? ["google/gemma-4-31b-it:free", "openrouter/free"]
            : ["gpt-4o-mini"];

      for (const model of modelList) {
        if (isByokCoolingDown(key, model)) continue;
        try {
          return await querySingleOpenAiCompat(key, endpoint, model, isGroq, sysInstruction, promptText, imgB64, reqTimeout);
        } catch (err) {
          failReasons.push(err.message || "err");
        }
      }
    } else {
      failReasons.push(`BadPrefix(${key.slice(0, 4)})`);
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

async function postJsonWithJitterRetry(endpoint, payload, retries = 1) {
  const url = new URL(endpoint, BACKEND_URL);
  const reqTimeout = payload.image_base64 ? 26000 : 18000;

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
          setTimeout(resolve, 250 + Math.floor(Math.random() * 400))
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
        setTimeout(resolve, 250 + Math.floor(Math.random() * 400))
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
    },
  });

  hudWin = win;

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

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

  x = Math.round(
    Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - lockedW - 4))
  );
  y = Math.round(
    Math.max(wa.y + 4, Math.min(y, wa.y + wa.height - lockedH - 4))
  );

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
    payload.key_source === "CACHE"
      ? 72
      : 58;

  lockedW = isLoading
    ? 54
    : Math.max(126, Math.min(340, Math.round(textLen * 7.5 + badgeReserve)));
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
    },
  });

  spotlightWin = win;

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

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
    },
  });

  sidecarWin = win;

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.webContents.once("did-finish-load", () => {
    if (win.isDestroyed()) return;
    win.showInactive();
    enforceCaptureInvisibility(win);
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

// Wider high-DPI safe capture (920x640 default; auto-escalates to 1280x860 if cropped)
async function captureAroundCursor(boxW = 920, boxH = 640) {
  const pt = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(pt);
  const { image, sf } = await captureDisplayNative(disp);

  const relX = pt.x - disp.bounds.x;
  const relY = pt.y - disp.bounds.y;
  const sz = image.getSize();

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

  return image
    .crop({ x: left, y: top, width: cropW, height: cropH })
    .toJPEG(86)
    .toString("base64");
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
Start-Sleep -Milliseconds 35;
[U.K]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero);
[U.K]::keybd_event(0x43, 0, 0, [UIntPtr]::Zero);
Start-Sleep -Milliseconds 25;
[U.K]::keybd_event(0x43, 0, 2, [UIntPtr]::Zero);
[U.K]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero);
`;

    const triggerCopy = () => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
        { windowsHide: true },
        () => {}
      );
    };

    triggerCopy();

    let checks = 0;

    const poll = setInterval(() => {
      checks++;
      const current = clipboard.readText();

      if (current && current !== sentinel) {
        clearInterval(poll);
        clipboard.writeText(prev);
        resolve(current.trim());
      } else if (checks === 9) {
        triggerCopy();
      } else if (checks >= 22) {
        clearInterval(poll);
        clipboard.writeText(prev);
        resolve("");
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
  isBusy = true;
  const t0 = Date.now();

  try {
    showHud({ mode: "loading", cursor_pill: "•••" });
    const b64 = await captureAroundCursor(920, 640);
    let res = await runAnalysisPipeline({
      imageBase64: b64,
      actionMode: "solve",
    });

    // Auto-escalate to wide 1280x860 capture if high-DPI screen cut off options
    if (res && /unclear crop/i.test(String(res.cursor_pill || ""))) {
      const wideB64 = await captureAroundCursor(1280, 860);
      res = await runAnalysisPipeline({
        imageBase64: wideB64,
        actionMode: "solve",
      });
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + "s";
    handleResult(res, elapsed, "[Cursor Question Scan]");
  } catch (_) {
    showHud({ mode: "error", cursor_pill: "Retry Alt+A" }, 2400);
  } finally {
    isBusy = false;
  }
}

async function handleTextAction(actionMode = "solve") {
  if (isBusy) return;
  isBusy = true;
  const t0 = Date.now();

  try {
    showHud({ mode: "loading", cursor_pill: "•••" });
    const selected = await grabSelectedTextDirectly();
    let res;
    let sourceLabel = selected;

    if (selected) {
      res = await runAnalysisPipeline({
        textContent: selected,
        actionMode,
      });
    } else {
      const b64 = await captureAroundCursor(920, 640);
      sourceLabel = `[Highlighted ${actionMode} Scan]`;
      res = await runAnalysisPipeline({
        imageBase64: b64,
        actionMode,
      });
      if (res && /unclear crop/i.test(String(res.cursor_pill || ""))) {
        const wideB64 = await captureAroundCursor(1280, 860);
        res = await runAnalysisPipeline({
          imageBase64: wideB64,
          actionMode,
        });
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + "s";
    handleResult(res, elapsed, sourceLabel);
  } catch (_) {
    showHud({ mode: "error", cursor_pill: "Retry hotkey" }, 2400);
  } finally {
    isBusy = false;
  }
}

function handleRegionSnip() {
  if (isBusy) return;

  const pt = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(pt);

  if (snipWin && !snipWin.isDestroyed()) {
    snipWin.close();
    snipWin = null;
  }

  const win = new BrowserWindow({
    x: disp.bounds.x,
    y: disp.bounds.y,
    width: disp.bounds.width,
    height: disp.bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    thickFrame: false,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  snipWin = win;

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.webContents.once("did-finish-load", () => {
    if (win.isDestroyed()) return;
    win.showInactive();
    enforceCaptureInvisibility(win);
    syncEscapeShortcut();
    win.webContents.send("snip-init", { displayId: disp.id });
  });

  win.on("closed", () => {
    if (snipWin === win) snipWin = null;
    syncEscapeShortcut();
  });

  win.loadFile(path.join(__dirname, "index.html"), {
    hash: "snip",
  });
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
      2800
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

ipcMain.on("snip-complete", async (_event, rect) => {
  if (snipWin && !snipWin.isDestroyed()) {
    snipWin.close();
    snipWin = null;
  }

  syncEscapeShortcut();

  if (
    isBusy ||
    !rect ||
    ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) ||
    rect.w < 10 ||
    rect.h < 10
  ) {
    return;
  }

  isBusy = true;
  const t0 = Date.now();

  try {
    showHud({ mode: "loading", cursor_pill: "•••" });

    const disp =
      screen
        .getAllDisplays()
        .find((display) => String(display.id) === String(rect.displayId)) ||
      screen.getPrimaryDisplay();

    const { image, sf } = await captureDisplayNative(disp);
    const sz = image.getSize();
    const pad = Math.round(36 * sf);

    const x = Math.max(0, Math.round(rect.x * sf - pad));
    const y = Math.max(0, Math.round(rect.y * sf - pad));
    const w = Math.min(sz.width - x, Math.round(rect.w * sf + pad * 2));
    const h = Math.min(sz.height - y, Math.round(rect.h * sf + pad * 2));

    if (w < 1 || h < 1) {
      throw new Error("Invalid snip dimensions");
    }

    const b64 = image
      .crop({ x, y, width: w, height: h })
      .toJPEG(86)
      .toString("base64");

    const res = await runAnalysisPipeline({
      imageBase64: b64,
      actionMode: "solve",
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + "s";
    handleResult(res, elapsed, "[Snipped Region]");
  } catch (_) {
    showHud({ mode: "error", cursor_pill: "Retry Alt+Q" }, 2400);
  } finally {
    isBusy = false;
  }
});

ipcMain.on("snip-cancel", () => {
  if (snipWin && !snipWin.isDestroyed()) {
    snipWin.close();
    snipWin = null;
  }
  syncEscapeShortcut();
});

async function processSpotlightQuery(_event, query) {
  if (spotlightWin && !spotlightWin.isDestroyed()) {
    spotlightWin.hide();
    syncEscapeShortcut();
  }

  if (typeof query !== "string" || !query.trim() || isBusy) return;

  query = query.trim();
  isBusy = true;
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

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + "s";
    handleResult(res, elapsed, query);
  } catch (_) {
    showHud({ mode: "error", cursor_pill: "Retry Alt+G" }, 2400);
  } finally {
    isBusy = false;
  }
}

ipcMain.on("hud-spotlight-query", processSpotlightQuery);
ipcMain.on("hud-followup", processSpotlightQuery);

// Instant live validation when user saves personal API key in Alt+K
ipcMain.on("hud-save-key", async (_event, key) => {
  if (typeof key !== "string") return;

  if (spotlightWin && !spotlightWin.isDestroyed()) {
    spotlightWin.hide();
    syncEscapeShortcut();
  }

  lastGoodByok = null;
  BYOK_COOLDOWN.clear();
  LOCAL_CACHE.clear();

  const cleanKey = sanitizeApiKeys(key).join(", ");
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

function createTray() {
  const icon = nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip("Cursor Companion V3.1");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Cursor Companion V3.1", enabled: false },
      { type: "separator" },
      { label: "Cursor Scan (Alt + A)", click: () => handleInstantScan() },
      { label: "Region Snip (Alt + Q)", click: () => handleRegionSnip() },
      { label: "Solve Selection (Alt + C)", click: () => handleTextAction("solve") },
      { label: "Rewrite Selection (Alt + W)", click: () => handleTextAction("rewrite") },
      { label: "Explain Selection (Alt + E)", click: () => handleTextAction("explain") },
      { type: "separator" },
      { label: "Spotlight Bar (Alt + G)", click: () => openSpotlight("ask") },
      { label: "Study Sidecar (Alt + D)", click: () => toggleSidecar() },
      { label: "Personal Key (Alt + K)", click: () => openSpotlight("key") },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ])
  );
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
      settings = loadSettings();
      saveSettings({});

      createHudWindow();
      createTray();
      warmBackend();

      keepAliveTimer = setInterval(warmBackend, 240000);

      registerShortcut("Alt+A", handleInstantScan);
      registerShortcut("Alt+Q", handleRegionSnip);
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
  clearInterval(keepAliveTimer);
  stopCursorFollow();
  globalShortcut.unregisterAll();
});
