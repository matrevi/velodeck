# VeloDeck Windows Native Input Helper (PowerShell + Inline C# SendInput)
# Modes:
#   --check-permissions  Prints {"accessibility":true,"screenCapture":true} and exits 0
#   (default)            Persistent NDJSON daemon reading commands from stdin

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CliArgs
)

$ErrorActionPreference = "SilentlyContinue"

if ($CliArgs -contains "--check-permissions" -or $CliArgs -contains "--request-accessibility") {
    [Console]::Out.WriteLine('{"accessibility":true,"screenCapture":true}')
    [Console]::Out.Flush()
    exit 0
}

$csharpSource = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class VeloDeckWinInput {
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;

    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x01000;

    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    private const ushort VK_SHIFT = 0x10;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_MENU = 0x12;
    private const ushort VK_LWIN = 0x5B;
    private const ushort VK_RETURN = 0x0D;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CURSORINFO {
        public int cbSize;
        public int flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    private const int CURSOR_SHOWING = 0x00000001;
    private const int IDC_ARROW = 32512;
    private const int IDC_IBEAM = 32513;
    private const int IDC_WAIT = 32514;
    private const int IDC_CROSS = 32515;
    private const int IDC_SIZENWSE = 32642;
    private const int IDC_SIZENESW = 32643;
    private const int IDC_SIZEWE = 32644;
    private const int IDC_SIZENS = 32645;
    private const int IDC_SIZEALL = 32646;
    private const int IDC_NO = 32648;
    private const int IDC_HAND = 32649;
    private const int IDC_APPSTARTING = 32650;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool LockWorkStation();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool BlockInput(bool fBlockIt);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetCursorInfo(ref CURSORINFO pci);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr LoadCursor(IntPtr hInstance, IntPtr lpCursorName);

    private static bool leftDown = false;
    private static bool rightDown = false;
    private static bool middleDown = false;
    private static bool inputBlocked = false;
    private static int lastX = 0;
    private static int lastY = 0;

    private static IntPtr hArrow = IntPtr.Zero;
    private static IntPtr hIBeam = IntPtr.Zero;
    private static IntPtr hWait = IntPtr.Zero;
    private static IntPtr hAppStarting = IntPtr.Zero;
    private static IntPtr hCross = IntPtr.Zero;
    private static IntPtr hSizeNWSE = IntPtr.Zero;
    private static IntPtr hSizeNESW = IntPtr.Zero;
    private static IntPtr hSizeWE = IntPtr.Zero;
    private static IntPtr hSizeNS = IntPtr.Zero;
    private static IntPtr hSizeAll = IntPtr.Zero;
    private static IntPtr hNo = IntPtr.Zero;
    private static IntPtr hHand = IntPtr.Zero;

    public static void InitDpi() {
        try {
            // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = (IntPtr)(-4)
            if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) {
                SetProcessDPIAware();
            }
        } catch {
            try { SetProcessDPIAware(); } catch { }
        }
        try {
            hArrow = LoadCursor(IntPtr.Zero, new IntPtr(IDC_ARROW));
            hIBeam = LoadCursor(IntPtr.Zero, new IntPtr(IDC_IBEAM));
            hWait = LoadCursor(IntPtr.Zero, new IntPtr(IDC_WAIT));
            hAppStarting = LoadCursor(IntPtr.Zero, new IntPtr(IDC_APPSTARTING));
            hCross = LoadCursor(IntPtr.Zero, new IntPtr(IDC_CROSS));
            hSizeNWSE = LoadCursor(IntPtr.Zero, new IntPtr(IDC_SIZENWSE));
            hSizeNESW = LoadCursor(IntPtr.Zero, new IntPtr(IDC_SIZENESW));
            hSizeWE = LoadCursor(IntPtr.Zero, new IntPtr(IDC_SIZEWE));
            hSizeNS = LoadCursor(IntPtr.Zero, new IntPtr(IDC_SIZENS));
            hSizeAll = LoadCursor(IntPtr.Zero, new IntPtr(IDC_SIZEALL));
            hNo = LoadCursor(IntPtr.Zero, new IntPtr(IDC_NO));
            hHand = LoadCursor(IntPtr.Zero, new IntPtr(IDC_HAND));
        } catch { }
    }

    public static void MouseMoveRelative(int dx, int dy) {
        int clampedDx = Math.Max(-2000, Math.Min(2000, dx));
        int clampedDy = Math.Max(-2000, Math.Min(2000, dy));
        if (clampedDx == 0 && clampedDy == 0) return;
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].U.mi.dx = clampedDx;
        inputs[0].U.mi.dy = clampedDy;
        inputs[0].U.mi.mouseData = 0;
        inputs[0].U.mi.dwFlags = MOUSEEVENTF_MOVE;
        inputs[0].U.mi.time = 0;
        inputs[0].U.mi.dwExtraInfo = IntPtr.Zero;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static string QueryCursorShape() {
        try {
            CURSORINFO ci = new CURSORINFO();
            ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
            if (!GetCursorInfo(ref ci)) return "default";
            if ((ci.flags & CURSOR_SHOWING) == 0) return "none";
            IntPtr h = ci.hCursor;
            if (h == IntPtr.Zero || h == hArrow) return "default";
            if (h == hIBeam) return "text";
            if (h == hHand) return "pointer";
            if (h == hCross) return "crosshair";
            if (h == hSizeWE) return "ew-resize";
            if (h == hSizeNS) return "ns-resize";
            if (h == hSizeNWSE) return "nwse-resize";
            if (h == hSizeNESW) return "nesw-resize";
            if (h == hSizeAll) return "move";
            if (h == hNo) return "not-allowed";
            if (h == hWait || h == hAppStarting) return "wait";
        } catch { }
        return "default";
    }

    public static void SetBlockInput(bool enabled) {
        try {
            BlockInput(enabled);
            inputBlocked = enabled;
        } catch { }
    }

    private static void SendMouseFlag(uint flag, uint mouseData = 0) {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].U.mi.dx = 0;
        inputs[0].U.mi.dy = 0;
        inputs[0].U.mi.mouseData = mouseData;
        inputs[0].U.mi.dwFlags = flag;
        inputs[0].U.mi.time = 0;
        inputs[0].U.mi.dwExtraInfo = IntPtr.Zero;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void MouseMove(int x, int y) {
        lastX = x;
        lastY = y;
        SetCursorPos(x, y);
    }

    public static void MouseDown(int x, int y, string button) {
        lastX = x;
        lastY = y;
        SetCursorPos(x, y);
        string b = (button ?? "left").ToLowerInvariant();
        if (b == "right") {
            rightDown = true;
            SendMouseFlag(MOUSEEVENTF_RIGHTDOWN);
        } else if (b == "middle") {
            middleDown = true;
            SendMouseFlag(MOUSEEVENTF_MIDDLEDOWN);
        } else {
            leftDown = true;
            SendMouseFlag(MOUSEEVENTF_LEFTDOWN);
        }
    }

    public static void MouseUp(int x, int y, string button) {
        lastX = x;
        lastY = y;
        SetCursorPos(x, y);
        string b = (button ?? "left").ToLowerInvariant();
        if (b == "right") {
            rightDown = false;
            SendMouseFlag(MOUSEEVENTF_RIGHTUP);
        } else if (b == "middle") {
            middleDown = false;
            SendMouseFlag(MOUSEEVENTF_MIDDLEUP);
        } else {
            leftDown = false;
            SendMouseFlag(MOUSEEVENTF_LEFTUP);
        }
    }

    public static void Tap(int x, int y, int clickCount) {
        int count = Math.Max(1, Math.Min(3, clickCount));
        lastX = x;
        lastY = y;
        SetCursorPos(x, y);
        for (int i = 0; i < count; i++) {
            SendMouseFlag(MOUSEEVENTF_LEFTDOWN);
            SendMouseFlag(MOUSEEVENTF_LEFTUP);
        }
    }

    public static void LongPress(int x, int y) {
        lastX = x;
        lastY = y;
        SetCursorPos(x, y);
        SendMouseFlag(MOUSEEVENTF_RIGHTDOWN);
        SendMouseFlag(MOUSEEVENTF_RIGHTUP);
    }

    public static void MouseWheel(int x, int y, bool hasCoords, int deltaX, int deltaY) {
        if (hasCoords) {
            lastX = x;
            lastY = y;
            SetCursorPos(x, y);
        }
        int clampedDy = Math.Max(-2000, Math.Min(2000, deltaY));
        int clampedDx = Math.Max(-2000, Math.Min(2000, deltaX));
        if (clampedDy != 0) {
            SendMouseFlag(MOUSEEVENTF_WHEEL, unchecked((uint)(-clampedDy)));
        }
        if (clampedDx != 0) {
            SendMouseFlag(MOUSEEVENTF_HWHEEL, unchecked((uint)(clampedDx)));
        }
    }

    private static void SendVk(ushort vk, bool keyUp, bool extended) {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki.wVk = vk;
        inputs[0].U.ki.wScan = 0;
        inputs[0].U.ki.dwFlags = (keyUp ? KEYEVENTF_KEYUP : 0u) | (extended ? KEYEVENTF_EXTENDEDKEY : 0u);
        inputs[0].U.ki.time = 0;
        inputs[0].U.ki.dwExtraInfo = IntPtr.Zero;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    private static bool IsExtendedVk(ushort vk) {
        return vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 ||
               vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28 ||
               vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C ||
               vk == 0xA3 || vk == 0xA5;
    }

    private static ushort ResolveVk(string code, string key) {
        if (!string.IsNullOrEmpty(code)) {
            if (code.Length == 4 && code.StartsWith("Key")) {
                char ch = char.ToUpperInvariant(code[3]);
                if (ch >= 'A' && ch <= 'Z') return (ushort)ch;
            }
            if (code.Length == 6 && code.StartsWith("Digit")) {
                char ch = code[5];
                if (ch >= '0' && ch <= '9') return (ushort)ch;
            }
            switch (code) {
                case "Enter": case "NumpadEnter": return 0x0D;
                case "Backspace": return 0x08;
                case "Tab": return 0x09;
                case "Escape": return 0x1B;
                case "Space": return 0x20;
                case "Delete": return 0x2E;
                case "Insert": return 0x2D;
                case "Home": return 0x24;
                case "End": return 0x23;
                case "PageUp": return 0x21;
                case "PageDown": return 0x22;
                case "ArrowLeft": return 0x25;
                case "ArrowUp": return 0x26;
                case "ArrowRight": return 0x27;
                case "ArrowDown": return 0x28;
                case "Minus": return 0xBD;
                case "Equal": return 0xBB;
                case "BracketLeft": return 0xDB;
                case "BracketRight": return 0xDD;
                case "Backslash": return 0xDC;
                case "Semicolon": return 0xBA;
                case "Quote": return 0xDE;
                case "Backquote": return 0xC0;
                case "Comma": return 0xBC;
                case "Period": return 0xBE;
                case "Slash": return 0xBF;
                case "CapsLock": return 0x14;
                case "ShiftLeft": return 0xA0;
                case "ShiftRight": return 0xA1;
                case "ControlLeft": return 0xA2;
                case "ControlRight": return 0xA3;
                case "AltLeft": return 0xA4;
                case "AltRight": return 0xA5;
                case "MetaLeft": return 0x5B;
                case "MetaRight": return 0x5C;
                case "F1": return 0x70;
                case "F2": return 0x71;
                case "F3": return 0x72;
                case "F4": return 0x73;
                case "F5": return 0x74;
                case "F6": return 0x75;
                case "F7": return 0x76;
                case "F8": return 0x77;
                case "F9": return 0x78;
                case "F10": return 0x79;
                case "F11": return 0x7A;
                case "F12": return 0x7B;
                case "F13": return 0x7C;
                case "F14": return 0x7D;
                case "F15": return 0x7E;
                case "F16": return 0x7F;
                case "F17": return 0x80;
                case "F18": return 0x81;
                case "F19": return 0x82;
                case "F20": return 0x83;
                case "PrintScreen": return 0x2C;
                case "ScrollLock": return 0x91;
                case "Pause": return 0x13;
                case "NumLock": return 0x90;
                case "ContextMenu": return 0x5D;
                case "Numpad0": return 0x60;
                case "Numpad1": return 0x61;
                case "Numpad2": return 0x62;
                case "Numpad3": return 0x63;
                case "Numpad4": return 0x64;
                case "Numpad5": return 0x65;
                case "Numpad6": return 0x66;
                case "Numpad7": return 0x67;
                case "Numpad8": return 0x68;
                case "Numpad9": return 0x69;
                case "NumpadMultiply": return 0x6A;
                case "NumpadAdd": return 0x6B;
                case "NumpadSubtract": return 0x6D;
                case "NumpadDecimal": return 0x6E;
                case "NumpadDivide": return 0x6F;
                case "AudioVolumeMute": return 0xAD;
                case "AudioVolumeDown": return 0xAE;
                case "AudioVolumeUp": return 0xAF;
                case "MediaNextTrack": return 0xB0;
                case "MediaPreviousTrack": return 0xB1;
                case "MediaStop": return 0xB2;
                case "MediaPlayPause": return 0xB3;
            }
        }
        if (!string.IsNullOrEmpty(key)) {
            string lower = key.ToLowerInvariant();
            switch (lower) {
                case "enter": return 0x0D;
                case "backspace": return 0x08;
                case "tab": return 0x09;
                case "escape": case "esc": return 0x1B;
                case " ": case "space": return 0x20;
                case "delete": return 0x2E;
                case "home": return 0x24;
                case "end": return 0x23;
                case "pageup": return 0x21;
                case "pagedown": return 0x22;
                case "arrowleft": return 0x25;
                case "arrowup": return 0x26;
                case "arrowright": return 0x27;
                case "arrowdown": return 0x28;
                case "f1": return 0x70;
                case "f2": return 0x71;
                case "f3": return 0x72;
                case "f4": return 0x73;
                case "f5": return 0x74;
                case "f6": return 0x75;
                case "f7": return 0x76;
                case "f8": return 0x77;
                case "f9": return 0x78;
                case "f10": return 0x79;
                case "f11": return 0x7A;
                case "f12": return 0x7B;
                case "f13": return 0x7C;
                case "f14": return 0x7D;
                case "f15": return 0x7E;
                case "audiovolumemute": return 0xAD;
                case "audiovolumedown": return 0xAE;
                case "audiovolumeup": return 0xAF;
            }
            if (lower.Length == 1) {
                char c = char.ToUpperInvariant(lower[0]);
                if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return (ushort)c;
            }
        }
        return 0;
    }

    public static void KeyEvent(string phase, string code, string key, bool ctrl, bool alt, bool shift, bool meta) {
        ushort vk = ResolveVk(code, key);
        string p = (phase ?? "press").ToLowerInvariant();
        if (vk == 0) {
            if (p != "up" && !string.IsNullOrEmpty(key) && key.Length == 1 && !ctrl && !alt && !meta) {
                SendUnicodeText(key, false);
            }
            return;
        }
        bool ext = IsExtendedVk(vk);
        if (p == "down") {
            SendVk(vk, false, ext);
        } else if (p == "up") {
            SendVk(vk, true, ext);
        } else {
            var mods = new List<ushort>();
            if (ctrl && vk != VK_CONTROL && vk != 0xA2 && vk != 0xA3) mods.Add(VK_CONTROL);
            if (alt && vk != VK_MENU && vk != 0xA4 && vk != 0xA5) mods.Add(VK_MENU);
            if (shift && vk != VK_SHIFT && vk != 0xA0 && vk != 0xA1) mods.Add(VK_SHIFT);
            if (meta && vk != VK_LWIN && vk != 0x5C) mods.Add(VK_LWIN);

            foreach (ushort m in mods) SendVk(m, false, IsExtendedVk(m));
            SendVk(vk, false, ext);
            SendVk(vk, true, ext);
            for (int i = mods.Count - 1; i >= 0; i--) SendVk(mods[i], true, IsExtendedVk(mods[i]));
        }
    }

    public static void SendUnicodeText(string text, bool submit) {
        if (!string.IsNullOrEmpty(text)) {
            var list = new List<INPUT>(text.Length * 2);
            foreach (char ch in text) {
                INPUT down = new INPUT();
                down.type = INPUT_KEYBOARD;
                down.U.ki.wVk = 0;
                down.U.ki.wScan = (ushort)ch;
                down.U.ki.dwFlags = KEYEVENTF_UNICODE;
                list.Add(down);

                INPUT up = new INPUT();
                up.type = INPUT_KEYBOARD;
                up.U.ki.wVk = 0;
                up.U.ki.wScan = (ushort)ch;
                up.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
                list.Add(up);
            }
            if (list.Count > 0) {
                SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
            }
        }
        if (submit) {
            SendVk(VK_RETURN, false, false);
            SendVk(VK_RETURN, true, false);
        }
    }

    public static void Lock() {
        LockWorkStation();
    }

    public static void ReleaseAll() {
        if (inputBlocked) {
            try { BlockInput(false); } catch { }
            inputBlocked = false;
        }
        if (leftDown) { leftDown = false; SendMouseFlag(MOUSEEVENTF_LEFTUP); }
        if (rightDown) { rightDown = false; SendMouseFlag(MOUSEEVENTF_RIGHTUP); }
        if (middleDown) { middleDown = false; SendMouseFlag(MOUSEEVENTF_MIDDLEUP); }
    }
}
"@

Add-Type -TypeDefinition $csharpSource -Language CSharp
[VeloDeckWinInput]::InitDpi()

try {
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        $trimmed = $line.Trim()
        if ([string]::IsNullOrEmpty($trimmed)) { continue }

        try {
            $cmd = $trimmed | ConvertFrom-Json
        } catch {
            continue
        }

        $action = [string]$cmd.action
        switch ($action) {
            "ping" {
                [Console]::Out.WriteLine('{"ok":true,"pong":true}')
                [Console]::Out.Flush()
            }
            "query_cursor" {
                $shape = [VeloDeckWinInput]::QueryCursorShape()
                [Console]::Out.WriteLine("{`"ok`":true,`"cursor`":`"$shape`"}")
                [Console]::Out.Flush()
            }
            "block_input" {
                [VeloDeckWinInput]::SetBlockInput([bool]$cmd.enabled)
            }
            "mouse_move" {
                [VeloDeckWinInput]::MouseMove([int][Math]::Round([double]$cmd.x), [int][Math]::Round([double]$cmd.y))
            }
            "mouse_move_relative" {
                $rdx = if ($null -ne $cmd.dx) { [int][Math]::Round([double]$cmd.dx) } else { 0 }
                $rdy = if ($null -ne $cmd.dy) { [int][Math]::Round([double]$cmd.dy) } else { 0 }
                [VeloDeckWinInput]::MouseMoveRelative($rdx, $rdy)
            }
            "mouse_down" {
                $btn = if ($cmd.button) { [string]$cmd.button } else { "left" }
                [VeloDeckWinInput]::MouseDown([int][Math]::Round([double]$cmd.x), [int][Math]::Round([double]$cmd.y), $btn)
            }
            "mouse_up" {
                $btn = if ($cmd.button) { [string]$cmd.button } else { "left" }
                [VeloDeckWinInput]::MouseUp([int][Math]::Round([double]$cmd.x), [int][Math]::Round([double]$cmd.y), $btn)
            }
            "mouse_wheel" {
                $hasCoords = ($null -ne $cmd.x) -and ($null -ne $cmd.y)
                $wx = if ($hasCoords) { [int][Math]::Round([double]$cmd.x) } else { 0 }
                $wy = if ($hasCoords) { [int][Math]::Round([double]$cmd.y) } else { 0 }
                $dx = if ($null -ne $cmd.deltaX) { [int][Math]::Round([double]$cmd.deltaX) } else { 0 }
                $dy = if ($null -ne $cmd.deltaY) { [int][Math]::Round([double]$cmd.deltaY) } else { 0 }
                [VeloDeckWinInput]::MouseWheel($wx, $wy, $hasCoords, $dx, $dy)
            }
            "tap" {
                $cc = if ($null -ne $cmd.clickCount) { [int]$cmd.clickCount } else { 1 }
                [VeloDeckWinInput]::Tap([int][Math]::Round([double]$cmd.x), [int][Math]::Round([double]$cmd.y), $cc)
            }
            "long_press" {
                [VeloDeckWinInput]::LongPress([int][Math]::Round([double]$cmd.x), [int][Math]::Round([double]$cmd.y))
            }
            "key_event" {
                $phase = if ($cmd.phase) { [string]$cmd.phase } else { "press" }
                $code = if ($cmd.code) { [string]$cmd.code } else { "" }
                $key = if ($cmd.key) { [string]$cmd.key } else { "" }
                $mods = $cmd.modifiers
                $ctrl = [bool]($mods -and $mods.ctrl)
                $alt = [bool]($mods -and $mods.alt)
                $shift = [bool]($mods -and $mods.shift)
                $meta = [bool]($mods -and $mods.meta)
                [VeloDeckWinInput]::KeyEvent($phase, $code, $key, $ctrl, $alt, $shift, $meta)
            }
            "text" {
                $text = if ($null -ne $cmd.text) { [string]$cmd.text } else { "" }
                $submit = [bool]$cmd.submit
                [VeloDeckWinInput]::SendUnicodeText($text, $submit)
            }
            "lock" {
                [VeloDeckWinInput]::Lock()
            }
            "release_all" {
                [VeloDeckWinInput]::ReleaseAll()
            }
        }
    }
} finally {
    [VeloDeckWinInput]::ReleaseAll()
}
