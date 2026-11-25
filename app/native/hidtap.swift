// hidtap: print every key-like HID input value as one JSON line on stdout (key capture proof of concept).
// Listens passively (no seize): keys still reach macOS, so volume keys still change the volume.
// Needs Input Monitoring (kTCCServiceListenEvent); in a dev run macOS attributes that to Electron.
// Exits when stdin closes, so it dies with the app.
//
// Lines: {"t":"access","status":"granted|denied|unknown"}
//        {"t":"open","result":<IOReturn>,"devices":[names]}
//        {"t":"hid","page":7,"usage":104,"value":1,"device":"..."}
import Foundation
import IOKit.hid

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) else { return }
  print(s)
}

func product(_ device: IOHIDDevice) -> String {
  (IOHIDDeviceGetProperty(device, kIOHIDProductKey as CFString) as? String) ?? "unknown"
}

let names: [IOHIDAccessType: String] = [kIOHIDAccessTypeGranted: "granted", kIOHIDAccessTypeDenied: "denied", kIOHIDAccessTypeUnknown: "unknown"]
if IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) != kIOHIDAccessTypeGranted {
  _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent) // system prompt, shown once; later calls are no-ops
}
emit(["t": "access", "status": names[IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)] ?? "unknown"])

var lastValue: [String: Int] = [:]
let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
// keyboards, consumer control (media/volume/brightness), system control (power/sleep)
let matching: [[String: Int]] = [
  [kIOHIDDeviceUsagePageKey: kHIDPage_GenericDesktop, kIOHIDDeviceUsageKey: kHIDUsage_GD_Keyboard],
  [kIOHIDDeviceUsagePageKey: kHIDPage_Consumer, kIOHIDDeviceUsageKey: kHIDUsage_Csmr_ConsumerControl],
  [kIOHIDDeviceUsagePageKey: kHIDPage_GenericDesktop, kIOHIDDeviceUsageKey: kHIDUsage_GD_SystemControl],
]
IOHIDManagerSetDeviceMatchingMultiple(manager, matching as CFArray)

IOHIDManagerRegisterInputValueCallback(manager, { _, _, _, value in
  let el = IOHIDValueGetElement(value)
  let page = Int(IOHIDElementGetUsagePage(el))
  let usage = Int(IOHIDElementGetUsage(el))
  let v = IOHIDValueGetIntegerValue(value)
  // keyboard page: skip the reserved/error-rollover usages 0-3 and array slots outside the key range
  if page == kHIDPage_KeyboardOrKeypad && (usage < 4 || usage > 0xE7) { return }
  if usage == 0 || usage == 0xFFFF_FFFF { return }
  // generic desktop on a keyboard device is mostly pointer noise; keep only System Control (0x80-0x9F)
  if page == kHIDPage_GenericDesktop && !(0x80...0x9F).contains(usage) { return }
  // Karabiner's virtual keyboard delivers each value twice, back to back (VirtualHIDKeyboard 1.8.0,
  // 2026-11-24). Raw HID has no auto-repeat, so a key can't go down (or up) twice in a row: drop a value
  // equal to the last one seen for the same device and usage.
  let device = IOHIDElementGetDevice(el)
  let key = "\(Unmanaged.passUnretained(device).toOpaque()) \(page) \(usage)"
  if lastValue[key] == v { return }
  lastValue[key] = v
  emit(["t": "hid", "page": page, "usage": usage, "value": v, "device": product(device), "cookie": Int(IOHIDElementGetCookie(el))])
}, nil)

IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
let result = IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
let devices = (IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice>) ?? []
emit(["t": "open", "result": Int(result), "devices": Array(Set(devices.map(product))).sorted()])

Thread {
  while readLine() != nil {}
  exit(0)
}.start()
CFRunLoopRun()
