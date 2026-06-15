// Inject the Bluetooth GATT DeviceCapability into electron-builder's bundled
// AppX manifest template *before* the AppX target reads it. The upstream
// template (node_modules/app-builder-lib/templates/appx/appxmanifest.xml)
// hardcodes a Capabilities block containing only <rescap:Capability
// Name="runFullTrust"/>. Without bluetooth.genericAttributeProfile, the
// MSIX/AppX sandbox blocks the WinRT BLE APIs that Chromium's Web Bluetooth
// uses on Windows — so requestDevice() silently returns no devices when the
// app is installed via the Microsoft Store, even though the NSIS sideload
// build works fine. There is no public electron-builder option for this in
// v25 (AppXOptions exposes customExtensionsPath only, which appends inside
// <Extensions>, not <Capabilities>), so we patch the template directly.
//
// Idempotent: skips the write if the capability is already present. Fails
// loudly if the runFullTrust anchor isn't found, so a future electron-builder
// upgrade that reshapes the template can't silently produce an AppX with
// missing Bluetooth.

const fs = require("fs");
const path = require("path");

const templatePath = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "app-builder-lib",
  "templates",
  "appx",
  "appxmanifest.xml",
);

if (!fs.existsSync(templatePath)) {
  console.error("[patch-appx] FATAL: template not found at", templatePath);
  process.exit(1);
}

const original = fs.readFileSync(templatePath, "utf8");

if (original.includes("bluetooth.genericAttributeProfile")) {
  console.log("[patch-appx] Bluetooth capability already present — skipping");
  process.exit(0);
}

const anchor = '<rescap:Capability Name="runFullTrust"/>';
if (!original.includes(anchor)) {
  console.error("[patch-appx] FATAL: runFullTrust anchor not found in template — electron-builder template shape may have changed. Aborting so we don't ship an AppX without runFullTrust.");
  process.exit(1);
}

const injected = `${anchor}
    <DeviceCapability Name="bluetooth.genericAttributeProfile">
      <Device Id="any">
        <Function Type="name:genericAccess"/>
      </Device>
    </DeviceCapability>`;

const patched = original.replace(anchor, injected);
fs.writeFileSync(templatePath, patched);
console.log("[patch-appx] injected bluetooth.genericAttributeProfile DeviceCapability into", templatePath);
