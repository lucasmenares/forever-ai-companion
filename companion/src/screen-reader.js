import { startLinuxScreenReader } from './screen-reader-linux.js';
// Reads the addon's strip straight from the screen while the game runs.
//
// A small helper (PowerShell + C#, both built into Windows) watches a tiny
// 40x9 px area at the top-left of the WoW window ~50 times per second. When
// the strip's ruler and calibration cells appear there, it grabs the top band
// of the window and prints it as one line:
//   FRAME <seq> <attempt> <width> <height> <base64 RGB>
// `seq` counts strip appearances; each appearance is grabbed up to 3 times.
//
// macOS: the app's native part does the same with ScreenCaptureKit
// (macos/App.swift, --capture), which also reads the game window when other
// windows cover it. It needs the Screen Recording permission: without it the
// helper exits ("NOPERM") instead of asking, and is tried again now and then
// (the player is asked when they choose the on-screen line, see mac-voice.js).
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { nativeHelper } from './app/system.js';

export const CAPTURE_HEIGHT = 160; // px from the top of the window

const CSHARP = String.raw`
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;

public static class FaicReader {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, int rop);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  struct RECT { public int L, T, R, B; }
  struct POINT { public int X, Y; }

  static IntPtr FindWow() {
    foreach (Process p in Process.GetProcesses()) {
      try {
        string n = p.ProcessName;
        if (n.StartsWith("Wow", StringComparison.OrdinalIgnoreCase) && n.IndexOf("Voice", StringComparison.OrdinalIgnoreCase) < 0
            && p.MainWindowHandle != IntPtr.Zero) return p.MainWindowHandle;
      } catch { }
    }
    return IntPtr.Zero;
  }

  static int[] Client(IntPtr h) {
    RECT r; GetClientRect(h, out r);
    POINT p = new POINT(); ClientToScreen(h, ref p);
    return new int[] { p.X, p.Y, r.R - r.L, r.B - r.T };
  }

  public static byte[] Grab(int x, int y, int w, int h) {
    using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
      using (Graphics g = Graphics.FromImage(bmp)) {
        IntPtr dst = g.GetHdc(); IntPtr src = GetDC(IntPtr.Zero);
        BitBlt(dst, 0, 0, w, h, src, x, y, 0x00CC0020);
        ReleaseDC(IntPtr.Zero, src); g.ReleaseHdc(dst);
      }
      BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
      int stride = data.Stride;
      byte[] raw = new byte[stride * h];
      Marshal.Copy(data.Scan0, raw, 0, raw.Length);
      bmp.UnlockBits(data);
      byte[] rgb = new byte[w * h * 3];
      for (int r = 0; r < h; r++)
        for (int c = 0; c < w; c++) {
          int s = r * stride + c * 3, d = (r * w + c) * 3;
          rgb[d] = raw[s + 2]; rgb[d + 1] = raw[s + 1]; rgb[d + 2] = raw[s];
        }
      return rgb;
    }
  }

  static int Lum(byte[] p, int w, int x, int y) { int i = (y * w + x) * 3; return (p[i] + p[i + 1] + p[i + 2]) / 3; }
  static bool Gray(byte[] p, int w, int x, int y) {
    int i = (y * w + x) * 3;
    return Math.Abs(p[i] - p[i + 1]) < 12 && Math.Abs(p[i + 1] - p[i + 2]) < 12;
  }

  // Ruler (gray/black alternating 3 px cells on row 0) + 4 increasing grays on row 1.
  public static bool Marker(byte[] p, int w) {
    int white = Lum(p, w, 1, 1);
    if (white < 60 || !Gray(p, w, 1, 1)) return false;
    for (int i = 0; i < 8; i++) {
      int x = i * 3 + 1, v = Lum(p, w, x, 1);
      if (i % 2 == 0) { if (Math.Abs(v - white) > white / 4 || !Gray(p, w, x, 1)) return false; }
      else if (v > white / 4) return false;
    }
    int prev = -1;
    for (int k = 1; k <= 4; k++) {
      int x = k * 3 + 1;
      if (!Gray(p, w, x, 4)) return false;
      int v = Lum(p, w, x, 4);
      if (k > 1 && v < prev + white / 6) return false;
      prev = v;
    }
    return true;
  }

  // wholeScreen: read the top of the primary screen instead of the WoW window (tests).
  public static void Run(int captureHeight, bool wholeScreen) {
    SetProcessDPIAware();
    IntPtr hwnd = IntPtr.Zero;
    DateTime nextFind = DateTime.MinValue;
    int seq = 0, tries = 0;
    bool visible = false;
    Console.Out.WriteLine("READY");
    Console.Out.Flush();
    while (true) {
      try {
        int[] c;
        if (wholeScreen) {
          c = new int[] { 0, 0, GetSystemMetrics(0), GetSystemMetrics(1) };
        } else {
          if (DateTime.Now >= nextFind) { hwnd = FindWow(); nextFind = DateTime.Now.AddSeconds(2); }
          if (hwnd == IntPtr.Zero || IsIconic(hwnd)) { Thread.Sleep(400); continue; }
          c = Client(hwnd);
        }
        if (c[2] < 200 || c[3] < 100) { Thread.Sleep(200); continue; }
        byte[] m = Grab(c[0], c[1], 40, 9);
        if (Marker(m, 40)) {
          if (!visible) { visible = true; seq++; tries = 0; }
          if (tries < 3) {
            tries++;
            int h = Math.Min(captureHeight, c[3]);
            byte[] img = Grab(c[0], c[1], c[2], h);
            Console.Out.WriteLine("FRAME " + seq + " " + tries + " " + c[2] + " " + h + " " + Convert.ToBase64String(img));
            Console.Out.Flush();
            Thread.Sleep(40);
            continue;
          }
        } else {
          visible = false;
        }
      } catch (Exception e) {
        Console.Error.WriteLine(e.Message);
        Thread.Sleep(500);
      }
      Thread.Sleep(20);
    }
  }
}
`;

export function helperScript(captureHeight = CAPTURE_HEIGHT, wholeScreen = false) {
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
${CSHARP}
'@
[FaicReader]::Run(${captureHeight}, $${wholeScreen ? 'true' : 'false'})
`;
}

// Starts the helper and restarts it if it dies. onFrame({ seq, attempt, width, height, channels, data }).
// wholeScreen: watch the top of the primary screen instead of the WoW window (tests).
export function startScreenReader({ onFrame, log = () => {}, captureHeight = CAPTURE_HEIGHT, wholeScreen = false, helper = nativeHelper }) {
  if (process.platform === 'linux') return startLinuxScreenReader({ onFrame, log, captureHeight });
  const mac = process.platform === 'darwin';
  if (process.platform !== 'win32' && !mac) return { stop() {} };
  const macExe = mac ? helper() : null;
  if (mac && !macExe) return { stop() {} };
  let child = null;
  let stopped = false;
  let restartTimer = null;
  let noPermission = false;
  const encoded = mac ? null : Buffer.from(helperScript(captureHeight, wholeScreen), 'utf16le').toString('base64');

  const launch = () => {
    child = mac
      // stdin stays open: the helper stops when this program does.
      ? spawn(macExe, ['--capture', String(captureHeight), '--no-prompt', ...(wholeScreen ? ['--whole-screen'] : [])], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      : spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    child.stdin?.on('error', () => {});
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line === 'READY') { noPermission = false; log('Screen reader active.'); return; }
      if (line === 'NOPERM') {
        if (!noPermission) log('Screen reader: no Screen Recording permission (only needed for the on-screen line).');
        noPermission = true;
        return;
      }
      if (!line.startsWith('FRAME ')) return;
      const [, seq, attempt, w, h, b64] = line.split(' ');
      try {
        onFrame({
          seq: Number(seq), attempt: Number(attempt),
          width: Number(w), height: Number(h), channels: 3, data: Buffer.from(b64, 'base64'),
        });
      } catch (e) {
        log(`Error processing the strip: ${e.message}`);
      }
    });
    child.stderr.on('data', (d) => {
      const text = String(d).replace(/#< CLIXML[\s\S]*/, '').trim(); // PowerShell progress noise
      if (text) log(`Screen reader: ${text}`);
    });
    child.on('exit', (code) => {
      child = null;
      if (stopped) return;
      // No permission yet (macOS): checked again every half a minute, quietly.
      if (mac && code === 3) { restartTimer = setTimeout(launch, 30000); return; }
      log(`The screen reader exited (code ${code}); restarting in 3 s.`);
      restartTimer = setTimeout(launch, 3000);
    });
    child.on('error', (e) => log(`Could not start the screen reader: ${e.message}`));
  };
  launch();

  return {
    stop() {
      stopped = true;
      clearTimeout(restartTimer);
      if (child) child.kill();
    },
  };
}
