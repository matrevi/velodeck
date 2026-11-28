import Foundation
import CoreGraphics
import ApplicationServices
import AppKit

// VeloDeck macOS Native Input & Permission Helper
// Modes:
//   --check-permissions      Prints {"accessibility":bool,"screenCapture":bool} and exits 0
//   --request-accessibility  Triggers macOS Accessibility prompt, prints permission JSON, exits 0
//   --request-screen         Triggers macOS Screen Recording prompt, prints permission JSON, exits 0
//   (default)                Persistent NDJSON daemon reading commands from stdin

private let VELODECK_EVENT_MAGIC: Int64 = 0x56444C4B
private let stdoutLock = NSLock()

private func writeStdoutLine(_ line: String) {
    stdoutLock.lock()
    defer { stdoutLock.unlock() }
    print(line)
    fflush(stdout)
}

private struct ButtonState {
    var leftDown = false
    var rightDown = false
    var middleDown = false
    var lastPoint = CGPoint(x: 0, y: 0)
}

private func printPermissionsJson(accessibility: Bool, screenCapture: Bool) {
    let accStr = accessibility ? "true" : "false"
    let scrStr = screenCapture ? "true" : "false"
    writeStdoutLine("{\"accessibility\":\(accStr),\"screenCapture\":\(scrStr)}")
}

private func activeDisplaysUnionBounds() -> CGRect {
    var displayCount: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &displayCount)
    if displayCount == 0 {
        return CGDisplayBounds(CGMainDisplayID())
    }
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
    let err = CGGetActiveDisplayList(displayCount, &displays, &displayCount)
    if err != .success || displayCount == 0 {
        return CGDisplayBounds(CGMainDisplayID())
    }
    var unionRect = CGDisplayBounds(displays[0])
    for i in 1..<Int(displayCount) {
        unionRect = unionRect.union(CGDisplayBounds(displays[i]))
    }
    return unionRect
}

private final class CursorShapeClassifier {
    private struct Entry {
        let cursor: NSCursor
        let tiff: Data?
        let hotSpot: NSPoint
        let shape: String
    }

    private lazy var entries: [Entry] = {
        let pairs: [(NSCursor, String)] = [
            (NSCursor.arrow, "default"),
            (NSCursor.iBeam, "text"),
            (NSCursor.iBeamCursorForVerticalLayout, "text"),
            (NSCursor.pointingHand, "pointer"),
            (NSCursor.crosshair, "crosshair"),
            (NSCursor.openHand, "grab"),
            (NSCursor.closedHand, "grabbing"),
            (NSCursor.resizeLeftRight, "ew-resize"),
            (NSCursor.resizeLeft, "ew-resize"),
            (NSCursor.resizeRight, "ew-resize"),
            (NSCursor.resizeUpDown, "ns-resize"),
            (NSCursor.resizeUp, "ns-resize"),
            (NSCursor.resizeDown, "ns-resize"),
            (NSCursor.operationNotAllowed, "not-allowed"),
        ]
        return pairs.map { (cur, shape) in
            Entry(
                cursor: cur,
                tiff: cur.image.tiffRepresentation,
                hotSpot: cur.hotSpot,
                shape: shape
            )
        }
    }()

    func queryCurrentShape() -> String {
        guard let current = NSCursor.currentSystem else {
            return "default"
        }
        let currentTiff = current.image.tiffRepresentation
        for entry in entries {
            if current == entry.cursor {
                return entry.shape
            }
            if let curTiff = currentTiff, let refTiff = entry.tiff, curTiff == refTiff {
                return entry.shape
            }
        }
        return "default"
    }
}

private let cursorClassifier = CursorShapeClassifier()

private func inputBlockTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let raw = userInfo else {
        return Unmanaged.passUnretained(event)
    }
    let blocker = Unmanaged<InputBlocker>.fromOpaque(raw).takeUnretainedValue()

    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        blocker.reenableIfActive()
        return Unmanaged.passUnretained(event)
    }

    if !blocker.isEnabled {
        return Unmanaged.passUnretained(event)
    }

    // Always allow events injected by VeloDeck itself
    if event.getIntegerValueField(.eventSourceUserData) == VELODECK_EVENT_MAGIC {
        return Unmanaged.passUnretained(event)
    }

    // Emergency local unlock: Option+Ctrl+Esc or Option+Cmd+Esc
    if type == .keyDown {
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let flags = event.flags
        if keyCode == 53 &&
            flags.contains(.maskAlternate) &&
            (flags.contains(.maskControl) || flags.contains(.maskCommand)) {
            blocker.disableFromEmergencyUnlock()
            return Unmanaged.passUnretained(event)
        }
    }

    // Block all other local physical mouse/keyboard events while enabled
    return nil
}

private final class InputBlocker {
    private let lock = NSLock()
    private var enabled = false
    private var machPort: CFMachPort?
    private var runLoop: CFRunLoop?
    private var runLoopSource: CFRunLoopSource?
    private var tapThread: Thread?

    var isEnabled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return enabled
    }

    func reenableIfActive() {
        lock.lock()
        let active = enabled
        let port = machPort
        lock.unlock()
        if active, let port = port {
            CGEvent.tapEnable(tap: port, enable: true)
        }
    }

    func disableFromEmergencyUnlock() {
        _ = setEnabled(false)
        writeStdoutLine("{\"event\":\"block_input_unlocked\"}")
    }

    @discardableResult
    func setEnabled(_ target: Bool) -> Bool {
        if !target {
            lock.lock()
            enabled = false
            let port = machPort
            let rl = runLoop
            lock.unlock()
            if let port = port {
                CGEvent.tapEnable(tap: port, enable: false)
            }
            if let rl = rl {
                CFRunLoopStop(rl)
            }
            return true
        }

        lock.lock()
        if enabled && machPort != nil {
            lock.unlock()
            return true
        }
        lock.unlock()

        let readySem = DispatchSemaphore(value: 0)
        var created = false

        let thread = Thread { [weak self] in
            guard let self = self else {
                readySem.signal()
                return
            }

            let mask: CGEventMask =
                (1 << CGEventType.leftMouseDown.rawValue) |
                (1 << CGEventType.leftMouseUp.rawValue) |
                (1 << CGEventType.rightMouseDown.rawValue) |
                (1 << CGEventType.rightMouseUp.rawValue) |
                (1 << CGEventType.mouseMoved.rawValue) |
                (1 << CGEventType.leftMouseDragged.rawValue) |
                (1 << CGEventType.rightMouseDragged.rawValue) |
                (1 << CGEventType.otherMouseDown.rawValue) |
                (1 << CGEventType.otherMouseUp.rawValue) |
                (1 << CGEventType.otherMouseDragged.rawValue) |
                (1 << CGEventType.scrollWheel.rawValue) |
                (1 << CGEventType.keyDown.rawValue) |
                (1 << CGEventType.keyUp.rawValue) |
                (1 << CGEventType.flagsChanged.rawValue)

            guard let tap = CGEvent.tapCreate(
                tap: .cgSessionEventTap,
                place: .headInsertEventTap,
                options: .defaultTap,
                eventsOfInterest: mask,
                callback: inputBlockTapCallback,
                userInfo: Unmanaged.passUnretained(self).toOpaque()
            ) else {
                readySem.signal()
                return
            }

            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            let rl = CFRunLoopGetCurrent()
            if let source = source, let rl = rl {
                CFRunLoopAddSource(rl, source, .commonModes)
            }
            CGEvent.tapEnable(tap: tap, enable: true)

            self.lock.lock()
            self.machPort = tap
            self.runLoop = rl
            self.runLoopSource = source
            self.enabled = true
            self.lock.unlock()

            created = true
            readySem.signal()

            CFRunLoopRun()

            // Cleanup after run loop stops
            CGEvent.tapEnable(tap: tap, enable: false)
            if let source = source, let rl = rl {
                CFRunLoopRemoveSource(rl, source, .commonModes)
            }
            CFMachPortInvalidate(tap)

            self.lock.lock()
            if self.machPort === tap {
                self.machPort = nil
                self.runLoop = nil
                self.runLoopSource = nil
                self.tapThread = nil
                self.enabled = false
            }
            self.lock.unlock()
        }

        lock.lock()
        tapThread = thread
        lock.unlock()
        thread.start()

        _ = readySem.wait(timeout: .now() + 2.0)
        return created
    }
}

private let inputBlocker = InputBlocker()

private func makeEventSource() -> CGEventSource? {
    guard let src = CGEventSource(stateID: .hidSystemState) else {
        return nil
    }
    src.localEventsSuppressionInterval = 0.0
    return src
}

private func parseModifiers(_ dict: [String: Any]?) -> CGEventFlags {
    guard let m = dict else { return [] }
    var flags: CGEventFlags = []
    if (m["meta"] as? Bool) == true { flags.insert(.maskCommand) }
    if (m["ctrl"] as? Bool) == true { flags.insert(.maskControl) }
    if (m["alt"] as? Bool) == true { flags.insert(.maskAlternate) }
    if (m["shift"] as? Bool) == true { flags.insert(.maskShift) }
    return flags
}

private let domCodeToMacKeyCode: [String: CGKeyCode] = [
    // Letters (ANSI US layout virtual key codes)
    "KeyA": 0x00,
    "KeyS": 0x01,
    "KeyD": 0x02,
    "KeyF": 0x03,
    "KeyH": 0x04,
    "KeyG": 0x05,
    "KeyZ": 0x06,
    "KeyX": 0x07,
    "KeyC": 0x08,
    "KeyV": 0x09,
    "KeyB": 0x0B,
    "KeyQ": 0x0C,
    "KeyW": 0x0D,
    "KeyE": 0x0E,
    "KeyR": 0x0F,
    "KeyY": 0x10,
    "KeyT": 0x11,
    "KeyO": 0x1F,
    "KeyU": 0x20,
    "KeyI": 0x22,
    "KeyP": 0x23,
    "KeyL": 0x25,
    "KeyJ": 0x26,
    "KeyK": 0x28,
    "KeyN": 0x2D,
    "KeyM": 0x2E,

    // Top row digits
    "Digit1": 0x12,
    "Digit2": 0x13,
    "Digit3": 0x14,
    "Digit4": 0x15,
    "Digit6": 0x16,
    "Digit5": 0x17,
    "Digit9": 0x19,
    "Digit7": 0x1A,
    "Digit8": 0x1C,
    "Digit0": 0x1D,

    // Punctuation & symbols
    "Equal": 0x18,
    "Minus": 0x1B,
    "BracketRight": 0x1E,
    "BracketLeft": 0x21,
    "Quote": 0x27,
    "Semicolon": 0x29,
    "Backslash": 0x2A,
    "IntlBackslash": 0x0A,
    "Comma": 0x2B,
    "Slash": 0x2C,
    "Period": 0x2F,
    "Backquote": 0x32,

    // Editing & control keys
    "Enter": 0x24,
    "Tab": 0x30,
    "Space": 0x31,
    "Backspace": 0x33,
    "Escape": 0x35,
    "Delete": 0x75,
    "Home": 0x73,
    "End": 0x77,
    "PageUp": 0x74,
    "PageDown": 0x79,

    // Arrows
    "ArrowLeft": 0x7B,
    "ArrowRight": 0x7C,
    "ArrowDown": 0x7D,
    "ArrowUp": 0x7E,

    // Modifiers
    "MetaRight": 0x36,
    "MetaLeft": 0x37,
    "ShiftLeft": 0x38,
    "CapsLock": 0x39,
    "AltLeft": 0x3A,
    "ControlLeft": 0x3B,
    "ShiftRight": 0x3C,
    "AltRight": 0x3D,
    "ControlRight": 0x3E,

    // Function keys
    "F1": 0x7A,
    "F2": 0x78,
    "F3": 0x63,
    "F4": 0x76,
    "F5": 0x60,
    "F6": 0x61,
    "F7": 0x62,
    "F8": 0x64,
    "F9": 0x65,
    "F10": 0x6D,
    "F11": 0x67,
    "F12": 0x6F,
    "F13": 0x69,
    "F14": 0x6B,
    "F15": 0x71,
    "F16": 0x6A,
    "F17": 0x40,
    "F18": 0x4F,
    "F19": 0x50,
    "F20": 0x5A,
    "Insert": 0x72,
    "Help": 0x72,
    "ContextMenu": 0x6E,

    // Numpad
    "Numpad0": 0x52,
    "Numpad1": 0x53,
    "Numpad2": 0x54,
    "Numpad3": 0x55,
    "Numpad4": 0x56,
    "Numpad5": 0x57,
    "Numpad6": 0x58,
    "Numpad7": 0x59,
    "Numpad8": 0x5B,
    "Numpad9": 0x5C,
    "NumpadDecimal": 0x41,
    "NumpadMultiply": 0x43,
    "NumpadAdd": 0x45,
    "NumpadDivide": 0x4B,
    "NumpadEnter": 0x4C,
    "NumpadSubtract": 0x4E,
    "NumpadEqual": 0x51,

    // Volume / Media
    "AudioVolumeUp": 0x48,
    "AudioVolumeDown": 0x49,
    "AudioVolumeMute": 0x4A,
]

private let domKeyToMacKeyCode: [String: CGKeyCode] = [
    "enter": 0x24,
    "return": 0x24,
    "backspace": 0x33,
    "tab": 0x30,
    "escape": 0x35,
    "esc": 0x35,
    " ": 0x31,
    "spacebar": 0x31,
    "space": 0x31,
    "delete": 0x75,
    "del": 0x75,
    "home": 0x73,
    "end": 0x77,
    "pageup": 0x74,
    "pagedown": 0x79,
    "arrowleft": 0x7B,
    "arrowright": 0x7C,
    "arrowdown": 0x7D,
    "arrowup": 0x7E,
    "meta": 0x37,
    "control": 0x3B,
    "alt": 0x3A,
    "shift": 0x38,
    "capslock": 0x39,
    "f1": 0x7A,
    "f2": 0x78,
    "f3": 0x63,
    "f4": 0x76,
    "f5": 0x60,
    "f6": 0x61,
    "f7": 0x62,
    "f8": 0x64,
    "f9": 0x65,
    "f10": 0x6D,
    "f11": 0x67,
    "f12": 0x6F,
    "f13": 0x69,
    "f14": 0x6B,
    "f15": 0x71,
    "audiovolumeup": 0x48,
    "audiovolumedown": 0x49,
    "audiovolumemute": 0x4A,
    "-": 0x1B,
    "=": 0x18,
    "[": 0x21,
    "]": 0x1E,
    "\\": 0x2A,
    ";": 0x29,
    "'": 0x27,
    "`": 0x32,
    ",": 0x2B,
    ".": 0x2F,
    "/": 0x2C,
]

private func resolveKeyCode(code: String?, key: String?) -> CGKeyCode? {
    if let c = code, !c.isEmpty, let mapped = domCodeToMacKeyCode[c] {
        return mapped
    }
    if let k = key, !k.isEmpty {
        let lower = k.lowercased()
        if let mapped = domKeyToMacKeyCode[lower] {
            return mapped
        }
        if lower.count == 1, let scalar = lower.unicodeScalars.first {
            let v = scalar.value
            if v >= 97 && v <= 122 { // 'a'...'z'
                let upperChar = Character(UnicodeScalar(v - 32)!)
                if let mapped = domCodeToMacKeyCode["Key\(upperChar)"] {
                    return mapped
                }
            } else if v >= 48 && v <= 57 { // '0'...'9'
                let digitChar = Character(scalar)
                if let mapped = domCodeToMacKeyCode["Digit\(digitChar)"] {
                    return mapped
                }
            }
        }
    }
    return nil
}

private func isModifierKeyCode(_ keyCode: CGKeyCode) -> Bool {
    switch keyCode {
    case 0x36, 0x37, 0x38, 0x39, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E:
        return true
    default:
        return false
    }
}

private func flagForModifierKeyCode(_ keyCode: CGKeyCode) -> CGEventFlags {
    switch keyCode {
    case 0x36, 0x37: return .maskCommand
    case 0x38, 0x3C: return .maskShift
    case 0x39: return .maskAlphaShift
    case 0x3A, 0x3D: return .maskAlternate
    case 0x3B, 0x3E: return .maskControl
    default: return []
    }
}

private func readDouble(_ dict: [String: Any], _ key: String, default fallback: Double = 0.0) -> Double {
    if let n = dict[key] as? NSNumber {
        let v = n.doubleValue
        return v.isFinite ? v : fallback
    }
    return fallback
}

private func readInt(_ dict: [String: Any], _ key: String, default fallback: Int = 0) -> Int {
    if let n = dict[key] as? NSNumber {
        return n.intValue
    }
    return fallback
}

private func postMouseEvent(
    source: CGEventSource?,
    type: CGEventType,
    point: CGPoint,
    button: CGMouseButton,
    clickCount: Int64? = nil,
    deltaX: Int64? = nil,
    deltaY: Int64? = nil
) {
    guard let ev = CGEvent(
        mouseEventSource: source,
        mouseType: type,
        mouseCursorPosition: point,
        mouseButton: button
    ) else {
        return
    }
    if let count = clickCount {
        ev.setIntegerValueField(.mouseEventClickState, value: max(1, min(3, count)))
    }
    if let dx = deltaX {
        ev.setIntegerValueField(.mouseEventDeltaX, value: dx)
    }
    if let dy = deltaY {
        ev.setIntegerValueField(.mouseEventDeltaY, value: dy)
    }
    ev.setIntegerValueField(.eventSourceUserData, value: VELODECK_EVENT_MAGIC)
    ev.post(tap: .cghidEventTap)
}

private func postKey(
    source: CGEventSource?,
    keyCode: CGKeyCode,
    keyDown: Bool,
    flags: CGEventFlags
) {
    guard let ev = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: keyDown) else {
        return
    }
    var effectiveFlags = flags
    if isModifierKeyCode(keyCode) {
        let modFlag = flagForModifierKeyCode(keyCode)
        if keyDown {
            effectiveFlags.insert(modFlag)
        } else {
            effectiveFlags.remove(modFlag)
        }
    }
    ev.flags = effectiveFlags
    ev.setIntegerValueField(.eventSourceUserData, value: VELODECK_EVENT_MAGIC)
    ev.post(tap: .cghidEventTap)
}

private func injectUnicodeText(source: CGEventSource?, text: String) {
    if text.isEmpty { return }
    let units = Array(text.utf16)
    var index = 0
    let maxChunk = 16

    while index < units.count {
        var end = min(index + maxChunk, units.count)
        // Never split a UTF-16 high/low surrogate pair across chunks
        if end < units.count {
            let lastUnit = units[end - 1]
            if lastUnit >= 0xD800 && lastUnit <= 0xDBFF && end > index + 1 {
                end -= 1
            }
        }
        var chunk = Array(units[index..<end])
        if let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true) {
            down.flags = []
            chunk.withUnsafeMutableBufferPointer { buf in
                if let ptr = buf.baseAddress {
                    down.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: ptr)
                }
            }
            down.setIntegerValueField(.eventSourceUserData, value: VELODECK_EVENT_MAGIC)
            down.post(tap: .cghidEventTap)
        }
        if let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) {
            up.flags = []
            chunk.withUnsafeMutableBufferPointer { buf in
                if let ptr = buf.baseAddress {
                    up.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: ptr)
                }
            }
            up.setIntegerValueField(.eventSourceUserData, value: VELODECK_EVENT_MAGIC)
            up.post(tap: .cghidEventTap)
        }
        index = end
    }
}

private func handleCommand(_ dict: [String: Any], state: inout ButtonState, source: CGEventSource?) {
    guard let action = dict["action"] as? String else { return }

    switch action {
    case "ping":
        writeStdoutLine("{\"ok\":true,\"pong\":true}")

    case "query_cursor":
        let shape = cursorClassifier.queryCurrentShape()
        writeStdoutLine("{\"ok\":true,\"cursor\":\"\(shape)\"}")

    case "block_input":
        let enabled = (dict["enabled"] as? Bool) == true
        let ok = inputBlocker.setEnabled(enabled)
        if enabled && !ok {
            writeStdoutLine("{\"event\":\"block_input_unlocked\"}")
        }

    case "mouse_move":
        let pt = CGPoint(x: readDouble(dict, "x"), y: readDouble(dict, "y"))
        state.lastPoint = pt
        if state.leftDown {
            postMouseEvent(source: source, type: .leftMouseDragged, point: pt, button: .left)
        } else if state.rightDown {
            postMouseEvent(source: source, type: .rightMouseDragged, point: pt, button: .right)
        } else if state.middleDown {
            postMouseEvent(source: source, type: .otherMouseDragged, point: pt, button: .center)
        } else {
            postMouseEvent(source: source, type: .mouseMoved, point: pt, button: .left)
        }

    case "mouse_move_relative":
        let dx = max(-2000, min(2000, Int(round(readDouble(dict, "dx")))))
        let dy = max(-2000, min(2000, Int(round(readDouble(dict, "dy")))))
        let currentLoc = CGEvent(source: nil)?.location ?? state.lastPoint
        let union = activeDisplaysUnionBounds()
        let maxX = max(union.minX, union.maxX - 1.0)
        let maxY = max(union.minY, union.maxY - 1.0)
        let nextX = min(max(currentLoc.x + Double(dx), union.minX), maxX)
        let nextY = min(max(currentLoc.y + Double(dy), union.minY), maxY)
        let nextPt = CGPoint(x: nextX, y: nextY)
        state.lastPoint = nextPt
        if state.leftDown {
            postMouseEvent(
                source: source,
                type: .leftMouseDragged,
                point: nextPt,
                button: .left,
                deltaX: Int64(dx),
                deltaY: Int64(dy)
            )
        } else if state.rightDown {
            postMouseEvent(
                source: source,
                type: .rightMouseDragged,
                point: nextPt,
                button: .right,
                deltaX: Int64(dx),
                deltaY: Int64(dy)
            )
        } else if state.middleDown {
            postMouseEvent(
                source: source,
                type: .otherMouseDragged,
                point: nextPt,
                button: .center,
                deltaX: Int64(dx),
                deltaY: Int64(dy)
            )
        } else {
            postMouseEvent(
                source: source,
                type: .mouseMoved,
                point: nextPt,
                button: .left,
                deltaX: Int64(dx),
                deltaY: Int64(dy)
            )
        }

    case "mouse_down":
        let pt = CGPoint(x: readDouble(dict, "x"), y: readDouble(dict, "y"))
        let buttonStr = (dict["button"] as? String ?? "left").lowercased()
        let clickCount = Int64(max(1, min(3, readInt(dict, "clickCount", default: 1))))
        state.lastPoint = pt
        switch buttonStr {
        case "right":
            state.rightDown = true
            postMouseEvent(source: source, type: .rightMouseDown, point: pt, button: .right, clickCount: clickCount)
        case "middle":
            state.middleDown = true
            postMouseEvent(source: source, type: .otherMouseDown, point: pt, button: .center, clickCount: clickCount)
        default:
            state.leftDown = true
            postMouseEvent(source: source, type: .leftMouseDown, point: pt, button: .left, clickCount: clickCount)
        }

    case "mouse_up":
        let pt = CGPoint(x: readDouble(dict, "x"), y: readDouble(dict, "y"))
        let buttonStr = (dict["button"] as? String ?? "left").lowercased()
        let clickCount = Int64(max(1, min(3, readInt(dict, "clickCount", default: 1))))
        state.lastPoint = pt
        switch buttonStr {
        case "right":
            state.rightDown = false
            postMouseEvent(source: source, type: .rightMouseUp, point: pt, button: .right, clickCount: clickCount)
        case "middle":
            state.middleDown = false
            postMouseEvent(source: source, type: .otherMouseUp, point: pt, button: .center, clickCount: clickCount)
        default:
            state.leftDown = false
            postMouseEvent(source: source, type: .leftMouseUp, point: pt, button: .left, clickCount: clickCount)
        }

    case "mouse_wheel":
        if dict["x"] != nil && dict["y"] != nil {
            let pt = CGPoint(x: readDouble(dict, "x"), y: readDouble(dict, "y"))
            if abs(pt.x - state.lastPoint.x) > 1.0 || abs(pt.y - state.lastPoint.y) > 1.0 {
                state.lastPoint = pt
                postMouseEvent(source: source, type: .mouseMoved, point: pt, button: .left)
            }
        }
        let rawDx = readInt(dict, "deltaX", default: 0)
        let rawDy = readInt(dict, "deltaY", default: 0)
        let clampedDx = max(-2000, min(2000, rawDx))
        let clampedDy = max(-2000, min(2000, rawDy))
        if let ev = CGEvent(
            scrollWheelEvent2Source: source,
            units: .pixel,
            wheelCount: 2,
            wheel1: Int32(-clampedDy),
            wheel2: Int32(-clampedDx),
            wheel3: 0
        ) {
            ev.setIntegerValueField(.eventSourceUserData, value: VELODECK_EVENT_MAGIC)
            ev.post(tap: .cghidEventTap)
        }

    case "tap":
        let pt = CGPoint(x: readDouble(dict, "x"), y: readDouble(dict, "y"))
        let clickCount = Int64(max(1, min(3, readInt(dict, "clickCount", default: 1))))
        state.lastPoint = pt
        postMouseEvent(source: source, type: .mouseMoved, point: pt, button: .left)
        postMouseEvent(source: source, type: .leftMouseDown, point: pt, button: .left, clickCount: clickCount)
        postMouseEvent(source: source, type: .leftMouseUp, point: pt, button: .left, clickCount: clickCount)

    case "long_press":
        let pt = CGPoint(x: readDouble(dict, "x"), y: readDouble(dict, "y"))
        state.lastPoint = pt
        postMouseEvent(source: source, type: .mouseMoved, point: pt, button: .left)
        postMouseEvent(source: source, type: .rightMouseDown, point: pt, button: .right, clickCount: 1)
        postMouseEvent(source: source, type: .rightMouseUp, point: pt, button: .right, clickCount: 1)

    case "key_event":
        let phase = (dict["phase"] as? String ?? "press").lowercased()
        let code = dict["code"] as? String
        let key = dict["key"] as? String
        let flags = parseModifiers(dict["modifiers"] as? [String: Any])
        if let keyCode = resolveKeyCode(code: code, key: key) {
            switch phase {
            case "down":
                postKey(source: source, keyCode: keyCode, keyDown: true, flags: flags)
            case "up":
                postKey(source: source, keyCode: keyCode, keyDown: false, flags: flags)
            default:
                postKey(source: source, keyCode: keyCode, keyDown: true, flags: flags)
                postKey(source: source, keyCode: keyCode, keyDown: false, flags: flags)
            }
        } else if phase != "up",
                  let keyStr = key,
                  keyStr.count == 1,
                  !flags.contains(.maskCommand),
                  !flags.contains(.maskControl),
                  !flags.contains(.maskAlternate) {
            injectUnicodeText(source: source, text: keyStr)
        }

    case "text":
        let text = dict["text"] as? String ?? ""
        let submit = (dict["submit"] as? Bool) == true
        if !text.isEmpty {
            injectUnicodeText(source: source, text: text)
        }
        if submit {
            postKey(source: source, keyCode: 0x24, keyDown: true, flags: [])
            postKey(source: source, keyCode: 0x24, keyDown: false, flags: [])
        }

    case "lock":
        let flags: CGEventFlags = [.maskControl, .maskCommand]
        postKey(source: source, keyCode: 0x0C, keyDown: true, flags: flags)
        postKey(source: source, keyCode: 0x0C, keyDown: false, flags: flags)

    case "release_all":
        inputBlocker.setEnabled(false)
        if state.leftDown {
            state.leftDown = false
            postMouseEvent(source: source, type: .leftMouseUp, point: state.lastPoint, button: .left, clickCount: 1)
        }
        if state.rightDown {
            state.rightDown = false
            postMouseEvent(source: source, type: .rightMouseUp, point: state.lastPoint, button: .right, clickCount: 1)
        }
        if state.middleDown {
            state.middleDown = false
            postMouseEvent(source: source, type: .otherMouseUp, point: state.lastPoint, button: .center, clickCount: 1)
        }

    default:
        break
    }
}

// Entrypoint
let args = CommandLine.arguments
if args.contains("--check-permissions") {
    let acc = AXIsProcessTrusted()
    let scr = CGPreflightScreenCaptureAccess()
    printPermissionsJson(accessibility: acc, screenCapture: scr)
    exit(0)
}

if args.contains("--request-accessibility") {
    let promptKey = "AXTrustedCheckOptionPrompt" as CFString
    let options = [promptKey: kCFBooleanTrue!] as CFDictionary
    let acc = AXIsProcessTrustedWithOptions(options)
    let scr = CGPreflightScreenCaptureAccess()
    printPermissionsJson(accessibility: acc, screenCapture: scr)
    exit(0)
}

if args.contains("--request-screen") {
    let scr = CGRequestScreenCaptureAccess()
    let acc = AXIsProcessTrusted()
    printPermissionsJson(accessibility: acc, screenCapture: scr)
    exit(0)
}

setbuf(stdout, nil)
private var buttonState = ButtonState()
private let eventSource = makeEventSource()

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }
    guard let data = trimmed.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data, options: []),
          let dict = obj as? [String: Any] else {
        continue
    }
    handleCommand(dict, state: &buttonState, source: eventSource)
}

inputBlocker.setEnabled(false)
