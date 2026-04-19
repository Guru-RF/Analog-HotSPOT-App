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
| macOS (Apple Silicon + Intel) | `.dmg` — signed & notarized |
| Windows | `.exe` (NSIS installer, x64) |
| Linux | `.AppImage` (x64 + arm64) |
