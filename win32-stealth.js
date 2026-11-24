const { spawn } = require("child_process");

const PS_WORKER = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class CCWin32 {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
  private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

  [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
  private static extern IntPtr GetWindowLong32(IntPtr hWnd, int nIndex);

  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
  private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

  [DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)]
  private static extern IntPtr SetWindowLong32(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

  private static long GetExStyle(IntPtr hWnd) {
    return (IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, -20) : GetWindowLong32(hWnd, -20)).ToInt64();
  }

  private static void SetExStyle(IntPtr hWnd, long style) {
    IntPtr v = new IntPtr(style);
    if (IntPtr.Size == 8) SetWindowLongPtr64(hWnd, -20, v);
    else SetWindowLong32(hWnd, -20, v);
  }

  // Applies WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT so the overlay
  // can NEVER steal focus, turn highlights grey, or pop up the taskbar.
  public static void MakeNoActivateOverlay(long hwndVal, bool clickThrough) {
    if (hwndVal <= 0) return;
    IntPtr h = new IntPtr(hwndVal);
    long ex = GetExStyle(h);
    ex |= 0x08000000L; // WS_EX_NOACTIVATE
    ex |= 0x00000080L; // WS_EX_TOOLWINDOW
    ex &= ~0x00040000L; // Remove WS_EX_APPWINDOW
    if (clickThrough) ex |= 0x00000020L; // WS_EX_TRANSPARENT
    SetExStyle(h, ex);
    // SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_FRAMECHANGED
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0033);
  }

  // Lifts topmost strictly WITHOUT activating or surfacing the taskbar.
  public static void LiftTopmostNoActivate(long hwndVal) {
    if (hwndVal <= 0) return;
    // SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
    SetWindowPos(new IntPtr(hwndVal), new IntPtr(-1), 0, 0, 0, 0, 0x0013);
  }

  // Sends Ctrl+C without triggering Windows' solo-Alt menu bar activation.
  public static void CopySelectionNoFocusLoss() {
    const uint KEYUP = 0x0002;
    try {
      // Press Ctrl FIRST so releasing Alt is treated as a chord, NOT solo Alt menu activation
      keybd_event(0x11, 0, 0, UIntPtr.Zero); // Ctrl DOWN
      keybd_event(0x12, 0, KEYUP, UIntPtr.Zero); // Alt UP
      keybd_event(0xA4, 0, KEYUP, UIntPtr.Zero); // LAlt UP
      keybd_event(0xA5, 0, KEYUP, UIntPtr.Zero); // RAlt UP
      keybd_event(0x10, 0, KEYUP, UIntPtr.Zero); // Shift UP
      Thread.Sleep(20);
      keybd_event(0x43, 0, 0, UIntPtr.Zero); // C DOWN
      Thread.Sleep(15);
      keybd_event(0x43, 0, KEYUP, UIntPtr.Zero); // C UP
      Thread.Sleep(10);
    } finally {
      keybd_event(0x11, 0, KEYUP, UIntPtr.Zero); // Ctrl UP
      keybd_event(0xA2, 0, KEYUP, UIntPtr.Zero); // LCtrl UP
      keybd_event(0xA3, 0, KEYUP, UIntPtr.Zero); // RCtrl UP
    }
  }
}
"@

[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Trim().Split(" ")
  $cmd = $parts[0]
  try {
    if ($cmd -eq "NOACTIVATE" -and $parts.Length -ge 2) {
      $ct = ($parts.Length -ge 3 -and $parts[2] -eq "1")
      [CCWin32]::MakeNoActivateOverlay([long]$parts[1], $ct)
    } elseif ($cmd -eq "TOPMOST" -and $parts.Length -ge 2) {
      [CCWin32]::LiftTopmostNoActivate([long]$parts[1])
    } elseif ($cmd -eq "COPY") {
      [CCWin32]::CopySelectionNoFocusLoss()
    } elseif ($cmd -eq "EXIT") {
      break
    }
    [Console]::Out.WriteLine("OK")
  } catch {
    [Console]::Out.WriteLine("ERR")
  }
  [Console]::Out.Flush()
}
`;

let worker = null;
let ready = false;
let queue = [];
let buf = "";

function startWin32Worker() {
  if (process.platform !== "win32" || worker) return;
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", PS_WORKER],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }
  );
  worker = child;
  ready = false;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line === "READY") {
        ready = true;
        flushQueue();
      } else if (queue.length > 0 && queue[0].sent) {
        const item = queue.shift();
        clearTimeout(item.timer);
        item.resolve(line === "OK");
        flushQueue();
      }
    }
  });

  child.on("exit", () => {
    worker = null;
    ready = false;
    while (queue.length) {
      const item = queue.shift();
      clearTimeout(item.timer);
      item.resolve(false);
    }
  });
}

function flushQueue() {
  if (!worker || !ready || !queue.length || queue[0].sent) return;
  const item = queue[0];
  item.sent = true;
  try {
    worker.stdin.write(item.cmd + "\n");
  } catch (_) {
    queue.shift();
    clearTimeout(item.timer);
    item.resolve(false);
  }
}

function sendCmd(cmd, timeoutMs = 1500) {
  if (process.platform !== "win32") return Promise.resolve(false);
  if (!worker) startWin32Worker();
  return new Promise((resolve) => {
    const item = { cmd, sent: false, resolve, timer: null };
    item.timer = setTimeout(() => {
      const idx = queue.indexOf(item);
      if (idx !== -1) queue.splice(idx, 1);
      resolve(false);
      flushQueue();
    }, timeoutMs);
    queue.push(item);
    flushQueue();
  });
}

function getHwnd(win) {
  if (!win || win.isDestroyed() || process.platform !== "win32") return 0;
  try {
    const b = win.getNativeWindowHandle();
    return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
  } catch (_) {
    return 0;
  }
}

async function applyNoActivateOverlay(win, clickThrough = true) {
  const h = getHwnd(win);
  if (h > 0) await sendCmd(`NOACTIVATE ${h} ${clickThrough ? 1 : 0}`);
}

async function liftTopmostNoActivate(win) {
  const h = getHwnd(win);
  if (h > 0) await sendCmd(`TOPMOST ${h}`);
}

async function triggerCopyNoFocusLoss() {
  return await sendCmd("COPY", 1200);
}

function stopWin32Worker() {
  if (!worker) return;
  try {
    worker.stdin.write("EXIT\n");
    worker.kill();
  } catch (_) {}
  worker = null;
  ready = false;
}

module.exports = {
  startWin32Worker,
  applyNoActivateOverlay,
  liftTopmostNoActivate,
  triggerCopyNoFocusLoss,
  stopWin32Worker,
};
