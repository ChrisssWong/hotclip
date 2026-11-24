#!/usr/bin/env node
/**
 * 发布期更新清单与校验和生成脚本（零外部依赖，供 GitHub Actions publish 阶段调用）：
 * 1. 为 assets/ 目录下全部安装包生成 SHA256SUMS.txt；
 * 2. 生成 hotclip-update.json（包含 macOS arm64 zip 的 URL、SHA-256 与体积）；
 * 3. 若配置了环境变量 HOTCLIP_UPDATER_PRIVATE_KEY（Ed25519 PKCS8 Base64 或 PEM），
 *    对规范载荷签名并用内置公钥自检，确保私钥与客户端内置公钥严格配对。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 必须与 src/core/self-update.ts 中的 UPDATER_PUBLIC_KEY_SPKI_B64 保持完全一致。 */
const EXPECTED_PUBLIC_KEY_SPKI_B64 =
  "MCowBQYDK2VwAyEAP7WOgdfxpLhCwUeGqKZza4exvDZmv8KC/RznpiBrhzc=";

const DEFAULT_REPO = "ChrisssWong/hotclip";
const MANIFEST_FILENAME = "hotclip-update.json";
const CHECKSUMS_FILENAME = "SHA256SUMS.txt";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--") && i + 1 < argv.length) {
      out[arg.slice(2)] = argv[++i];
    }
  }
  return out;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * 与 src/core/self-update.ts 中的 canonicalManifestPayload 保持逐字节一致。
 */
export function canonicalManifestPayload(manifest) {
  const canonical = {
    version: manifest.version,
    publishedAt: manifest.publishedAt,
    ...(manifest.macArm64Zip
      ? {
          macArm64Zip: {
            name: manifest.macArm64Zip.name,
            url: manifest.macArm64Zip.url,
            sha256: manifest.macArm64Zip.sha256,
            size: manifest.macArm64Zip.size,
          },
        }
      : {}),
  };
  return JSON.stringify(canonical);
}

function loadPrivateKey(rawInput) {
  const trimmed = rawInput.trim();
  if (trimmed.includes("BEGIN PRIVATE KEY")) {
    return crypto.createPrivateKey({ key: trimmed, format: "pem" });
  }
  return crypto.createPrivateKey({
    key: Buffer.from(trimmed, "base64"),
    format: "der",
    type: "pkcs8",
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const assetsDir = path.resolve(args["assets-dir"] || "assets");
  const version = (args.version || "").replace(/^v/, "").trim();
  const repo = (args.repo || process.env.GITHUB_REPOSITORY || DEFAULT_REPO).trim();

  if (!version) {
    console.error("Missing required argument: --version <x.y.z>");
    process.exit(1);
  }
  if (!fs.existsSync(assetsDir)) {
    console.error(`Assets directory does not exist: ${assetsDir}`);
    process.exit(1);
  }

  const entries = fs
    .readdirSync(assetsDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => name !== CHECKSUMS_FILENAME && name !== MANIFEST_FILENAME)
    .sort((a, b) => a.localeCompare(b));

  const checksumLines = [];
  let macArm64Zip = undefined;

  for (const name of entries) {
    const fullPath = path.join(assetsDir, name);
    const digest = sha256File(fullPath);
    const stat = fs.statSync(fullPath);
    checksumLines.push(`${digest}  ${name}`);

    if (/-mac-arm64\.zip$/i.test(name)) {
      macArm64Zip = {
        name,
        url: `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(name)}`,
        sha256: digest,
        size: stat.size,
      };
    }
  }

  fs.writeFileSync(
    path.join(assetsDir, CHECKSUMS_FILENAME),
    checksumLines.join("\n") + "\n",
    "utf8"
  );

  if (!macArm64Zip) {
    console.error(`Missing macOS arm64 update zip (*-mac-arm64.zip) in ${assetsDir}`);
    process.exit(1);
  }

  const manifest = {
    version,
    publishedAt: new Date().toISOString(),
    macArm64Zip,
  };

  const privateKeyRaw = process.env.HOTCLIP_UPDATER_PRIVATE_KEY || "";
  if (privateKeyRaw.trim()) {
    const privateKey = loadPrivateKey(privateKeyRaw);
    const derivedPubB64 = crypto
      .createPublicKey(privateKey)
      .export({ type: "spki", format: "der" })
      .toString("base64");

    if (derivedPubB64 !== EXPECTED_PUBLIC_KEY_SPKI_B64) {
      console.error(
        "HOTCLIP_UPDATER_PRIVATE_KEY does not match the public key embedded in HotClip!"
      );
      process.exit(1);
    }

    const payload = canonicalManifestPayload(manifest);
    const sig = crypto.sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");

    const pubKeyObj = crypto.createPublicKey({
      key: Buffer.from(EXPECTED_PUBLIC_KEY_SPKI_B64, "base64"),
      format: "der",
      type: "spki",
    });
    const verified = crypto.verify(
      null,
      Buffer.from(payload, "utf8"),
      pubKeyObj,
      Buffer.from(sig, "base64")
    );
    if (!verified) {
      console.error("Ed25519 self-verification failed!");
      process.exit(1);
    }
    manifest.signature = sig;
    console.log(`Signed ${MANIFEST_FILENAME} for v${version} (${macArm64Zip.name})`);
  } else {
    console.log(
      `::warning::HOTCLIP_UPDATER_PRIVATE_KEY is not set. ${MANIFEST_FILENAME} was generated without an Ed25519 signature; macOS in-app self-update will refuse unsigned manifests until the secret is configured.`
    );
  }

  fs.writeFileSync(
    path.join(assetsDir, MANIFEST_FILENAME),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );
  console.log(`Wrote ${CHECKSUMS_FILENAME} (${checksumLines.length} files) and ${MANIFEST_FILENAME}`);
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isDirectRun) {
  main();
}
