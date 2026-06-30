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

## What's new in 1.0.15

- **macOS Bluetooth picker fix.** On macOS, Chromium's `select-bluetooth-device` event only fires once a peripheral matches the service-UUID filter. With zero HotSpots in range — common during a first attempt while the OS Bluetooth permission prompt is still pending — the event never fired, the picker never opened, and the user was stuck on "Scanning…" with no Cancel button. The renderer now drives the picker independently of main.js: it opens after 3.5 s with a "Looking for HotSpots…" state and flips to "No HotSpots found in range" with a Rescan button at 30 s. On macOS the empty state also points the user at **System Settings → Privacy & Security → Bluetooth** so the permission gate is easy to spot.
- **Cancel in the picker now always frees the Connect button.** Previously a stuck-pending `requestDevice()` (e.g. the same macOS no-event case) could keep `ble.scanning=true` indefinitely; the next Connect click then silently no-op'd. The picker's cancel path now drops the guard immediately. A late `requestDevice()` resolve is still discarded silently by the generation-counter check.
- **Multi-hotspot picker semantics unchanged.** When 2+ HotSpots are in range the picker shows the list with the saved one floated to the top under a "Last used" chip, exactly as the mobile sheet does. The auto-connect-if-single-saved-match silent path still applies, just with a deterministic Rescan fallback when discovery fails.
- **Update notifier disabled on Windows and macOS.** The daily GitHub poll only runs on Linux now. Store-distributed builds (Microsoft Store on Windows, App Store / pkg on macOS) get updates through the OS-level updater, so the in-app red pill was redundant. Linux AppImage users still get the notifier.

## What's new in 1.0.14

- **Windows Bluetooth fix.**
  - **Microsoft Store (AppX) build:** the AppX manifest now declares `<DeviceCapability Name="bluetooth.genericAttributeProfile">`. Without it the MSIX sandbox blocked Chromium's Web Bluetooth from talking to the WinRT BLE APIs, so `requestDevice()` silently returned no devices on Store installs while the NSIS sideload worked. Injected via a build-time `build/patch-appx-template.js` script that edits the upstream electron-builder AppX template (electron-builder v25 has no public knob for `<Capabilities>` content).
  - **All Windows builds:** `device.gatt.connect()` is now wrapped in a 25 s watchdog. A dismissed Windows pairing dialog or a stale bond used to leave the renderer's `ble.scanning` flag stuck at `true` forever — the re-entrancy guard in `bleConnect` would then silently swallow every subsequent Connect click. The flag is now released in a `finally` block, and the re-entrancy guard surfaces "Still connecting — please wait…" so the user gets feedback instead of a wedged button. On timeout the half-connected GATT is torn down and a "Pairing took too long — check Windows Bluetooth settings, then retry" message is shown.
- No behaviour change on macOS or Linux (the watchdog never fires on the existing fast paths; the AppX manifest edit is Windows-only).

## What's new in 1.0.13

- AppX manifest `Package/Properties/PublisherDisplayName` set to **Diëlectricum** (matches the Partner Center publisher display name; the previous "RF Guru" was rejected at upload validation). AppX-only — `productName`, `author`, and the about/footer copy on the macOS / Linux / NSIS builds keep showing **RF.Guru** / **HotSpot**.

## What's new in 1.0.12

- AppX tile asset set generated from the 1024×1024 product icon so the Windows Start menu / Search results / Store listing show the actual SVXLink-HotSpot logo instead of electron-builder's placeholder tile. Resolves Microsoft Store certification policy **10.1.1.11 On Device Tiles** ("tile icons must uniquely represent product"). AppX-only — no behaviour change to the NSIS / macOS / Linux builds.

## What's new in 1.0.11

- AppX manifest `Package/Properties/DisplayName` set to **SVXLink-HotSpot** (matches the reserved Store name; the previous "SVXLink HotSpot" with a space wasn't reserved and was rejected at upload). AppX-only change — the NSIS / macOS / Linux builds still ship as **HotSpot**.

## What's new in 1.0.10

- **Microsoft Store packages.** Each release now ships `HotSpot-x64.appx` and `HotSpot-arm64.appx` alongside the NSIS installers. These match the **RFGuru.SVXLink-HotSpot** identity registered in Partner Center and are ready to upload to the Microsoft Store submission flow.
- AppX manifest declares `runFullTrust` (via electron-builder's Desktop-Bridge template), so the packaged app retains full Web Bluetooth access just like the NSIS installer.
- Signed in CI with a self-signed cert whose CN matches the registered Publisher (`CN=FBF35633-D0C5-410A-883E-75B3C38AB746`). The Store re-signs during certification, so this signature only exists to satisfy `signtool.exe` during the build.

## What's new in 1.0.9

A targeted hardening pass after a 10-lens adversarial audit. Most items are invisible if everything was already working — the value is in the failure modes that no longer happen.

### Security / robustness

- Content-Security-Policy meta tag on both renderer windows — any HTML injection now has nowhere to call out to, no remote script to load, no inline `<script>`.
- IPC inputs are validated against an allowlist (`settings:save` rejects unknown keys, caps every string length, refuses non-hostname reflector domains; `geo:lookup` rate-limits to 1.5 s and caps query length).
- BLE feed's `rf` field is hostname-validated before being adopted as the reflector domain — a rogue HotSpot-shaped peripheral can no longer pivot your WSS connection.
- `setWindowOpenHandler` allowlist — external links only open if they match the curated set of HotSpot-related sites.
- Permission handlers gate on the `file://` origin so a future remote iframe can't request Bluetooth / geolocation.
- Single-instance lock — a double-Dock-click during slow first launch no longer spawns a second renderer racing for the same BLE peripheral and `settings.json` write.

### Data integrity

- `settings.json` is now written atomically (tmp + rename) with a `.bak` previous-good copy alongside; on parse failure the corrupt file is quarantined under `.corrupt-<ts>` instead of being silently replaced with defaults.
- Settings-window position is debounced (500 ms trailing) — drag bursts no longer thrash the disk.

### BLE

- `bleConnect` and `bleTryReconnect` now share a monotonic generation counter, so an in-flight reconnect can't clobber `ble.*` after the user manually re-paired to a different hotspot.
- Characteristic notification listeners are scoped to an `AbortController` per connection cycle, then aborted on reconnect — no more N reconnects → N callbacks per BLE notification leak.
- Picker's 30 s scan timeout now reliably flips to the "No HotSpots in range — Rescan" empty state regardless of whether late candidates were still being streamed.
- Picker: full keyboard support (Esc cancels, Tab is trapped, autofocus on open, focus restored to trigger on close, `aria-labelledby`).
- Forget-while-spinning is no longer silently undone by the in-flight `saveDeviceIdentity`.
- Saved BLE id is sent to main *before* the BLE chooser fires, so the startup race that could auto-pick the wrong hotspot in a multi-HS room is gone.

### Reflector WSS

- Stale `onclose`/`onerror`/`onmessage` from a previous socket no longer trigger reconnects that race with the fresh one (handler identity check + explicit detach).
- Snapshot timer is cleared in `reflectorScheduleReconnect` so a transient failure doesn't double-flip `available`.
- Frames over 4 MB are dropped (defeats a hostile reflector trying to stall the renderer with a megabyte-sized JSON snapshot).
- Sustained failures back off exponentially up to 5 min — a typo'd domain no longer hammers the upstream every 15 s forever.
- The renderer's WSS + BLE state is torn down on `beforeunload` / `app:before-quit`.

### Performance

- Map markers are kept in a `Map<callsign, marker>` cache — only the markers whose state actually changed are touched (was ~200 SVG nodes/sec churn during a net; now ≈ 0 between updates).
- `renderTable` does keyed diff-updates against the existing `<tr>` rows instead of rebuilding the entire `<tbody>.innerHTML` every second. Text selection in the table survives ticks now.
- Talker-driven `fitBounds` is animation-disabled and debounced 250 ms — no more camera-fighting on the Map tab during a multi-station net.
- Map markers skip the render entirely while the Map tab isn't visible.

### OS lifecycle

- macOS: window-close hides instead of quitting (matches the standard dock convention). Dock click reopens.
- `powerMonitor` hooks force a quick BLE + WSS reconnect on system resume — no more sitting for minutes on a half-dead socket after lid-open.
- `render-process-gone` handler reloads the page once instead of leaving a white window.
- macOS tray icon is now a template image — adapts to light/dark menu bars.

### Windows / Linux

- `AppUserModelId` set on Windows — toasts attribute to HotSpot instead of "Electron"; taskbar pinning survives upgrades.
- `tray.displayBalloon` (legacy Win32 API, silently dead on Win10/11 in many configs) replaced with the standard `Notification` API.
- Application menu added with platform-appropriate accelerators (`Cmd+,` / `Ctrl+,` → Settings, `Cmd+Q` / `Alt+F4` → Quit).

### Update notifier

- Semver-style comparator handles 1.10.0 > 1.9.0, prerelease tags (`1.0.9-beta` < `1.0.9`), and is case-insensitive on the leading `v`.
- 15 s fetch timeout via `AbortController`; honours GitHub rate-limit headers.
- New "renderer ready" handshake so the broadcast can't be missed by a slow boot.
- Pill flips to a muted "Opened ↗" state after click — feedback that the click landed.

### CI / release pipeline

- Releases are created as a **draft**, populated with platform artifacts, and only promoted to public when every leg succeeds. v1.0.7's update notifier will never again point users at a release with missing macOS DMGs.
- `workflow_dispatch` input — re-run on an existing tag without the destructive `git tag -d` dance.
- Pre-flight `notarytool history` now exit-fails the job on a wrong app-specific password (was previously swallowed by `head -30`).
- `concurrency` group prevents two near-simultaneous tag pushes from racing on the notary queue and release-asset upload.

### Accessibility

- Settings window: Esc closes, Cmd/Ctrl+S saves, OS-close prompts on unsaved changes.
- BLE picker dialog: keyboard navigation, focus management, screen-reader labelling.
- Light-theme contrast — `--ok`, `--muted`, `--hotspot` darkened for WCAG AA on white.
- Update pill gains a `:focus-visible` outline and a visible border.

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
