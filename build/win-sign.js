// Custom electron-builder Windows sign hook — uses the Windows SDK's
// signtool.exe instead of the older one electron-builder bundles inside
// `winCodeSign-2.6.0`. The bundled signtool predates AppX/MSIX support and
// errors out with "A required function is not present" when handed a .appx
// file. The SDK signtool on `windows-latest` runners handles AppX correctly.
//
// Called by electron-builder when `build.win.signtoolOptions.sign` is set to
// this file. Receives a CustomWindowsSignTaskConfiguration with `path` (file
// to sign), `cscInfo.file` / `cscInfo.password` (cert), and `hash`.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function findSdkSigntool() {
  if (process.env.SIGNTOOL_OVERRIDE && fs.existsSync(process.env.SIGNTOOL_OVERRIDE)) {
    return process.env.SIGNTOOL_OVERRIDE;
  }
  const baseDir = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  if (!fs.existsSync(baseDir)) {
    throw new Error("Windows SDK not found at " + baseDir);
  }
  // Prefer the newest SDK version; SDK 10.0.19041+ supports AppX signing.
  const versions = fs.readdirSync(baseDir)
    .filter((d) => /^\d+\.\d+/.test(d))
    .sort()
    .reverse();
  for (const v of versions) {
    for (const arch of ["x64", "x86"]) {
      const candidate = path.join(baseDir, v, arch, "signtool.exe");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error("signtool.exe not found in Windows SDK");
}

exports.default = async function (config) {
  if (!config.cscInfo || !config.cscInfo.file) {
    console.log("[win-sign] no cert configured; leaving", config.path, "unsigned");
    return;
  }
  const signtool = findSdkSigntool();
  const args = [
    "sign",
    "/f", config.cscInfo.file,
    "/fd", config.hash || "sha256",
    // RFC 3161 timestamp via DigiCert. Use /tr (RFC 3161) over /t (older
    // Authenticode timestamp) because /td must match — RFC 3161 supports
    // SHA-256 timestamps, the old format doesn't.
    "/tr", "http://timestamp.digicert.com",
    "/td", "sha256",
  ];
  if (config.cscInfo.password) {
    args.push("/p", config.cscInfo.password);
  }
  args.push(config.path);
  console.log("[win-sign] using", signtool);
  console.log("[win-sign] signing", config.path);
  execFileSync(signtool, args, { stdio: "inherit" });
};
