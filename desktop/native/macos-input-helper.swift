import Foundation
import Darwin
import CoreGraphics
import ApplicationServices
import AppKit

// VeloDeck macOS Native Input, Permission & PTY Helper
// Modes:
//   --pty-bridge <cols> <rows> <shell> [cwd]  Real Darwin openpty() JSON-framed stdio PTY bridge
//   --check-permissions                       Prints {"accessibility":bool,"screenCapture":bool} and exits 0
//   --request-accessibility                   Triggers macOS Accessibility prompt, prints JSON, exits 0
//   --request-screen                          Triggers macOS Screen Recording prompt, prints JSON, exits 0
//   --check-cursors                           Initializes AppKit & verifies reference cursors, prints JSON, exits 0
//   (default)                                 Persistent NDJSON daemon reading commands from stdin

private let VELODECK_EVENT_MAGIC: Int64 = 0x56444C4B
private let stdoutLock = NSLock()

private func writeStdoutLine(_ line: String) {
    stdoutLock.lock()
    defer { stdoutLock.unlock() }
    let out = line + "\n"
    out.withCString { ptr in
        let len = strlen(ptr)
        var written = 0
        while written < len {
            let n = Darwin.write(STDOUT_FILENO, ptr.advanced(by: written), len - written)
            if n > 0 {
                written += n
            } else if n < 0 && errno == EINTR {
                continue
            } else {
                break
            }
        }
    }
}

// MARK: - Native macOS PTY Bridge (--pty-bridge)
// Runs BEFORE any AppKit/CoreGraphics initialization so fork() is completely single-threaded and safe.

private let DARWIN_TIOCSWINSZ: UInt = 0x80087467
private let DARWIN_TIOCSCTTY: UInt = 0x20007461

private var ptyBridgeChildPid: pid_t = 0

private func ptyBridgeSignalHandler(_ sig: Int32) {
    let pid = ptyBridgeChildPid
    if pid > 0 {
        Darwin.kill(-pid, SIGHUP)
        Darwin.kill(-pid, SIGTERM)
    }
    Darwin._exit(0)
}

private func writeAllFd(_ fd: Int32, bytes: UnsafePointer<UInt8>, count: Int) -> Bool {
    var written = 0
    while written < count {
        let n = Darwin.write(fd, bytes.advanced(by: written), count - written)
        if n > 0 {
            written += n
        } else if n < 0 {
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                _ = Darwin.poll(&pfd, 1, 50)
                continue
            }
            return false
        } else {
            return false
        }
    }
    return true
}

private func terminatePtyChild(_ childPid: pid_t) {
    guard childPid > 0 else { return }
    _ = Darwin.kill(-childPid, SIGHUP)
    _ = Darwin.kill(-childPid, SIGTERM)
    var status: Int32 = 0
    for _ in 0..<15 {
        let r = Darwin.waitpid(childPid, &status, WNOHANG)
        if r == childPid || (r < 0 && errno == ECHILD) {
            return
        }
        usleep(20_000)
    }
    _ = Darwin.kill(-childPid, SIGKILL)
    _ = Darwin.waitpid(childPid, &status, 0)
}

private func runPtyBridge(args: [String]) -> Never {
    let colsRaw = args.count >= 1 ? (Int(args[0]) ?? 100) : 100
    let rowsRaw = args.count >= 2 ? (Int(args[1]) ?? 30) : 30
    let cols = max(20, min(300, colsRaw))
    let rows = max(5, min(120, rowsRaw))

    let requestedShell = args.count >= 3 ? args[2] : "/bin/zsh"
    let shellPath: String
    if !requestedShell.isEmpty && access(requestedShell, X_OK) == 0 {
        shellPath = requestedShell
    } else if access("/bin/zsh", X_OK) == 0 {
        shellPath = "/bin/zsh"
    } else if access("/bin/bash", X_OK) == 0 {
        shellPath = "/bin/bash"
    } else {
        shellPath = "/bin/sh"
    }

    let requestedCwd = args.count >= 4 ? args[3] : ""

    var masterFd: Int32 = -1
    var slaveFd: Int32 = -1
    var ws = winsize(
        ws_row: UInt16(rows),
        ws_col: UInt16(cols),
        ws_xpixel: 0,
        ws_ypixel: 0
    )

    if Darwin.openpty(&masterFd, &slaveFd, nil, nil, &ws) != 0 {
        writeStdoutLine("{\"type\":\"error\",\"error\":\"openpty failed (errno=\(errno))\"}")
        Darwin._exit(1)
    }

    _ = fcntl(masterFd, F_SETFD, FD_CLOEXEC)

    // Resolve POSIX fork() via dlsym before any threads or AppKit exist.
    typealias ForkFn = @convention(c) () -> pid_t
    guard let forkSym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "fork") else {
        Darwin.close(masterFd)
        Darwin.close(slaveFd)
        writeStdoutLine("{\"type\":\"error\",\"error\":\"fork symbol unavailable\"}")
        Darwin._exit(1)
    }
    let cFork = unsafeBitCast(forkSym, to: ForkFn.self)

    // Pre-allocate C strings before fork so the child only calls async-signal-safe POSIX functions.
    let shellCStr = strdup(shellPath)
    let arg0CStr = strdup(shellPath)
    let arg1CStr = strdup("-i")
    let cwdCStr = !requestedCwd.isEmpty ? strdup(requestedCwd) : nil
    let argvBuf = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: 3)
    argvBuf[0] = arg0CStr
    argvBuf[1] = arg1CStr
    argvBuf[2] = nil

    let pid = cFork()
    if pid < 0 {
        Darwin.close(masterFd)
        Darwin.close(slaveFd)
        writeStdoutLine("{\"type\":\"error\",\"error\":\"fork failed (errno=\(errno))\"}")
        Darwin._exit(1)
    }

    if pid == 0 {
        // Child process: establish new session & controlling terminal
        Darwin.close(masterFd)
        _ = Darwin.setsid()
        _ = Darwin.ioctl(slaveFd, DARWIN_TIOCSCTTY, 0)
        _ = Darwin.dup2(slaveFd, STDIN_FILENO)
        _ = Darwin.dup2(slaveFd, STDOUT_FILENO)
        _ = Darwin.dup2(slaveFd, STDERR_FILENO)
        if slaveFd > STDERR_FILENO {
            Darwin.close(slaveFd)
        }
        if let cwdPtr = cwdCStr {
            _ = Darwin.chdir(cwdPtr)
        }
        Darwin.execv(shellCStr, argvBuf)
        Darwin._exit(127)
    }

    // Parent process
    Darwin.close(slaveFd)
    if let p = shellCStr { free(p) }
    if let p = arg0CStr { free(p) }
    if let p = arg1CStr { free(p) }
    if let p = cwdCStr { free(p) }
    argvBuf.deallocate()

    ptyBridgeChildPid = pid
    signal(SIGPIPE, SIG_IGN)
    signal(SIGTERM, ptyBridgeSignalHandler)
    signal(SIGINT, ptyBridgeSignalHandler)
    signal(SIGHUP, ptyBridgeSignalHandler)

    // Make stdin and masterFd non-blocking for multiplexed poll() loop
    let stdinFlags = fcntl(STDIN_FILENO, F_GETFL, 0)
    if stdinFlags >= 0 {
        _ = fcntl(STDIN_FILENO, F_SETFL, stdinFlags | O_NONBLOCK)
    }
    let masterFlags = fcntl(masterFd, F_GETFL, 0)
    if masterFlags >= 0 {
        _ = fcntl(masterFd, F_SETFL, masterFlags | O_NONBLOCK)
    }

    var stdinBuffer = Data()
    var stdinClosed = false
    var masterClosed = false
    var shouldTerminateChild = false
    var readBuf = [UInt8](repeating: 0, count: 4096)

    while !masterClosed && !shouldTerminateChild {
        var fds: [pollfd] = [
            pollfd(fd: masterFd, events: Int16(POLLIN), revents: 0),
            pollfd(fd: stdinClosed ? -1 : STDIN_FILENO, events: Int16(POLLIN), revents: 0),
        ]

        let pollRes = Darwin.poll(&fds, nfds_t(fds.count), 200)
        if pollRes < 0 {
            if errno == EINTR { continue }
            break
        }

        autoreleasepool {
            // 1) Drain PTY output
            if (fds[0].revents & Int16(POLLIN | POLLHUP | POLLERR)) != 0 {
                while true {
                    let n = Darwin.read(masterFd, &readBuf, readBuf.count)
                    if n > 0 {
                        let chunk = Data(bytes: readBuf, count: n)
                        let b64 = chunk.base64EncodedString()
                        writeStdoutLine("{\"type\":\"data\",\"b64\":\"\(b64)\"}")
                    } else if n == 0 {
                        masterClosed = true
                        break
                    } else {
                        if errno == EINTR { continue }
                        if errno == EAGAIN || errno == EWOULDBLOCK { break }
                        // EIO on macOS master PTY indicates slave closed
                        masterClosed = true
                        break
                    }
                }
            }

            // 2) Drain JSON commands from stdin
            if !stdinClosed && (fds[1].revents & Int16(POLLIN | POLLHUP | POLLERR)) != 0 {
                while true {
                    let n = Darwin.read(STDIN_FILENO, &readBuf, readBuf.count)
                    if n > 0 {
                        stdinBuffer.append(contentsOf: readBuf[0..<n])
                        // Cap malformed unbounded line buffer
                        if stdinBuffer.count > 512 * 1024 {
                            stdinBuffer.removeAll(keepingCapacity: false)
                        }
                    } else if n == 0 {
                        stdinClosed = true
                        shouldTerminateChild = true
                        break
                    } else {
                        if errno == EINTR { continue }
                        if errno == EAGAIN || errno == EWOULDBLOCK { break }
                        stdinClosed = true
                        shouldTerminateChild = true
                        break
                    }
                }

                // Process newline-delimited JSON messages
                while let nlIndex = stdinBuffer.firstIndex(of: 0x0A) {
                    let lineData = stdinBuffer.subdata(in: stdinBuffer.startIndex..<nlIndex)
                    stdinBuffer.removeSubrange(stdinBuffer.startIndex...nlIndex)
                    if lineData.isEmpty { continue }
                    guard let obj = try? JSONSerialization.jsonObject(with: lineData, options: []),
                          let dict = obj as? [String: Any],
                          let msgType = dict["type"] as? String else {
                        continue
                    }

                    switch msgType {
                    case "data":
                        if let b64 = dict["b64"] as? String,
                           let raw = Data(base64Encoded: b64),
                           !raw.isEmpty {
                            raw.withUnsafeBytes { rawBuf in
                                if let ptr = rawBuf.bindMemory(to: UInt8.self).baseAddress {
                                    _ = writeAllFd(masterFd, bytes: ptr, count: raw.count)
                                }
                            }
                        } else if let text = dict["data"] as? String,
                                  let raw = text.data(using: .utf8),
                                  !raw.isEmpty {
                            raw.withUnsafeBytes { rawBuf in
                                if let ptr = rawBuf.bindMemory(to: UInt8.self).baseAddress {
                                    _ = writeAllFd(masterFd, bytes: ptr, count: raw.count)
                                }
                            }
                        }

                    case "resize":
                        let newCols = max(20, min(300, readInt(dict, "cols", default: cols)))
                        let newRows = max(5, min(120, readInt(dict, "rows", default: rows)))
                        var nextWs = winsize(
                            ws_row: UInt16(newRows),
                            ws_col: UInt16(newCols),
                            ws_xpixel: 0,
                            ws_ypixel: 0
                        )
                        _ = Darwin.ioctl(masterFd, DARWIN_TIOCSWINSZ, &nextWs)

                    case "close":
                        shouldTerminateChild = true

                    default:
                        break
                    }
                }
            }

            // 3) Check if child already exited without closing master yet
            if !masterClosed {
                var st: Int32 = 0
                let waited = Darwin.waitpid(pid, &st, WNOHANG)
                if waited == pid {
                    // Drain any final buffered output from masterFd
                    while true {
                        let n = Darwin.read(masterFd, &readBuf, readBuf.count)
                        if n > 0 {
                            let chunk = Data(bytes: readBuf, count: n)
                            writeStdoutLine("{\"type\":\"data\",\"b64\":\"\(chunk.base64EncodedString())\"}")
                        } else {
                            break
                        }
                    }
                    masterClosed = true
                    Darwin.close(masterFd)
                    let exitCode: Int32
                    if (st & 0x7f) == 0 {
                        exitCode = (st >> 8) & 0xff
                    } else {
                        exitCode = 128 + (st & 0x7f)
                    }
                    ptyBridgeChildPid = 0
                    writeStdoutLine("{\"type\":\"exit\",\"code\":\(exitCode)}")
                    Darwin._exit(0)
                }
            }
        }
    }

    Darwin.close(masterFd)

    var exitCode: Int32 = 0
    if shouldTerminateChild {
        terminatePtyChild(pid)
        ptyBridgeChildPid = 0
        writeStdoutLine("{\"type\":\"exit\",\"code\":0}")
        Darwin._exit(0)
    }

    var status: Int32 = 0
    var reaped = Darwin.waitpid(pid, &status, 0)
    while reaped < 0 && errno == EINTR {
        reaped = Darwin.waitpid(pid, &status, 0)
    }
    if reaped == pid {
        if (status & 0x7f) == 0 {
            exitCode = (status >> 8) & 0xff
        } else {
            exitCode = 128 + (status & 0x7f)
        }
    }
    ptyBridgeChildPid = 0
    writeStdoutLine("{\"type\":\"exit\",\"code\":\(exitCode)}")
    Darwin._exit(0)
}

// MARK: - Display & Pointer Geometry Helpers

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

private func activeDisplayRects() -> [CGRect] {
    var displayCount: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &displayCount)
    if displayCount == 0 {
        return [CGDisplayBounds(CGMainDisplayID())]
    }
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
    let err = CGGetActiveDisplayList(displayCount, &displays, &displayCount)
    if err != .success || displayCount == 0 {
        return [CGDisplayBounds(CGMainDisplayID())]
    }
    var rects: [CGRect] = []
    rects.reserveCapacity(Int(displayCount))
    for i in 0..<Int(displayCount) {
        let r = CGDisplayBounds(displays[i])
        if r.width > 0 && r.height > 0 {
            rects.append(r)
        }
    }
    return rects.isEmpty ? [CGDisplayBounds(CGMainDisplayID())] : rects
}

private func clampPointToRect(_ point: CGPoint, _ rect: CGRect) -> CGPoint {
    let maxX = max(rect.minX, rect.maxX - 1.0)
    let maxY = max(rect.minY, rect.maxY - 1.0)
    let cx = min(max(point.x, rect.minX), maxX)
    let cy = min(max(point.y, rect.minY), maxY)
    return CGPoint(x: cx, y: cy)
}

/// Clamps a point to the active display containing it, or projects onto the nearest active display
/// rectangle so multi-monitor arrangements with unequal sizes never trap the cursor in dead-space.
private func clampPointToActiveDisplays(_ point: CGPoint) -> CGPoint {
    let rects = activeDisplayRects()
    for rect in rects {
        let maxX = max(rect.minX, rect.maxX - 1.0)
        let maxY = max(rect.minY, rect.maxY - 1.0)
        if point.x >= rect.minX && point.x <= maxX && point.y >= rect.minY && point.y <= maxY {
            return point
        }
    }

    var bestPt = clampPointToRect(point, rects[0])
    var bestDistSq = (bestPt.x - point.x) * (bestPt.x - point.x) + (bestPt.y - point.y) * (bestPt.y - point.y)
    for i in 1..<rects.count {
        let cand = clampPointToRect(point, rects[i])
        let dx = cand.x - point.x
        let dy = cand.y - point.y
        let distSq = dx * dx + dy * dy
        if distSq < bestDistSq {
            bestDistSq = distSq
            bestPt = cand
        }
    }
    return bestPt
}

// MARK: - Low-Memory Cursor Classifier

private func fnv1a64(_ bytes: UnsafePointer<UInt8>, count: Int) -> UInt64 {
    var hash: UInt64 = 14695981039346656037
    let prime: UInt64 = 1099511628211
    for i in 0..<count {
        hash ^= UInt64(bytes[i])
        hash = hash &* prime
    }
    return hash
}

private struct CursorImageFingerprint: Equatable {
    let hash: UInt64
    let width: Int
    let height: Int
    let hotX: Int
    let hotY: Int
}

private func computeCursorFingerprint(_ cursor: NSCursor) -> CursorImageFingerprint? {
    return autoreleasepool {
        let image = cursor.image
        let hotX = Int(round(cursor.hotSpot.x))
        let hotY = Int(round(cursor.hotSpot.y))

        // Fast path: downsample CGImage into a tiny fixed 32x32 RGBA stack buffer (4 KB)
        // avoiding costly multi-megabyte TIFF allocations.
        var proposedRect = NSRect(origin: .zero, size: image.size)
        if let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) {
            let sampleW = 32
            let sampleH = 32
            var pixels = [UInt8](repeating: 0, count: sampleW * sampleH * 4)
            let colorSpace = CGColorSpaceCreateDeviceRGB()
            let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
            let drew: Bool = pixels.withUnsafeMutableBytes { buf in
                guard let base = buf.baseAddress,
                      let ctx = CGContext(
                        data: base,
                        width: sampleW,
                        height: sampleH,
                        bitsPerComponent: 8,
                        bytesPerRow: sampleW * 4,
                        space: colorSpace,
                        bitmapInfo: bitmapInfo
                      ) else {
                    return false
                }
                ctx.interpolationQuality = .low
                ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: sampleW, height: sampleH))
                return true
            }
            if drew {
                let h = pixels.withUnsafeBufferPointer { ptr -> UInt64 in
                    guard let base = ptr.baseAddress else { return 0 }
                    return fnv1a64(base, count: ptr.count)
                }
                return CursorImageFingerprint(
                    hash: h,
                    width: Int(round(image.size.width)),
                    height: Int(round(image.size.height)),
                    hotX: hotX,
                    hotY: hotY
                )
            }
        }

        // Fallback: hash tiffRepresentation inside autoreleasepool without retaining Data
        if let tiff = image.tiffRepresentation, !tiff.isEmpty {
            let h = tiff.withUnsafeBytes { rawBuf -> UInt64 in
                guard let base = rawBuf.bindMemory(to: UInt8.self).baseAddress else { return 0 }
                return fnv1a64(base, count: tiff.count)
            }
            return CursorImageFingerprint(
                hash: h,
                width: Int(round(image.size.width)),
                height: Int(round(image.size.height)),
                hotX: hotX,
                hotY: hotY
            )
        }
        return nil
    }
}

private final class CursorShapeClassifier {
    private struct Entry {
        let cursor: NSCursor
        let fingerprint: CursorImageFingerprint?
        let shape: String
    }

    private lazy var entries: [Entry] = {
        return autoreleasepool {
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
                    fingerprint: computeCursorFingerprint(cur),
                    shape: shape
                )
            }
        }
    }()

    func diagnostics() -> (total: Int, fingerprinted: Int, hasArrow: Bool, hasIBeam: Bool) {
        let list = entries
        let fingerprinted = list.filter { $0.fingerprint != nil }.count
        let hasArrow = list.first(where: { $0.shape == "default" })?.fingerprint != nil
        let hasIBeam = list.first(where: { $0.shape == "text" })?.fingerprint != nil
        return (list.count, fingerprinted, hasArrow, hasIBeam)
    }

    func queryCurrentShape() -> String {
        return autoreleasepool {
            guard let current = NSCursor.currentSystem else {
                return "default"
            }
            for entry in entries {
                if current == entry.cursor {
                    return entry.shape
                }
            }
            if let curFp = computeCursorFingerprint(current) {
                for entry in entries {
                    if let refFp = entry.fingerprint, curFp == refFp {
                        return entry.shape
                    }
                }
                // Secondary match on pixel hash alone in case hotspot rounds slightly differently
                for entry in entries {
                    if let refFp = entry.fingerprint, curFp.hash == refFp.hash {
                        return entry.shape
                    }
                }
            }
            return "default"
        }
    }
}

private var cursorClassifier: CursorShapeClassifier? = nil

private func initializeAppKitForDaemon() {
    autoreleasepool {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let classifier = CursorShapeClassifier()
        // Warm reference cursor entries now that NSApplication is initialized
        _ = classifier.diagnostics()
        cursorClassifier = classifier
    }
}

// MARK: - Thread-Safe InputBlocker

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

    // Fail-safe local unlock: Ctrl+Option+Esc (primary) or Option+Cmd+Esc (consumed to prevent macOS Force Quit dialog)
    if type == .keyDown {
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let flags = event.flags
        if keyCode == 53 &&
            flags.contains(.maskAlternate) &&
            (flags.contains(.maskControl) || flags.contains(.maskCommand)) {
            blocker.disableFromEmergencyUnlock()
            // Consume the unlock hotkey so Option+Cmd+Esc never leaks a Force Quit dialog
            return nil
        }
    }

    // Block all other local physical mouse/keyboard events while enabled
    return nil
}

private final class InputBlocker {
    private let lock = NSLock()
    private var desiredEnabled = false
    private var enabled = false
    private var generation: UInt64 = 0
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
        let active = enabled && desiredEnabled
        let port = machPort
        lock.unlock()
        if active, let port = port, CFMachPortIsValid(port) {
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
            desiredEnabled = false
            enabled = false
            generation &+= 1
            let port = machPort
            let rl = runLoop
            machPort = nil
            runLoop = nil
            runLoopSource = nil
            tapThread = nil
            lock.unlock()

            if let port = port {
                if CFMachPortIsValid(port) {
                    CGEvent.tapEnable(tap: port, enable: false)
                    CFMachPortInvalidate(port)
                }
            }
            if let rl = rl {
                CFRunLoopStop(rl)
            }
            return true
        }

        lock.lock()
        if enabled && desiredEnabled, let port = machPort, CFMachPortIsValid(port) {
            lock.unlock()
            return true
        }
        desiredEnabled = true
        generation &+= 1
        let myGen = generation
        let stalePort = machPort
        let staleRl = runLoop
        machPort = nil
        runLoop = nil
        runLoopSource = nil
        tapThread = nil
        enabled = false
        lock.unlock()

        if let stalePort = stalePort, CFMachPortIsValid(stalePort) {
            CGEvent.tapEnable(tap: stalePort, enable: false)
            CFMachPortInvalidate(stalePort)
        }
        if let staleRl = staleRl {
            CFRunLoopStop(staleRl)
        }

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
                self.lock.lock()
                if self.generation == myGen {
                    self.desiredEnabled = false
                    self.enabled = false
                    self.tapThread = nil
                }
                self.lock.unlock()
                readySem.signal()
                return
            }

            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            let rl = CFRunLoopGetCurrent()

            self.lock.lock()
            // Verify caller did not disable or supersede this request while tapCreate ran
            guard self.desiredEnabled && self.generation == myGen else {
                self.lock.unlock()
                if CFMachPortIsValid(tap) {
                    CGEvent.tapEnable(tap: tap, enable: false)
                    CFMachPortInvalidate(tap)
                }
                readySem.signal()
                return
            }

            if let source = source, let rl = rl {
                CFRunLoopAddSource(rl, source, .commonModes)
            }
            self.machPort = tap
            self.runLoop = rl
            self.runLoopSource = source
            self.enabled = true
            created = true
            self.lock.unlock()

            CGEvent.tapEnable(tap: tap, enable: true)
            readySem.signal()

            CFRunLoopRun()

            // Cleanup after run loop stops
            self.lock.lock()
            let stillOwned = (self.machPort === tap)
            if stillOwned {
                self.machPort = nil
                self.runLoop = nil
                self.runLoopSource = nil
                self.tapThread = nil
                if self.generation == myGen {
                    self.enabled = false
                }
            }
            self.lock.unlock()

            if let source = source, let rl = rl {
                CFRunLoopRemoveSource(rl, source, .commonModes)
            }
            if CFMachPortIsValid(tap) {
                CGEvent.tapEnable(tap: tap, enable: false)
                CFMachPortInvalidate(tap)
            }
        }

        lock.lock()
        if generation == myGen && desiredEnabled {
            tapThread = thread
            lock.unlock()
            thread.start()
        } else {
            lock.unlock()
            return false
        }

        _ = readySem.wait(timeout: .now() + 2.0)

        lock.lock()
        let result = created && enabled && generation == myGen
        lock.unlock()
        return result
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

private func readOptionalDouble(_ dict: [String: Any], _ key: String) -> Double? {
    if let n = dict[key] as? NSNumber {
        let v = n.doubleValue
        return v.isFinite ? v : nil
    }
    return nil
}

private func readDouble(_ dict: [String: Any], _ key: String, default fallback: Double = 0.0) -> Double {
    return readOptionalDouble(dict, key) ?? fallback
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
        let shape = cursorClassifier?.queryCurrentShape() ?? "default"
        writeStdoutLine("{\"ok\":true,\"cursor\":\"\(shape)\"}")

    case "block_input":
        let enabled = (dict["enabled"] as? Bool) == true
        let ok = inputBlocker.setEnabled(enabled)
        let active = inputBlocker.isEnabled
        writeStdoutLine(
            "{\"event\":\"block_input_result\",\"ok\":\(ok ? "true" : "false"),\"active\":\(active ? "true" : "false")}"
        )

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
        let proposedPt = CGPoint(x: currentLoc.x + Double(dx), y: currentLoc.y + Double(dy))
        let nextPt = clampPointToActiveDisplays(proposedPt)
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
        let pt: CGPoint
        if let x = readOptionalDouble(dict, "x"), let y = readOptionalDouble(dict, "y") {
            pt = CGPoint(x: x, y: y)
        } else {
            pt = CGEvent(source: nil)?.location ?? state.lastPoint
        }
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
        let pt: CGPoint
        if let x = readOptionalDouble(dict, "x"), let y = readOptionalDouble(dict, "y") {
            pt = CGPoint(x: x, y: y)
        } else {
            pt = CGEvent(source: nil)?.location ?? state.lastPoint
        }
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
        if let x = readOptionalDouble(dict, "x"), let y = readOptionalDouble(dict, "y") {
            let pt = CGPoint(x: x, y: y)
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

// MARK: - Entrypoint

let args = CommandLine.arguments

// MUST run before any AppKit / CoreGraphics initialization (fork safety)
if args.count >= 2 && args[1] == "--pty-bridge" {
    runPtyBridge(args: Array(args.dropFirst(2)))
}

if args.contains("--check-permissions") {
    autoreleasepool {
        let acc = AXIsProcessTrusted()
        let scr = CGPreflightScreenCaptureAccess()
        printPermissionsJson(accessibility: acc, screenCapture: scr)
    }
    exit(0)
}

if args.contains("--request-accessibility") {
    autoreleasepool {
        let promptKey = "AXTrustedCheckOptionPrompt" as CFString
        let options = [promptKey: kCFBooleanTrue!] as CFDictionary
        let acc = AXIsProcessTrustedWithOptions(options)
        let scr = CGPreflightScreenCaptureAccess()
        printPermissionsJson(accessibility: acc, screenCapture: scr)
    }
    exit(0)
}

if args.contains("--request-screen") {
    autoreleasepool {
        let scr = CGRequestScreenCaptureAccess()
        let acc = AXIsProcessTrusted()
        printPermissionsJson(accessibility: acc, screenCapture: scr)
    }
    exit(0)
}

if args.contains("--check-cursors") {
    initializeAppKitForDaemon()
    autoreleasepool {
        let diag = cursorClassifier?.diagnostics() ?? (total: 0, fingerprinted: 0, hasArrow: false, hasIBeam: false)
        writeStdoutLine(
            "{\"ok\":true,\"total\":\(diag.total),\"fingerprinted\":\(diag.fingerprinted),\"arrow\":\(diag.hasArrow ? "true" : "false"),\"iBeam\":\(diag.hasIBeam ? "true" : "false")}"
        )
    }
    exit(0)
}

setbuf(stdout, nil)
initializeAppKitForDaemon()

private var buttonState = ButtonState()
private let eventSource = makeEventSource()

while let line = readLine(strippingNewline: true) {
    autoreleasepool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return }
        guard let data = trimmed.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data, options: []),
              let dict = obj as? [String: Any] else {
            return
        }
        handleCommand(dict, state: &buttonState, source: eventSource)
    }
}

inputBlocker.setEnabled(false)
