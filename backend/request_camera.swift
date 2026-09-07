import AVFoundation
import Foundation

// Request camera access — this triggers the macOS permission dialog for Terminal.
AVCaptureDevice.requestAccess(for: .video) { granted in
    if granted {
        print("✅ Camera access GRANTED. You can now run the server.")
    } else {
        print("❌ Camera access DENIED. Please enable it in System Settings > Privacy & Security > Camera.")
    }
    exit(0)
}

// Keep the script alive while waiting for the user to respond to the dialog.
RunLoop.main.run(until: Date(timeIntervalSinceNow: 30))
