const fs = require("fs");
const path = require("path");

const ARCH_LABELS = {
  arm64: "AppleSilicon",
  x64: "Intel",
};

// Only rename DMGs — Linux .AppImage files use the same `-arm64.` token
// and would otherwise get re-labelled "AppleSilicon" (a Linux arm64 build
// is obviously not Apple Silicon).
const RENAME_EXTS = [".dmg", ".dmg.blockmap"];

exports.default = async function renameMacArtifacts(context) {
  const renamed = [];
  for (const original of context.artifactPaths) {
    const name0 = path.basename(original);
    const matchesExt = RENAME_EXTS.some((ext) => name0.endsWith(ext));
    if (!matchesExt) { renamed.push(original); continue; }
    const dir = path.dirname(original);
    let name = name0;
    let changed = false;
    for (const [arch, label] of Object.entries(ARCH_LABELS)) {
      const token = `-${arch}.`;
      if (name.includes(token)) {
        name = name.replace(token, `-${label}.`);
        changed = true;
        break;
      }
    }
    if (!changed) {
      renamed.push(original);
      continue;
    }
    const next = path.join(dir, name);
    fs.renameSync(original, next);
    renamed.push(next);
  }
  return renamed;
};
