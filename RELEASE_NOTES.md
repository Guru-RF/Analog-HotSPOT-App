# HotSpot

A minimal desktop companion for the Analog HotSpot SVXLink box.

## Highlights

- BLE GATT client for the hotspot's Feed / DTMF / Command / Status characteristics
- Live panel: callsign, frequency, talkgroup, IP, TX/RX flags, active talker
- Persistent **last talkers** history (callsign, TG, duration, time-ago)
- Configurable talkgroup quick-dial bar — one-tap `91<tg>#` DTMF
- DTMF bar with quick buttons (TG, Status, IP, Parrot)
- Device commands (SVXLink start / stop / restart, 4G on / off, reboot, poweroff)
- Silent auto-reconnect to the last-paired HotSpot on startup
- macOS menu-bar ticker shows the current talker
- Dark / light theme, always-on-top, custom frameless fixed-size window

## Downloads

| Platform | Format |
| --- | --- |
| macOS Apple Silicon | `HotSpot-<ver>-AppleSilicon.dmg` — signed & notarized |
| macOS Intel | `HotSpot-<ver>-Intel.dmg` — signed & notarized |
| Windows | `.exe` (NSIS installer, x64) |
| Linux | `.AppImage` (x64 + arm64) |

## What's new in 1.0.8

- **Multi-hotspot picker** (mirrors the Flutter mobile app's `hotspot_picker_sheet`). When more than one HotSpot is in range — or your saved one isn't visible — a modal picker shows the list, sorted with the saved hotspot floated to the top under a green "Last used" chip. Tap to connect, **Rescan** to retry, **Forget** to clear the saved hotspot.
- **Identity is now the BLE remote-id**, not the advertised name. A hotspot that gets renamed (firmware reflash, hostname change) is still auto-connected to on the next launch because the platform-stable id stays the same.
- **3-second resolution window** before deciding between auto-connect and picker: exactly one HotSpot in range that matches the saved id (or no saved id) → silent auto-connect; everything else → picker.
- **No more "stuck on Scanning…"** if you double-click the connect button or trigger a scan from two places at once — the renderer now guards re-entrancy and the main process releases orphaned chooser callbacks.
- The picker stays open after a failed connect so you can try a different candidate without restarting the scan. After 30 s with no devices visible, the empty state flips to "No HotSpots found in range — click Rescan."

## What's new in 1.0.7

- **Update notifier.** The app polls GitHub's `releases/latest` for `Guru-RF/Analog-HotSPOT-App` at startup and once a day after. When a newer tag appears, a red `vX.Y.Z available` pill shows in the title bar — click it to open <https://svxlink-hotspot.app>.
- **Windows ARM64 build** alongside the existing x64 installer (`HotSpot-Setup-x64.exe` and `HotSpot-Setup-arm64.exe`).

## What's new in 1.0.6

- **Feature parity with the mobile app.** Tab navigation (Home / Map / Info / Reflector), full reflector WSS feed with `snapshot` / `node_upsert` / `talk_start` / `talk_stop` handling, OpenStreetMap-based Map tab via vendored Leaflet, Info tab with monitored TGs and CTCSS mappings, live reflector talker list.
- **Map auto-zooms to active talkers** after 1.5 s of continuous transmission (matches SVXConnect-iOS behaviour). Returns to your home view when the air drops.
- **Map node popups gained NODE / REPEATER / AI / OFFLINE / TALKING badges** with the SVXConnect-iOS colour palette.
- **Settings moved to its own window** (the modal didn't fit anymore). Top-level on macOS so it can't get lost behind a Space. Position/size persisted between launches.
- **Address-based home QTH lookup** in Settings — type Street + Nr / ZIP + City / Country, hit Lookup, and OpenStreetMap Nominatim fills in the coordinates.
- **BLE picker fix** — if your hotspot is renamed (or you connect to a different unit at a club site), the picker now falls back to the first visible HotSpot-service device after 3 s instead of cancelling.
- macOS code-signing identity moved to the new **Dielectricum** Developer team.

## What's new in 1.0.5

- **Fix crash on macOS 26 (Tahoe).** Upgraded Electron 33 → 42, which contains the V8 thread-isolation fix for Apple Silicon's TPRO memory-protection changes. Previous builds (≤ 1.0.4) crashed on launch with `EXC_BREAKPOINT` inside `v8::internal::ThreadIsolation::WriteProtectMemory` on macOS 26+.

## What's new in 1.0.4

- macOS DMGs are now named `HotSpot-<ver>-AppleSilicon.dmg` / `HotSpot-<ver>-Intel.dmg` so it's clear which one to download.
