# HotSpot — Desktop App

A minimal desktop companion for the Analog HotSpot SVXLink box.  
Connects to the HotSpot over **Bluetooth Low Energy** (no network, no WebSocket), reads the live feed, and shows the current state + a running history of last talkers.

Built with [Electron](https://www.electronjs.org/), available for **macOS**, **Windows**, and **Linux**.

---

## Features

- BLE GATT client for the hotspot's Feed/DTMF/Command/Status characteristics (see [BLE.md](../Analog-HotSPOT-SVXLink/BLE.md))
- Live panel: callsign, frequency, talkgroup, IP, TX/RX flags, active talker
- Persistent **last talkers** history (callsign, TG, duration, time-ago)
- DTMF bar with quick buttons (TG, Status, IP, Parrot)
- Device commands (SVXLink start/stop/restart, 4G on/off, reboot, poweroff)
- Silent auto-reconnect on app startup to the last-paired device
- macOS menu-bar ticker shows the current talker
- Dark / light theme, always-on-top, custom frameless window

## Running from source

```bash
git clone https://github.com/Guru-RF/Analog-HotSPOT-App.git
cd Analog-HotSPOT-App
npm install
npm start
```

## Building

```bash
npm run build:mac    # macOS .dmg (arm64 + x64)
npm run build:win    # Windows .exe (x64)
npm run build:linux  # Linux .AppImage (x64 + arm64)
```

## Credits

Concept by [ON8ST](https://www.qrz.com/db/ON8ST),  
coded by [ON6URE](https://www.qrz.com/db/ON6URE).

Hosted by [rf.guru](https://rf.guru).

## License

MIT — see [LICENSE](LICENSE).
