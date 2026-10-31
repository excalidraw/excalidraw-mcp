#!/usr/bin/env node
// Immediate log to verify script execution
console.log("[setup-bun] Script loaded");

/**
 * Postinstall script to set up bun from platform-specific optional dependencies.
 * Handles Windows ARM64 by downloading x64-baseline via emulation.
 */
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  copyFileSync,
  chmodSync,
  writeFileSync,
} from "fs";
import { join, dirname } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { get } from "https";
import { createGunzip } from "zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const nodeModules = join(projectRoot, "node_modules");
const binDir = join(nodeModules, ".bin");

const os = process.platform;
const arch = process.arch;
const isWindows = os === "win32";
const bunExe = isWindows ? "bun.exe" : "bun";

// Detect libc type on Linux (glibc vs musl)
function detectLibc() {
  if (os !== "linux") return null;

  // Check for musl-specific loader
  const muslLoaders = [
    `/lib/ld-musl-${arch === "arm64" ? "aarch64" : "x86_64"}.so.1`,
    "/lib/ld-musl-x86_64.so.1",
    "/lib/ld-musl-aarch64.so.1",
  ];

  for (const loader of muslLoaders) {
    if (existsSync(loader)) {
      console.log(`  Detected musl libc (found ${loader})`);
      return "musl";
    }
  }

  // Default to glibc on Linux
  console.log("  Detected glibc (no musl loader found)");
  return "glibc";
}

// Platform to package mapping (matches @oven/bun-* package names)
// For Linux, separate glibc and musl packages
const platformPackages = {
  darwin: {
    arm64: ["bun-darwin-aarch64"],
    x64: ["bun-darwin-x64", "bun-darwin-x64-baseline"],
  },
  linux: {
    arm64: {
      glibc: ["bun-linux-aarch64"],
      musl: ["bun-linux-aarch64-musl"],
    },
    x64: {
      glibc: ["bun-linux-x64", "bun-linux-x64-baseline"],
      musl: ["bun-linux-x64-musl", "bun-linux-x64-musl-baseline"],
    },
  },
  win32: {
    x64: ["bun-windows-x64", "bun-windows-x64-baseline"],
    arm64: ["bun-windows-x64-baseline"], // x64 runs via emulation on ARM64
  },
};

function findBunBinary() {
  let packages = platformPackages[os]?.[arch];

  // For Linux, select packages based on libc type
  if (os === "linux" && packages && typeof packages === "object") {
    const libc = detectLibc();
    packages = packages[libc] || [];
  }

  packages = packages || [];
  console.log(
    `Looking for bun packages: ${packages.join(", ") || "(none for this platform)"}`,
  );

  for (const pkg of packages) {
    const binPath = join(nodeModules, "@oven", pkg, "bin", bunExe);
    console.log(`  Checking: ${binPath}`);
    if (existsSync(binPath)) {
      console.log(`  Found bun at: ${binPath}`);
      return binPath;
    } else {
      console.log(`  Not found`);
    }
  }

  return null;
}

async function downloadBunForWindowsArm64() {
  // Windows ARM64 can run x64 binaries via emulation
  const pkg = "bun-windows-x64-baseline";
  const version = "1.4.4";
  const url = `https://registry.npmjs.org/@oven/${pkg}/-/${pkg}-${version}.tgz`;
  const destDir = join(nodeModules, "@oven", pkg);

  console.log(`Downloading ${pkg} for Windows ARM64 emulation...`);

  return new Promise((resolve, reject) => {
    get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        get(response.headers.location, handleResponse).on("error", reject);
      } else {
        handleResponse(response);
      }

      function handleResponse(res) {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download: ${res.statusCode}`));
          return;
        }

        const chunks = [];
        const gunzip = createGunzip();

        res.pipe(gunzip);

        gunzip.on("data", (chunk) => chunks.push(chunk));
        gunzip.on("end", () => {
          try {
            extractTar(Buffer.concat(chunks), destDir);
            const binPath = join(destDir, "bin", bunExe);
            if (existsSync(binPath)) {
              resolve(binPath);
            } else {
              reject(new Error("Binary not found after extraction"));
            }
          } catch (err) {
            reject(err);
          }
        });
        gunzip.on("error", reject);
      }
    }).on("error", reject);
  });
}

function extractTar(buffer, destDir) {
  // Simple tar extraction (512-byte blocks)
  let offset = 0;
  while (offset < buffer.length) {
    const name = buffer
      .toString("utf-8", offset, offset + 100)
      .replace(/\0.*$/, "")
      .replace("package/", "");
    const size = parseInt(
      buffer.toString("utf-8", offset + 124, offset + 136).trim(),
      8,
    );

    offset += 512;

    if (!isNaN(size) && size > 0 && name) {
      const filePath = join(destDir, name);
      const fileDir = dirname(filePath);
      if (!existsSync(fileDir)) {
        mkdirSync(fileDir, { recursive: true });
      }
      const content = buffer.subarray(offset, offset + size);
      writeFileSync(filePath, content);

      // Make executable
      if (name.endsWith(bunExe) || name === "bin/bun") {
        try {
          chmodSync(filePath, 0o755);
        } catch {}
      }

      offset += Math.ceil(size / 512) * 512;
    }
  }
}

function setupBinLink(bunPath) {
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  const bunLink = join(binDir, bunExe);
  const bunxLink = join(binDir, isWindows ? "bunx.exe" : "bunx");

  // Remove existing links
  for (const link of [bunLink, bunxLink]) {
    try {
      unlinkSync(link);
    } catch {}
  }

  if (isWindows) {
    // On Windows, copy the binary (symlinks may not work without admin)
    copyFileSync(bunPath, bunLink);
    copyFileSync(bunPath, bunxLink);
  } else {
    // On Unix, use symlinks
    symlinkSync(bunPath, bunLink);
    symlinkSync(bunPath, bunxLink);
  }

  console.log(`Bun linked to: ${bunLink}`);
}

// Force immediate output
process.stdout.write("[setup-bun] Script starting...\n");

async function main() {
  process.stdout.write(`[setup-bun] Setting up bun for ${os} ${arch}...\n`);
  process.stdout.write(`[setup-bun] Project root: ${projectRoot}\n`);
  process.stdout.write(`[setup-bun] Node modules: ${nodeModules}\n`);

  let bunPath = findBunBinary();

  if (!bunPath && os === "win32" && arch === "arm64") {
    try {
      bunPath = await downloadBunForWindowsArm64();
    } catch (err) {
      console.error("Failed to download bun for Windows ARM64:", err.message);
    }
  }

  if (!bunPath) {
    console.log("No bun binary found in optional dependencies.");
    console.log("Bun will need to be installed separately.");
    console.log("See: https://bun.sh/docs/installation");
    process.exit(0); // Don't fail the install
  }

  try {
    setupBinLink(bunPath);

    // Verify installation
    const result = spawnSync(bunPath, ["--version"], { encoding: "utf-8" });
    if (result.status === 0) {
      console.log(`Bun ${result.stdout.trim()} installed successfully!`);
    }
  } catch (err) {
    console.error("Failed to set up bun:", err.message);
    process.exit(0); // Don't fail the install
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(0); // Don't fail the install
});
