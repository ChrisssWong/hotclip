/**
 * macOS 应用内签名自更新核心模块（参考 clash-traffic 的 Ed25519 公私钥自更新机制）：
 * - 打包时在 GitHub Actions 用私钥对 hotclip-update.json 规范载荷做 Ed25519 签名；
 * - 客户端内置公钥，下载更新清单后严格校验 Ed25519 签名 + 下载地址白名单 + SHA-256 哈希；
 * - 解压并用 codesign --verify 校验新包结构完整后，通过脱离进程原子替换当前 .app 并重启；
 * - 由本机进程写入的新 .app 不携带 com.apple.quarantine 隔离属性，免去每次更新都要进系统设置放行的步骤。
 */
import crypto from "node:crypto";
import { execFile as execFileCb, spawn } from "node:child_process";
import { once } from "node:events";
import { accessSync, constants as fsConstants, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseVersion, RELEASES_REPO } from "./update-check";
import type { SelfUpdateCapability, SelfUpdateProgress } from "../shared/api-types";

const execFile = promisify(execFileCb);

/**
 * 客户端内置 Ed25519 公钥（SPKI DER Base64，安全公开）。
 * 对应私钥需配置到 GitHub Actions Secret: HOTCLIP_UPDATER_PRIVATE_KEY。
 * 如需轮换密钥：用 crypto.generateKeyPairSync("ed25519") 生成新密钥对，
 * 同步更新此处与 tools/sign-update-manifest.mjs 中的公钥常量，并替换 GitHub Secret。
 */
export const UPDATER_PUBLIC_KEY_SPKI_B64 =
  "MCowBQYDK2VwAyEAP7WOgdfxpLhCwUeGqKZza4exvDZmv8KC/RznpiBrhzc=";

export const UPDATE_MANIFEST_FILENAME = "hotclip-update.json";
export const ALLOWED_RELEASE_PREFIX = `https://github.com/${RELEASES_REPO}/releases/download/`;

export interface UpdateManifestAsset {
  name: string;
  url: string;
  sha256: string;
  size: number;
}

export interface UpdateManifest {
  version: string;
  publishedAt: string;
  macArm64Zip?: UpdateManifestAsset;
  signature?: string;
}

export interface BundlePathResolution {
  ok: boolean;
  appPath?: string;
  reason?: string;
}

/**
 * 生成用于 Ed25519 签名与验签的稳定规范载荷。
 * 字段顺序必须与 tools/sign-update-manifest.mjs 保持逐字节一致。
 */
export function canonicalManifestPayload(manifest: Omit<UpdateManifest, "signature">): string {
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

/** 用 Ed25519 私钥（PKCS8 DER Base64 或 PEM）签名规范载荷，返回 Base64 签名。 */
export function signManifestPayload(payload: string, privateKeyInput: string): string {
  const trimmed = privateKeyInput.trim();
  const key = trimmed.includes("BEGIN PRIVATE KEY")
    ? crypto.createPrivateKey({ key: trimmed, format: "pem" })
    : crypto.createPrivateKey({
        key: Buffer.from(trimmed, "base64"),
        format: "der",
        type: "pkcs8",
      });
  return crypto.sign(null, Buffer.from(payload, "utf8"), key).toString("base64");
}

/** 严格校验更新清单的 Ed25519 签名；无签名、格式损坏或字段被篡改均返回 false。 */
export function verifyManifestSignature(
  manifest: UpdateManifest,
  publicKeySpkiB64: string = UPDATER_PUBLIC_KEY_SPKI_B64
): boolean {
  if (!manifest.signature || typeof manifest.signature !== "string") return false;
  const sigTrimmed = manifest.signature.trim();
  if (!sigTrimmed) return false;
  try {
    const sigBuf = Buffer.from(sigTrimmed, "base64");
    if (sigBuf.length !== 64) return false;
    const pubKey = crypto.createPublicKey({
      key: Buffer.from(publicKeySpkiB64, "base64"),
      format: "der",
      type: "spki",
    });
    const payload = canonicalManifestPayload(manifest);
    return crypto.verify(null, Buffer.from(payload, "utf8"), pubKey, sigBuf);
  } catch {
    return false;
  }
}

/** 严格校验更新包下载地址必须位于允许的 GitHub Releases 前缀之下。 */
export function validateUpdateUrl(
  url: string,
  allowedPrefix: string = ALLOWED_RELEASE_PREFIX
): boolean {
  if (typeof url !== "string" || !url.startsWith(allowedPrefix)) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (parsed.pathname.includes("..")) return false;
    return parsed.href.startsWith(allowedPrefix);
  } catch {
    return false;
  }
}

/**
 * 从当前进程可执行路径解析 macOS `.app` 包根目录，并拦截 DMG / 系统隔离目录等不可替换位置。
 */
export function resolveMacAppBundlePath(execPath: string): BundlePathResolution {
  const normalized = execPath.replace(/\\/g, "/");
  const match = normalized.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/);
  if (!match) {
    return {
      ok: false,
      reason: "仅支持已安装的 HotClip.app 执行应用内更新",
    };
  }
  const appPath = match[1];
  if (appPath.startsWith("/Volumes/")) {
    return {
      ok: false,
      reason: "当前正在磁盘映像（DMG）中运行，请先将 HotClip 拖入「应用程序」文件夹后再使用应用内更新",
    };
  }
  if (appPath.includes("/AppTranslocation/")) {
    return {
      ok: false,
      reason: "应用处于系统隔离运行状态，请先将 HotClip 移至「应用程序」文件夹后重新打开",
    };
  }
  return { ok: true, appPath };
}

/**
 * 构造脱离进程原子替换脚本。所有路径与 PID 经环境变量传入，避免 shell 字符串拼接注入。
 */
export function buildMacReplaceScript(): string {
  return [
    "set -eu",
    "i=0",
    'while kill -0 "$HOTCLIP_OLD_PID" 2>/dev/null; do',
    "  i=$((i + 1))",
    '  if [ "$i" -ge 300 ]; then exit 1; fi',
    "  sleep 0.1",
    "done",
    'backup="${HOTCLIP_TARGET_APP}.backup-$$"',
    'rm -rf "$backup"',
    'mv "$HOTCLIP_TARGET_APP" "$backup"',
    'if ! mv "$HOTCLIP_NEW_APP" "$HOTCLIP_TARGET_APP"; then',
    '  mv "$backup" "$HOTCLIP_TARGET_APP" || true',
    "  exit 1",
    "fi",
    'rm -rf "$backup" "$HOTCLIP_STAGING_DIR" || true',
    '/usr/bin/xattr -dr com.apple.quarantine "$HOTCLIP_TARGET_APP" 2>/dev/null || true',
    '/usr/bin/open -a "$HOTCLIP_TARGET_APP"',
  ].join("\n");
}

/** 判断当前运行环境是否具备 macOS 应用内自更新条件。 */
export function checkSelfUpdateCapability(options: {
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
  execPath?: string;
}): SelfUpdateCapability & { appPath?: string } {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const execPath = options.execPath ?? process.execPath;

  if (platform !== "darwin") {
    return {
      supported: false,
      reason: "当前系统暂不支持应用内自更新，请前往发布页下载安装包",
    };
  }
  if (arch !== "arm64") {
    return {
      supported: false,
      reason: "当前仅 Apple Silicon (arm64) 支持应用内自更新，请前往发布页下载",
    };
  }
  if (!options.isPackaged) {
    return {
      supported: false,
      reason: "开发模式下不支持应用内自更新",
    };
  }
  const bundle = resolveMacAppBundlePath(execPath);
  if (!bundle.ok || !bundle.appPath) {
    return { supported: false, reason: bundle.reason };
  }
  try {
    accessSync(path.dirname(bundle.appPath), fsConstants.W_OK);
  } catch {
    return {
      supported: false,
      reason: `没有写入 ${path.dirname(bundle.appPath)} 的权限，请前往发布页手动安装`,
    };
  }
  return { supported: true, appPath: bundle.appPath };
}

export interface InstallMacSelfUpdateOptions {
  version: string;
  isPackaged: boolean;
  execPath?: string;
  signal?: AbortSignal;
  onProgress?: (progress: SelfUpdateProgress) => void;
}

/**
 * 执行完整的 macOS 应用内签名自更新：
 * 拉取清单 → Ed25519 验签 → 白名单校验 → 流式下载并算 SHA-256 → ditto 解压 → codesign 校验 → 脱离进程原子替换重启。
 * 返回后调用方应立即调用 `app.quit()` 让替换脚本完成切换。
 */
export async function installMacSelfUpdate(options: InstallMacSelfUpdateOptions): Promise<void> {
  const cap = checkSelfUpdateCapability({
    isPackaged: options.isPackaged,
    execPath: options.execPath,
  });
  if (!cap.supported || !cap.appPath) {
    throw new Error(cap.reason ?? "当前环境不支持应用内自更新");
  }

  const cleanVersion = options.version.replace(/^v/, "").trim();
  if (!parseVersion(cleanVersion)) {
    throw new Error(`无效的目标版本号：${options.version}`);
  }

  const report = (p: SelfUpdateProgress): void => options.onProgress?.(p);
  const ensureNotAborted = (): void => {
    if (options.signal?.aborted) {
      throw new DOMException("更新已取消", "AbortError");
    }
  };

  // 1. 拉取对应版本的签名清单
  report({ stage: "checking" });
  const manifestUrl = `${ALLOWED_RELEASE_PREFIX}v${cleanVersion}/${UPDATE_MANIFEST_FILENAME}`;
  if (!validateUpdateUrl(manifestUrl)) {
    throw new Error("更新清单地址校验失败");
  }

  const manifestRes = await fetch(manifestUrl, {
    signal: options.signal,
    redirect: "follow",
    headers: { Accept: "application/json" },
  });
  if (manifestRes.status === 404) {
    throw new Error(`v${cleanVersion} 未包含应用内更新清单，请点击「前往下载页」手动获取`);
  }
  if (!manifestRes.ok) {
    throw new Error(`获取更新清单失败（HTTP ${manifestRes.status}）`);
  }

  const manifest = (await manifestRes.json()) as UpdateManifest;
  ensureNotAborted();

  // 2. 校验版本、资产、Ed25519 签名与下载地址白名单
  report({ stage: "verifying" });
  if (manifest.version !== cleanVersion) {
    throw new Error(`更新清单版本不匹配（期望 ${cleanVersion}，实际 ${manifest.version ?? "空"}）`);
  }
  const asset = manifest.macArm64Zip;
  if (!asset || !asset.url || !asset.sha256) {
    throw new Error("更新清单缺少 macOS arm64 更新包信息");
  }
  if (!manifest.signature) {
    throw new Error(
      "该版本更新清单尚未完成 Ed25519 签名（需在 GitHub Secrets 配置 HOTCLIP_UPDATER_PRIVATE_KEY 后发版），为保障安全已阻止自动替换"
    );
  }
  if (!verifyManifestSignature(manifest)) {
    throw new Error("更新清单 Ed25519 签名验证失败，已中止安装");
  }
  if (!validateUpdateUrl(asset.url)) {
    throw new Error("更新包下载地址不在白名单范围内，已中止安装");
  }

  // 3. 流式下载并同步计算 SHA-256
  const stagingDir = await mkdtemp(path.join(os.tmpdir(), "hotclip-update-"));
  const zipPath = path.join(stagingDir, "update.zip");
  const extractDir = path.join(stagingDir, "extract");

  try {
    report({ stage: "downloading", fraction: 0, downloadedBytes: 0, totalBytes: asset.size });
    const zipRes = await fetch(asset.url, { signal: options.signal, redirect: "follow" });
    if (!zipRes.ok || !zipRes.body) {
      throw new Error(`下载更新包失败（HTTP ${zipRes.status}）`);
    }

    const headerTotal = Number(zipRes.headers.get("content-length") ?? 0);
    const totalBytes = headerTotal > 0 ? headerTotal : asset.size;
    const hash = crypto.createHash("sha256");
    const ws = createWriteStream(zipPath);
    const reader = zipRes.body.getReader();
    let downloadedBytes = 0;
    let lastEmit = 0;

    try {
      while (true) {
        ensureNotAborted();
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        hash.update(value);
        downloadedBytes += value.byteLength;
        if (!ws.write(value)) {
          await once(ws, "drain");
        }
        const now = Date.now();
        if (now - lastEmit >= 80) {
          lastEmit = now;
          report({
            stage: "downloading",
            fraction: totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : undefined,
            downloadedBytes,
            totalBytes: totalBytes > 0 ? totalBytes : undefined,
          });
        }
      }
      ws.end();
      await once(ws, "finish");
    } catch (err) {
      ws.destroy();
      await reader.cancel().catch(() => {});
      throw err;
    }

    report({
      stage: "downloading",
      fraction: 1,
      downloadedBytes,
      totalBytes: totalBytes > 0 ? totalBytes : downloadedBytes,
    });
    ensureNotAborted();

    // 4. 校验安装包 SHA-256
    report({ stage: "verifying" });
    const actualSha = hash.digest("hex").toLowerCase();
    if (actualSha !== asset.sha256.toLowerCase()) {
      throw new Error("更新包 SHA-256 校验失败，文件可能已损坏或被篡改");
    }

    // 5. 使用 ditto 解压并校验 .app 完整性与签名
    report({ stage: "extracting" });
    await execFile("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir], {
      signal: options.signal,
    });
    ensureNotAborted();

    const newAppPath = path.join(extractDir, "HotClip.app");
    const appStat = await stat(newAppPath).catch(() => null);
    if (!appStat?.isDirectory()) {
      throw new Error("更新包内未找到 HotClip.app");
    }

    await execFile("/usr/bin/codesign", ["--verify", "--deep", "--strict", newAppPath], {
      signal: options.signal,
    });
    // 兜底移除任何可能继承的隔离属性
    await execFile("/usr/bin/xattr", ["-dr", "com.apple.quarantine", newAppPath]).catch(() => {});
    ensureNotAborted();

    // 6. 拉起脱离进程完成原地替换并重启
    report({ stage: "installing" });
    const child = spawn("/bin/sh", ["-c", buildMacReplaceScript()], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HOTCLIP_OLD_PID: String(process.pid),
        HOTCLIP_TARGET_APP: cap.appPath,
        HOTCLIP_NEW_APP: newAppPath,
        HOTCLIP_STAGING_DIR: stagingDir,
      },
    });
    child.unref();

    report({ stage: "restarting" });
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
