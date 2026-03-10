import Foundation
import IOKit

final class IdleDetector {
    static let shared = IdleDetector()

    /// Returns the system idle time (seconds since last HID input event).
    /// Returns 0 if the IOKit service is unavailable (assumes user is active).
    func systemIdleTime() -> TimeInterval {
        let service = IOServiceGetMatchingService(
            kIOMainPortDefault,
            IOServiceMatching(kIOHIDSystemClass)
        )
        guard service != IO_OBJECT_NULL else { return 0 }
        defer { IOObjectRelease(service) }

        let key = "HIDIdleTime" as CFString
        guard let prop = IORegistryEntryCreateCFProperty(
            service, key, kCFAllocatorDefault, 0
        )?.takeRetainedValue() as? NSNumber else {
            return 0
        }
        return prop.doubleValue / 1_000_000_000
    }
}
