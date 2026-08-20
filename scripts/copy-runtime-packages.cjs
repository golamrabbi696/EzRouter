"use strict";

const fs = require("node:fs");
const path = require("node:path");

function pnpmPackageRoot(packageName, version, storeDirs) {
  const prefix = `${packageName.replaceAll("/", "+")}@${version}`;
  for (const storeDir of storeDirs) {
    if (!fs.existsSync(storeDir)) continue;
    const entry = fs.readdirSync(storeDir)
      .find((name) => name === prefix || name.startsWith(`${prefix}_`));
    if (!entry) continue;
    const candidate = path.join(storeDir, entry, "node_modules", packageName);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  return null;
}

function resolvePackage(packageName, searchPaths, storeDirs) {
  // Try to resolve package.json directly, but fall back to resolving the package root
  let manifestPath;
  try {
    manifestPath = require.resolve(`${packageName}/package.json`, {
      paths: searchPaths,
    });
  } catch (err) {
    // If package.json is not exported, resolve the package entry point and find package.json
    const entryPath = require.resolve(packageName, { paths: searchPaths });
    let currentDir = path.dirname(entryPath);
    // Walk up to find package.json
    while (currentDir !== path.dirname(currentDir)) {
      const candidatePath = path.join(currentDir, "package.json");
      if (fs.existsSync(candidatePath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
          if (pkg.name === packageName) {
            manifestPath = candidatePath;
            break;
          }
        } catch {}
      }
      currentDir = path.dirname(currentDir);
    }
    if (!manifestPath) throw err;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const installedRoot = path.dirname(manifestPath);
  const sourceRoot = pnpmPackageRoot(packageName, manifest.version, storeDirs)
    || installedRoot;
  return { manifest, sourceRoot };
}

function copyRuntimePackages(packageNames, destinationNodeModules, options = {}) {
  const searchPaths = options.searchPaths || [process.cwd()];
  const storeDirs = options.storeDirs || [];
  const copiedVersions = new Map();

  function copyPackage(packageName, dependencySearchPaths) {
    const { manifest, sourceRoot } = resolvePackage(
      packageName,
      dependencySearchPaths,
      storeDirs
    );
    const copiedVersion = copiedVersions.get(packageName);
    if (copiedVersion) {
      if (copiedVersion !== manifest.version) {
        // Use semver-style comparison: prefer the newer version
        const copiedParts = copiedVersion.split('.').map(Number);
        const manifestParts = manifest.version.split('.').map(Number);
        let useManifest = false;
        for (let i = 0; i < Math.max(copiedParts.length, manifestParts.length); i++) {
          const c = copiedParts[i] || 0;
          const m = manifestParts[i] || 0;
          if (m > c) {
            useManifest = true;
            break;
          } else if (m < c) {
            break;
          }
        }
        if (!useManifest) {
          // Keep the existing newer version, skip copying
          return;
        }
        // Otherwise fall through to replace with newer version
      } else {
        return;
      }
    }
    copiedVersions.set(packageName, manifest.version);

    const destination = path.join(destinationNodeModules, packageName);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(sourceRoot, destination, { recursive: true, dereference: true });
    options.onCopy?.(packageName, manifest.version);

    for (const dependency of Object.keys(manifest.dependencies || {})) {
      copyPackage(dependency, [sourceRoot, ...searchPaths]);
    }
  }

  for (const packageName of packageNames) {
    copyPackage(packageName, searchPaths);
  }
  return copiedVersions;
}

module.exports = { copyRuntimePackages };
