// wowhelper: the bridge's Windows helper. A long-running process the bridge talks to
// over stdin/stdout, one request per line, so finding the game and reading its pixels
// costs a pipe round trip instead of a process launch every 150 ms.
//
// Built by the bridge with the C# compiler that ships with Windows (.NET Framework
// 4.x csc.exe); no SDK needed.
//
// Requests and replies:
//   procs                     -> json [{"pid":1,"start":<FILETIME>,"path":"C:\\...\\Wow.exe"}]
//                                (processes whose name starts with "Wow")
//   win <pid>                 -> json {"found":true,"visible":..,"x":..,"y":..,"width":..,"height":..,
//                                       "foreground":..,"covered":..,"dpi":..}
//   grab <pid> <w> <h>        -> img <w> <h> <n>\n<n bytes BGRA, top-down>   (top-left of the client area)
//                                | none | hidden
//   shot <pid>                -> img ... (the whole client area) | none | hidden
//   ping                      -> pong
//   anything that fails       -> err <message>
//
// Pixels come from the screen (BitBlt, cheap) when the corner is uncovered, else from
// PrintWindow with PW_RENDERFULLCONTENT, which also renders DirectX content of a
// window that is behind others.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class WowHelper
{
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFOHEADER
    {
        public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount;
        public uint biCompression; public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
        public uint biClrUsed; public uint biClrImportant;
    }

    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER bi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);

    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint GA_ROOT = 2;
    const int DWMWA_CLOAKED = 14;
    const uint SRCCOPY = 0x00CC0020;
    const uint CAPTUREBLT = 0x40000000;
    const uint PW_CLIENTONLY = 1;
    const uint PW_RENDERFULLCONTENT = 2;

    static Stream stdout;

    static int Main()
    {
        // Physical pixels everywhere: the addon draws its strip in physical pixels.
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }

        stdout = Console.OpenStandardOutput();
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            try { Handle(line.Split(' ')); }
            catch (Exception e) { Text("err " + e.Message.Replace('\n', ' ').Replace('\r', ' ')); }
        }
        return 0;
    }

    static void Handle(string[] a)
    {
        switch (a[0])
        {
            case "ping": Text("pong"); break;
            case "procs": Text("json " + Processes()); break;
            case "win": Text("json " + WindowJson(uint.Parse(a[1]))); break;
            case "grab": Grab(uint.Parse(a[1]), int.Parse(a[2]), int.Parse(a[3]), false); break;
            case "shot": Grab(uint.Parse(a[1]), 0, 0, true); break;
            default: Text("err unknown request " + a[0]); break;
        }
    }

    static void Text(string s)
    {
        var b = Encoding.UTF8.GetBytes(s + "\n");
        stdout.Write(b, 0, b.Length);
        stdout.Flush();
    }

    static string Esc(string s)
    {
        var sb = new StringBuilder();
        foreach (var c in s)
        {
            if (c == '\\' || c == '"') sb.Append('\\').Append(c);
            else if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
            else sb.Append(c);
        }
        return sb.ToString();
    }

    static string Processes()
    {
        var parts = new List<string>();
        foreach (var p in Process.GetProcesses())
        {
            try
            {
                if (!p.ProcessName.StartsWith("Wow", StringComparison.OrdinalIgnoreCase)) continue;
                IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)p.Id);
                if (h == IntPtr.Zero) continue;
                try
                {
                    var sb = new StringBuilder(1024);
                    uint size = (uint)sb.Capacity;
                    string path = QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : "";
                    long created, exit, kernel, user;
                    long start = GetProcessTimes(h, out created, out exit, out kernel, out user) ? created : 0;
                    parts.Add("{\"pid\":" + p.Id + ",\"start\":" + start + ",\"path\":\"" + Esc(path) + "\"}");
                }
                finally { CloseHandle(h); }
            }
            catch { }
            finally { p.Dispose(); }
        }
        return "[" + string.Join(",", parts) + "]";
    }

    // The process's largest visible top-level window: the game's main window.
    static IntPtr FindWindow(uint pid)
    {
        IntPtr best = IntPtr.Zero;
        long bestArea = 0;
        EnumWindows((hwnd, l) =>
        {
            uint wpid;
            GetWindowThreadProcessId(hwnd, out wpid);
            if (wpid != pid || !IsWindowVisible(hwnd)) return true;
            RECT r;
            GetClientRect(hwnd, out r);
            long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
            if (IsIconic(hwnd) && best == IntPtr.Zero) { best = hwnd; return true; }
            if (area > bestArea) { best = hwnd; bestArea = area; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    struct WinInfo { public bool found, visible, foreground, covered; public int x, y, width, height; public uint dpi; public IntPtr hwnd; }

    static WinInfo Window(uint pid)
    {
        var w = new WinInfo();
        w.hwnd = FindWindow(pid);
        if (w.hwnd == IntPtr.Zero) return w;
        w.found = true;
        int cloaked = 0;
        DwmGetWindowAttribute(w.hwnd, DWMWA_CLOAKED, out cloaked, 4);
        w.visible = IsWindowVisible(w.hwnd) && !IsIconic(w.hwnd) && cloaked == 0;
        RECT r;
        GetClientRect(w.hwnd, out r);
        var p = new POINT();
        ClientToScreen(w.hwnd, ref p);
        w.x = p.X; w.y = p.Y; w.width = r.Right - r.Left; w.height = r.Bottom - r.Top;
        w.foreground = GetForegroundWindow() == w.hwnd;
        // Covered: another window owns the pixel just inside the client's top-left corner.
        var probe = new POINT { X = p.X + 2, Y = p.Y + 2 };
        IntPtr at = WindowFromPoint(probe);
        w.covered = at == IntPtr.Zero || GetAncestor(at, GA_ROOT) != w.hwnd;
        try { w.dpi = GetDpiForWindow(w.hwnd); } catch (EntryPointNotFoundException) { w.dpi = 96; }
        return w;
    }

    static string WindowJson(uint pid)
    {
        var w = Window(pid);
        if (!w.found) return "{\"found\":false}";
        return "{\"found\":true,\"visible\":" + B(w.visible) + ",\"x\":" + w.x + ",\"y\":" + w.y +
               ",\"width\":" + w.width + ",\"height\":" + w.height + ",\"foreground\":" + B(w.foreground) +
               ",\"covered\":" + B(w.covered) + ",\"dpi\":" + w.dpi + "}";
    }

    static string B(bool b) { return b ? "true" : "false"; }

    static void Grab(uint pid, int w, int h, bool whole)
    {
        var win = Window(pid);
        if (!win.found) { Text("none"); return; }
        if (!win.visible) { Text("hidden"); return; }
        if (whole) { w = win.width; h = win.height; }
        w = Math.Max(1, Math.Min(w, win.width));
        h = Math.Max(1, Math.Min(h, win.height));

        var bi = new BITMAPINFOHEADER();
        bi.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
        bool viaPrint = whole || win.covered;
        // PrintWindow renders the whole client area; BitBlt copies just the corner.
        bi.biWidth = viaPrint ? win.width : w;
        bi.biHeight = -(viaPrint ? win.height : h); // top-down
        bi.biPlanes = 1;
        bi.biBitCount = 32;

        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr mem = CreateCompatibleDC(screen);
        IntPtr bits;
        IntPtr dib = CreateDIBSection(screen, ref bi, 0, out bits, IntPtr.Zero, 0);
        if (dib == IntPtr.Zero)
        {
            DeleteDC(mem);
            ReleaseDC(IntPtr.Zero, screen);
            throw new Exception("CreateDIBSection failed");
        }
        IntPtr old = SelectObject(mem, dib);
        try
        {
            bool ok = viaPrint
                ? PrintWindow(win.hwnd, mem, PW_CLIENTONLY | PW_RENDERFULLCONTENT)
                : BitBlt(mem, 0, 0, w, h, screen, win.x, win.y, SRCCOPY | CAPTUREBLT);
            if (!ok) throw new Exception(viaPrint ? "PrintWindow failed" : "BitBlt failed");
            int stride = bi.biWidth * 4;
            var outBuf = new byte[w * h * 4];
            for (int y = 0; y < h; y++) Marshal.Copy(new IntPtr(bits.ToInt64() + (long)y * stride), outBuf, y * w * 4, w * 4);
            Text("img " + w + " " + h + " " + outBuf.Length);
            stdout.Write(outBuf, 0, outBuf.Length);
            stdout.Flush();
        }
        finally
        {
            SelectObject(mem, old);
            DeleteObject(dib);
            DeleteDC(mem);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }
}
