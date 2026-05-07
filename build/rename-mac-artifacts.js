const fs = require("fs");
const path = require("path");

const ARCH_LABELS = {
  arm64: "AppleSilicon",
  x64: "Intel",
};

exports.default = async function renameMacArtifacts(context) {
  const renamed = [];
  for (const original of context.artifactPaths) {
    const dir = path.dirname(original);
    let name = path.basename(original);
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
