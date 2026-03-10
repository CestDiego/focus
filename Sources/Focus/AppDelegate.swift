import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var iconTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Store.shared.migrate()
        Store.shared.seedIfEmpty()
        ModeEngine.shared.start()

        // --- menu bar: use text label so it's always visible ---
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.action = #selector(togglePopover)
            button.target = self
        }
        updateIcon()

        // --- popover ---
        popover = NSPopover()
        popover.contentSize = NSSize(width: 340, height: 520)
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(rootView: ContentView())

        // refresh icon every 5s
        iconTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.updateIcon()
        }
    }

    // MARK: - Icon (text-based so it's clearly visible)

    func updateIcon() {
        let mode = Store.shared.currentMode()?.mode ?? "unfocused"
        let activeSessions = Store.shared.activeSessions()
        let activeCount = activeSessions.count

        let dot: String
        switch mode {
        case "focused":   dot = "🟢"
        case "grounding": dot = "🟡"
        default:          dot = "⭘"
        }

        let label: String
        if activeCount > 1 {
            label = "\(dot) \(activeCount)"
        } else if activeCount == 1 {
            label = "\(dot)"
        } else {
            label = "◌ focus"
        }
        let title = NSAttributedString(
            string: label,
            attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .medium)
            ]
        )
        statusItem.button?.attributedTitle = title
        statusItem.button?.image = nil
    }

    // MARK: - Popover

    @objc private func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
        }
    }
}
