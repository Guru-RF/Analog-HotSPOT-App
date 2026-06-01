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
