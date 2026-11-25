// DitCopy native shell: a window around the existing browser UI, with a Dock icon and
// notifications when a copy finishes. The copy work stays in the engine and server,
// so closing this window never stops a running job.
import Cocoa
import UserNotifications
import WebKit

let port = ProcessInfo.processInfo.environment["DITCOPY_PORT"] ?? "34826"
let baseURL = URL(string: "http://127.0.0.1:\(port)")!

// A downloaded app carries a complete copy of DitCopy (its own Node and engine) inside Contents/Resources/ditcopy.
func packagedRoot() -> URL? {
    guard let r = Bundle.main.resourceURL?.appendingPathComponent("ditcopy"),
          FileManager.default.fileExists(atPath: r.appendingPathComponent("bundle.json").path) else { return nil }
    return r
}

func rootFolder() -> URL {
    if let p = ProcessInfo.processInfo.environment["DITCOPY_ROOT"] { return URL(fileURLWithPath: p) }
    if let r = packagedRoot() { return r }
    if let p = Bundle.main.object(forInfoDictionaryKey: "DitCopyRoot") as? String { return URL(fileURLWithPath: p) }
    return Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
}

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var running = Set<String>()
    var timer: Timer?

    func applicationDidFinishLaunching(_ n: Notification) {
        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: .zero, configuration: cfg)
        web.uiDelegate = self
        web.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "DitCopy"
        window.contentView = web
        window.setFrameAutosaveName("DitCopyMain")
        if !window.setFrameUsingName("DitCopyMain") { window.center() }
        window.delegate = self
        window.makeKeyAndOrderFront(nil)
        setupMenu()
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        startServer { ok in
            DispatchQueue.main.async {
                if ok { self.web.load(URLRequest(url: baseURL)) } else { self.showStartFailure() }
            }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { _ in self.pollJobs() }
    }

    // Quitting leaves the server and engine running, so a copy carries on. Say so before the window goes.
    func applicationShouldTerminate(_ s: NSApplication) -> NSApplication.TerminateReply {
        let n = runningJobCount()
        if n == 0 {
            // A downloaded app starts its own server, so it also stops it when nothing is copying. A source build leaves it running.
            stopServerOnQuit = packagedRoot() != nil
            return .terminateNow
        }
        let a = NSAlert()
        a.messageText = n == 1 ? "A copy is still running" : "\(n) copies are still running"
        a.informativeText = "It keeps going in the background after you quit. Open DitCopy again to watch it, or to stop it with Stop after file or Cancel now."
        a.addButton(withTitle: "Keep Open")
        a.addButton(withTitle: "Quit Anyway")
        return a.runModal() == .alertSecondButtonReturn ? .terminateNow : .terminateCancel
    }

    var stopServerOnQuit = false
    func applicationWillTerminate(_ n: Notification) {
        guard stopServerOnQuit else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [rootFolder().appendingPathComponent("stop.command").path]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
        p.waitUntilExit()
    }

    func runningJobCount() -> Int {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/jobs"))
        req.timeoutInterval = 2
        var count = 0
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, _, _ in
            if let data = data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let jobs = obj["jobs"] as? [[String: Any]] {
                count = jobs.filter { ["running", "queued", "pausing", "stopping"].contains($0["status"] as? String ?? "") }.count
            }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 3)
        return count
    }

    // Show banners while the app is in front, and bring the window forward when one is clicked.
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler h: @escaping (UNNotificationPresentationOptions) -> Void) {
        h([.banner, .sound])
    }
    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler h: @escaping () -> Void) {
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            self.window.makeKeyAndOrderFront(nil)
            NSApp.dockTile.badgeLabel = nil
        }
        h()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows f: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil); return true
    }

    func setupMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "About DitCopy", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide DitCopy", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit DitCopy", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View"); viewItem.submenu = view
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r").target = self
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit"); editItem.submenu = edit
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        NSApp.mainMenu = main
    }

    @objc func reload() { web.reload() }

    // The server and engine outlive this window, so jobs keep running when it closes.
    func startServer(_ done: @escaping (Bool) -> Void) {
        DispatchQueue.global().async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = [rootFolder().appendingPathComponent("start.command").path]
            p.environment = ProcessInfo.processInfo.environment.merging(["OPEN_BROWSER": "0"]) { _, n in n }
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            do { try p.run(); p.waitUntilExit(); done(p.terminationStatus == 0) } catch { done(false) }
        }
    }

    func showStartFailure() {
        let a = NSAlert()
        a.messageText = "The DitCopy server did not start"
        a.informativeText = packagedRoot() != nil
            ? "Look at logs/server.log in the DitCopy folder inside ~/Library/Application Support."
            : "Look at logs/server.log in \(rootFolder().path). Node.js is required."
        a.runModal()
        NSApp.terminate(nil)
    }

    func pollJobs() {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/jobs"))
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let jobs = obj["jobs"] as? [[String: Any]] else { return }
            DispatchQueue.main.async {
                var now = Set<String>()
                for j in jobs {
                    guard let id = j["id"] as? String, let st = j["status"] as? String else { continue }
                    if st == "running" || st == "stopping" { now.insert(id); continue }
                    if self.running.contains(id) { self.notify(j, st) }
                }
                self.running = now
            }
        }.resume()
    }

    func notify(_ job: [String: Any], _ status: String) {
        let sum = job["summary"] as? [String: Any]
        let errors = (sum?["errors"] as? Int) ?? 0
        let files = (sum?["copied_files"] as? Int) ?? 0
        let c = UNMutableNotificationContent()
        let name = (job["jobName"] as? String) ?? (job["id"] as? String) ?? "Job"
        c.title = errors > 0 || status == "error" ? "DitCopy needs attention" : "DitCopy finished"
        c.body = "\(name): \(status), \(files) files copied, \(errors) errors"
        c.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
        NSApp.dockTile.badgeLabel = errors > 0 ? "!" : nil
    }

    // The UI uses alert and confirm; without these WebKit silently answers no.
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = m; a.runModal(); done()
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        done(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping ([URL]?) -> Void) {
        let o = NSOpenPanel(); o.allowsMultipleSelection = p.allowsMultipleSelection
        o.canChooseDirectories = p.allowsDirectories
        done(o.runModal() == .OK ? o.urls : nil)
    }
    // Links that open a new window (reports) go to the default browser.
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { NSWorkspace.shared.open(u) }
        return nil
    }
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler h: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = a.request.url, u.host != "127.0.0.1", u.scheme?.hasPrefix("http") == true {
            NSWorkspace.shared.open(u); h(.cancel)
        } else { h(.allow) }
    }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { w.load(URLRequest(url: baseURL)) }
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
