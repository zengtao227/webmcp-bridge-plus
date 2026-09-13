import AppKit
import Foundation
import ServiceManagement
import Darwin

private let statusRefreshInterval: TimeInterval = 10
private let displayRefreshInterval: TimeInterval = 1
private let defaultDurationMinutes = 60
private let minimumDurationMinutes = 1
private let maximumDurationMinutes = 60
private let standardPathEntries = [
    "/Applications/Docker.app/Contents/Resources/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
]

private func hostPath(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
    let inherited = environment["PATH"]?
        .split(separator: ":")
        .map(String.init) ?? []
    var seen = Set<String>()
    return (inherited + standardPathEntries)
        .filter { !$0.isEmpty && seen.insert($0).inserted }
        .joined(separator: ":")
}

// MARK: - Status model

private struct ElevationStatus: Decodable, Equatable {
    let mode: String
    let leaseState: String?
    let selectedRoot: String?
    let expiresAt: String?
    let remainingMs: Double?
    let maxDurationMs: Double?
    let runtimeState: String?
    let runtimeVerified: Bool?
    let normalRoot: String?
    let reason: String?
}

private enum MenuBarError: LocalizedError {
    case installerMissing
    case nodeMissing
    case commandFailed(String)
    case invalidStatus
    case invalidDuration

    var errorDescription: String? {
        switch self {
        case .installerMissing:
            return "WebMCP immutable installer not found"
        case .nodeMissing:
            return "Node.js not found in the WebMCP host PATH"
        case .commandFailed(let message):
            return message.isEmpty ? "WebMCP command failed" : message
        case .invalidStatus:
            return "WebMCP returned an invalid elevation status"
        case .invalidDuration:
            return "Duration must be between 1 and 60 minutes"
        }
    }
}

private struct CommandOutput {
    let stdout: String
    let stderr: String
}

private func decodeStatus(_ text: String) throws -> ElevationStatus {
    guard let data = text.data(using: .utf8) else {
        throw MenuBarError.invalidStatus
    }
    do {
        return try JSONDecoder().decode(ElevationStatus.self, from: data)
    } catch {
        throw MenuBarError.invalidStatus
    }
}

private func isValidDuration(_ minutes: Int) -> Bool {
    (minimumDurationMinutes...maximumDurationMinutes).contains(minutes)
}

private func abbreviateHome(_ path: String, home: String) -> String {
    if path == home { return "~" }
    let prefix = home + "/"
    if path.hasPrefix(prefix) {
        return "~/" + String(path.dropFirst(prefix.count))
    }
    return path
}

private func expiryDate(_ status: ElevationStatus) -> Date? {
    guard let value = status.expiresAt else { return nil }

    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) {
        return date
    }

    let wholeSeconds = ISO8601DateFormatter()
    wholeSeconds.formatOptions = [.withInternetDateTime]
    return wholeSeconds.date(from: value)
}

private func remainingText(_ status: ElevationStatus, now: Date = Date(), compact: Bool = false) -> String? {
    guard status.mode == "elevated", let expiry = expiryDate(status) else { return nil }
    let seconds = max(0, Int(ceil(expiry.timeIntervalSince(now))))
    if compact {
        if seconds < 60 { return "\(seconds)s" }
        return "\(Int(ceil(Double(seconds) / 60.0)))m"
    }
    if seconds >= 60 {
        return "\(seconds / 60)m \(String(format: "%02d", seconds % 60))s"
    }
    return "\(seconds)s"
}

// MARK: - Immutable installer client

private final class InstallerClient {
    let home: String

    private let installerURL: URL
    private let nodeURL: URL

    init() throws {
        let fileManager = FileManager.default
        let homeURL = fileManager.homeDirectoryForCurrentUser
        home = homeURL.path
        installerURL = homeURL
            .appendingPathComponent(".local/share/webmcp/host-runtime/current/native/deploy/installer.js")

        guard fileManager.isReadableFile(atPath: installerURL.path) else {
            throw MenuBarError.installerMissing
        }
        guard let node = Self.findNodeExecutable() else {
            throw MenuBarError.nodeMissing
        }
        nodeURL = node
    }

    func status() throws -> ElevationStatus {
        let output = try run(["elevate-status"])
        return try decodeStatus(output.stdout.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    func elevate(root: String, durationMinutes: Int) throws {
        guard !root.isEmpty, isValidDuration(durationMinutes) else {
            throw MenuBarError.invalidDuration
        }
        _ = try run([
            "elevate",
            "--root", root,
            "--duration", "\(durationMinutes)m"
        ])
    }

    func stop() throws {
        _ = try run(["elevate-stop"])
    }

    private func run(_ arguments: [String]) throws -> CommandOutput {
        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()

        process.executableURL = nodeURL
        process.arguments = [installerURL.path] + arguments
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        var environment = ProcessInfo.processInfo.environment
        environment["HOME"] = home
        environment["PATH"] = hostPath(environment: environment)
        process.environment = environment

        do {
            try process.run()
        } catch {
            throw MenuBarError.commandFailed("Could not start WebMCP control command")
        }

        process.waitUntilExit()

        let stdout = String(data: stdoutPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""

        guard process.terminationStatus == 0 else {
            let raw = stderr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                : stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            let bounded = String(raw.suffix(800))
            throw MenuBarError.commandFailed(bounded)
        }

        return CommandOutput(stdout: stdout, stderr: stderr)
    }

    private static func findNodeExecutable() -> URL? {
        let fileManager = FileManager.default
        let directories = hostPath()
            .split(separator: ":")
            .map(String.init)

        var seen = Set<String>()
        for directory in directories where seen.insert(directory).inserted {
            let candidate = URL(fileURLWithPath: directory).appendingPathComponent("node")
            if fileManager.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }
}

// MARK: - Menu bar app

private final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()

    private let titleItem = NSMenuItem(title: "WebMCP", action: nil, keyEquivalent: "")
    private let stateItem = NSMenuItem(title: "Status: Checking…", action: nil, keyEquivalent: "")
    private let scopeItem = NSMenuItem(title: "Scope: --", action: nil, keyEquivalent: "")
    private let failureItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")

    private lazy var grantFullItem = makeActionItem(
        title: "Grant Full Working Access",
        selector: #selector(grantFullWorkingAccess)
    )
    private lazy var chooseFolderItem = makeActionItem(
        title: "Choose Folder…",
        selector: #selector(chooseFolder)
    )
    private let durationItem = NSMenuItem(title: "Duration", action: nil, keyEquivalent: "")
    private lazy var duration30Item = makeActionItem(
        title: "30 minutes",
        selector: #selector(selectThirtyMinutes)
    )
    private lazy var duration60Item = makeActionItem(
        title: "1 hour",
        selector: #selector(selectOneHour)
    )
    private lazy var customDurationItem = makeActionItem(
        title: "Custom…",
        selector: #selector(selectCustomDuration)
    )
    private lazy var stopItem = makeActionItem(
        title: "Stop Elevated Access",
        selector: #selector(stopElevatedAccess)
    )
    private lazy var refreshItem = makeActionItem(
        title: "Refresh Status",
        selector: #selector(refreshFromMenu),
        keyEquivalent: "r"
    )
    private lazy var launchAtLoginItem = makeActionItem(
        title: "Launch at Login",
        selector: #selector(toggleLaunchAtLogin)
    )
    private lazy var loginSettingsItem = makeActionItem(
        title: "Open Login Items Settings…",
        selector: #selector(openLoginItemsSettings)
    )
    private let loginNoticeItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private lazy var quitItem = makeActionItem(
        title: "Quit WebMCP Menu",
        selector: #selector(quit),
        keyEquivalent: "q"
    )

    private var client: InstallerClient?
    private var currentStatus: ElevationStatus?
    private var selectedDurationMinutes = defaultDurationMinutes
    private var customDurationMinutes: Int?
    private var statusRefreshInFlight = false
    private var commandInFlight = false
    private var operationText: String?
    private var lastError: String?
    private var statusTimer: Timer?
    private var displayTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        configureStatusItem()
        configureMenu()
        updateLaunchAtLoginMenu()

        do {
            client = try InstallerClient()
        } catch {
            lastError = error.localizedDescription
        }

        statusTimer = Timer.scheduledTimer(withTimeInterval: statusRefreshInterval, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
        displayTimer = Timer.scheduledTimer(withTimeInterval: displayRefreshInterval, repeats: true) { [weak self] _ in
            self?.tickDisplay()
        }

        refreshStatus()
        updateDisplay()
    }

    func applicationWillTerminate(_ notification: Notification) {
        statusTimer?.invalidate()
        displayTimer?.invalidate()
    }

    func menuWillOpen(_ menu: NSMenu) {
        updateLaunchAtLoginMenu()
        refreshStatus()
        updateDisplay()
    }

    private func configureStatusItem() {
        guard let button = statusItem.button else { return }
        button.title = "WebMCP"
        button.toolTip = "WebMCP temporary access"
        button.font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        statusItem.menu = menu
    }

    private func configureMenu() {
        menu.delegate = self
        menu.autoenablesItems = false

        [titleItem, stateItem, scopeItem, failureItem].forEach { $0.isEnabled = false }
        failureItem.isHidden = true

        let durationMenu = NSMenu(title: "Duration")
        durationMenu.autoenablesItems = false
        durationMenu.addItem(duration30Item)
        durationMenu.addItem(duration60Item)
        durationMenu.addItem(customDurationItem)
        durationItem.submenu = durationMenu

        menu.addItem(titleItem)
        menu.addItem(stateItem)
        menu.addItem(scopeItem)
        menu.addItem(failureItem)
        menu.addItem(.separator())
        menu.addItem(grantFullItem)
        menu.addItem(chooseFolderItem)
        menu.addItem(durationItem)
        menu.addItem(.separator())
        menu.addItem(stopItem)
        menu.addItem(.separator())
        menu.addItem(refreshItem)
        menu.addItem(.separator())
        menu.addItem(launchAtLoginItem)
        menu.addItem(loginSettingsItem)
        menu.addItem(loginNoticeItem)
        menu.addItem(.separator())
        menu.addItem(quitItem)

        loginSettingsItem.isHidden = true
        loginNoticeItem.isEnabled = false
        loginNoticeItem.isHidden = true

        updateDurationMenu()
        updateDisplay()
    }

    private func makeActionItem(title: String, selector: Selector, keyEquivalent: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: keyEquivalent)
        item.target = self
        item.isEnabled = true
        return item
    }

    @objc private func grantFullWorkingAccess() {
        guard let client else { return }
        beginElevation(root: client.home)
    }

    @objc private func chooseFolder() {
        guard !commandInFlight else { return }

        let panel = NSOpenPanel()
        panel.title = "Choose WebMCP Access Folder"
        panel.prompt = "Grant Access"
        panel.message = "WebMCP will receive temporary writable access to this folder for the selected duration."
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.resolvesAliases = true

        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let root = panel.url?.path else { return }
        beginElevation(root: root)
    }

    @objc private func selectThirtyMinutes() {
        selectedDurationMinutes = 30
        customDurationMinutes = nil
        updateDurationMenu()
    }

    @objc private func selectOneHour() {
        selectedDurationMinutes = 60
        customDurationMinutes = nil
        updateDurationMenu()
    }

    @objc private func selectCustomDuration() {
        let alert = NSAlert()
        alert.messageText = "Custom elevated-access duration"
        alert.informativeText = "Enter a duration from 1 to 60 minutes."
        alert.addButton(withTitle: "Use Duration")
        alert.addButton(withTitle: "Cancel")

        let input = NSTextField(string: "\(selectedDurationMinutes)")
        input.frame = NSRect(x: 0, y: 0, width: 220, height: 24)
        input.placeholderString = "Minutes (1–60)"
        alert.accessoryView = input

        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        guard let value = Int(input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)),
              isValidDuration(value) else {
            showLocalError(MenuBarError.invalidDuration.localizedDescription)
            return
        }

        selectedDurationMinutes = value
        customDurationMinutes = value
        updateDurationMenu()
    }

    @objc private func stopElevatedAccess() {
        guard !commandInFlight, let client else { return }
        commandInFlight = true
        operationText = "Revoking elevated access…"
        lastError = nil
        updateDisplay()

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                try client.stop()
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.commandInFlight = false
                    self.operationText = nil
                    self.refreshStatus()
                }
            } catch {
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.commandInFlight = false
                    self.operationText = nil
                    self.showLocalError(error.localizedDescription)
                }
            }
        }
    }

    @objc private func refreshFromMenu() {
        refreshStatus()
    }

    @objc private func toggleLaunchAtLogin() {
        let service = SMAppService.mainApp

        do {
            switch service.status {
            case .enabled, .requiresApproval:
                try service.unregister()
            case .notRegistered, .notFound:
                try service.register()
            @unknown default:
                break
            }
            loginNoticeItem.isHidden = true
        } catch {
            loginNoticeItem.title = "⚠︎ Launch at Login: \(error.localizedDescription)"
            loginNoticeItem.isHidden = false
        }

        updateLaunchAtLoginMenu(preserveError: true)
    }

    @objc private func openLoginItemsSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func beginElevation(root: String) {
        guard !commandInFlight, let client else { return }

        commandInFlight = true
        operationText = "Requesting elevated access…"
        lastError = nil
        updateDisplay()
        NSApp.activate(ignoringOtherApps: true)

        let duration = selectedDurationMinutes
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                try client.elevate(root: root, durationMinutes: duration)
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.commandInFlight = false
                    self.operationText = nil
                    self.refreshStatus()
                }
            } catch {
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.commandInFlight = false
                    self.operationText = nil
                    self.showLocalError(error.localizedDescription)
                }
            }
        }
    }

    private func refreshStatus() {
        guard !statusRefreshInFlight, !commandInFlight, let client else {
            updateDisplay()
            return
        }

        statusRefreshInFlight = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            do {
                let status = try client.status()
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.statusRefreshInFlight = false
                    self.currentStatus = status
                    self.lastError = nil
                    self.updateDisplay()
                }
            } catch {
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.statusRefreshInFlight = false
                    self.lastError = error.localizedDescription
                    self.updateDisplay()
                }
            }
        }
    }

    private func tickDisplay() {
        if let status = currentStatus,
           status.mode == "elevated",
           let expiry = expiryDate(status),
           expiry <= Date() {
            refreshStatus()
        }
        updateDisplay()
    }

    private func updateDisplay() {
        let mode = currentStatus?.mode
        let elevated = mode == "elevated"
        let healthyNormal = mode == "normal"
            && currentStatus?.runtimeVerified == true
            && currentStatus?.runtimeState == "running"

        if let operationText {
            statusItem.button?.title = "WebMCP …"
            stateItem.title = operationText
        } else if let status = currentStatus, elevated {
            let remaining = remainingText(status, compact: true) ?? "--"
            statusItem.button?.title = "WebMCP · \(remaining)"
            stateItem.title = "Elevated · \(remainingText(status) ?? "--") remaining"
        } else if healthyNormal {
            statusItem.button?.title = "WebMCP"
            stateItem.title = "Status: Normal"
        } else if mode == "normal" {
            statusItem.button?.title = "WebMCP ⚠︎"
            stateItem.title = "Status: Normal state not fully verified"
        } else {
            statusItem.button?.title = lastError == nil ? "WebMCP …" : "WebMCP ⚠︎"
            stateItem.title = "Status: Checking…"
        }

        if let status = currentStatus, elevated, let root = status.selectedRoot, let client {
            scopeItem.title = "Scope: \(abbreviateHome(root, home: client.home))"
        } else if let root = currentStatus?.normalRoot, let client {
            scopeItem.title = "Normal root: \(abbreviateHome(root, home: client.home))"
        } else {
            scopeItem.title = "Scope: --"
        }

        if let lastError, !lastError.isEmpty {
            failureItem.title = "⚠︎ \(lastError)"
            failureItem.isHidden = false
        } else {
            failureItem.isHidden = true
        }

        let canGrant = !commandInFlight && healthyNormal
        grantFullItem.isEnabled = canGrant
        chooseFolderItem.isEnabled = canGrant
        durationItem.isEnabled = canGrant
        stopItem.isEnabled = !commandInFlight && elevated
        refreshItem.isEnabled = !commandInFlight && client != nil

        updateDurationMenu()
    }

    private func updateLaunchAtLoginMenu(preserveError: Bool = false) {
        let status = SMAppService.mainApp.status

        launchAtLoginItem.title = "Launch at Login"
        launchAtLoginItem.isEnabled = true
        loginSettingsItem.isHidden = true
        if !preserveError {
            loginNoticeItem.isHidden = true
        }

        switch status {
        case .enabled:
            launchAtLoginItem.state = .on
        case .notRegistered:
            launchAtLoginItem.state = .off
        case .requiresApproval:
            launchAtLoginItem.state = .mixed
            loginSettingsItem.isHidden = false
            if !preserveError || loginNoticeItem.isHidden {
                loginNoticeItem.title = "Login launch needs approval in System Settings"
                loginNoticeItem.isHidden = false
            }
        case .notFound:
            launchAtLoginItem.state = .off
        @unknown default:
            launchAtLoginItem.state = .off
            launchAtLoginItem.isEnabled = false
            if !preserveError || loginNoticeItem.isHidden {
                loginNoticeItem.title = "Launch at Login status is unavailable"
                loginNoticeItem.isHidden = false
            }
        }
    }

    private func updateDurationMenu() {
        duration30Item.state = selectedDurationMinutes == 30 && customDurationMinutes == nil ? .on : .off
        duration60Item.state = selectedDurationMinutes == 60 && customDurationMinutes == nil ? .on : .off
        customDurationItem.state = customDurationMinutes != nil ? .on : .off
        if let customDurationMinutes {
            customDurationItem.title = "Custom… (\(customDurationMinutes) min)"
        } else {
            customDurationItem.title = "Custom…"
        }
        let durationLabel = selectedDurationMinutes == 60 ? "1 hour" : "\(selectedDurationMinutes) min"
        durationItem.title = "Duration: \(durationLabel)"
    }

    private func showLocalError(_ message: String) {
        lastError = message
        updateDisplay()

        let alert = NSAlert()
        alert.messageText = "WebMCP Menu"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}

// MARK: - Self-tests

private enum SelfTestFailure: Error, CustomStringConvertible {
    case failed(String)

    var description: String {
        switch self {
        case .failed(let message): return message
        }
    }
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() {
        throw SelfTestFailure.failed(message)
    }
}

private func runSelfTests() -> Int32 {
    do {
        let normal = try decodeStatus(#"{"mode":"normal","leaseState":"absent","runtimeState":"running","runtimeVerified":true,"normalRoot":"/Users/alice/Code"}"#)
        try require(normal.mode == "normal", "normal status must decode")
        try require(normal.runtimeVerified == true, "normal status must preserve runtime verification")

        let elevated = try decodeStatus(#"{"mode":"elevated","selectedRoot":"/Users/alice","expiresAt":"2026-09-13T10:00:00.000Z","remainingMs":1800000,"maxDurationMs":3600000,"runtimeState":"running","runtimeVerified":true,"normalRoot":"/Users/alice/Code"}"#)
        try require(elevated.selectedRoot == "/Users/alice", "elevated root must decode")
        try require(expiryDate(elevated) != nil, "fractional-second elevated expiry must decode")

        let elevatedWholeSeconds = try decodeStatus(#"{"mode":"elevated","selectedRoot":"/Users/alice","expiresAt":"2026-09-13T10:00:00Z","remainingMs":1800000,"maxDurationMs":3600000,"runtimeState":"running","runtimeVerified":true,"normalRoot":"/Users/alice/Code"}"#)
        try require(expiryDate(elevatedWholeSeconds) != nil, "whole-second elevated expiry must decode")

        try require(isValidDuration(1), "1 minute must be accepted")
        try require(isValidDuration(30), "30 minutes must be accepted")
        try require(isValidDuration(60), "1 hour must be accepted")
        try require(!isValidDuration(0), "zero duration must be rejected")
        try require(!isValidDuration(61), "duration above one hour must be rejected")

        try require(abbreviateHome("/Users/alice", home: "/Users/alice") == "~", "home scope must display as ~")
        try require(abbreviateHome("/Users/alice/Documents", home: "/Users/alice") == "~/Documents", "home child scope must abbreviate")

        print("PASS: WebMCP Menu self-tests")
        return 0
    } catch {
        fputs("FAIL: \(error)\n", stderr)
        return 1
    }
}

if CommandLine.arguments.contains("--self-test") {
    Darwin.exit(runSelfTests())
}

let app = NSApplication.shared
private let delegate = AppDelegate()
app.delegate = delegate
app.run()
