import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  ALLOWED_RELEASE_PREFIX,
  UPDATER_PUBLIC_KEY_SPKI_B64,
  buildMacReplaceScript,
  canonicalManifestPayload,
  checkSelfUpdateCapability,
  resolveMacAppBundlePath,
  signManifestPayload,
  validateUpdateUrl,
  verifyManifestSignature,
  type UpdateManifest,
} from "../self-update";

describe("Ed25519 更新清单签名与验签", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const testPubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const testPrivB64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

  const baseManifest: Omit<UpdateManifest, "signature"> = {
    version: "0.36.2",
    publishedAt: "2026-11-24T08:00:00.000Z",
    macArm64Zip: {
      name: "HotClip-0.36.2-mac-arm64.zip",
      url: `${ALLOWED_RELEASE_PREFIX}v0.36.2/HotClip-0.36.2-mac-arm64.zip`,
      sha256: "a".repeat(64),
      size: 123_456_789,
    },
  };

  it("内置公钥为合法 Ed25519 SPKI", () => {
    const keyObj = crypto.createPublicKey({
      key: Buffer.from(UPDATER_PUBLIC_KEY_SPKI_B64, "base64"),
      format: "der",
      type: "spki",
    });
    expect(keyObj.asymmetricKeyType).toBe("ed25519");
  });

  it("合法私钥签名通过验签，缺失或任意字段篡改一律拒绝", () => {
    const payload = canonicalManifestPayload(baseManifest);
    const signature = signManifestPayload(payload, testPrivB64);
    const signed: UpdateManifest = { ...baseManifest, signature };

    expect(verifyManifestSignature(signed, testPubB64)).toBe(true);
    // 换用内置公钥（不配对）应拒绝
    expect(verifyManifestSignature(signed, UPDATER_PUBLIC_KEY_SPKI_B64)).toBe(false);
    // 缺失签名应拒绝
    expect(verifyManifestSignature({ ...baseManifest }, testPubB64)).toBe(false);
    // 篡改版本号应拒绝
    expect(verifyManifestSignature({ ...signed, version: "0.99.9" }, testPubB64)).toBe(false);
    // 篡改 SHA-256 应拒绝
    expect(
      verifyManifestSignature(
        {
          ...signed,
          macArm64Zip: { ...baseManifest.macArm64Zip!, sha256: "b".repeat(64) },
        },
        testPubB64
      )
    ).toBe(false);
    // 篡改下载地址应拒绝
    expect(
      verifyManifestSignature(
        {
          ...signed,
          macArm64Zip: { ...baseManifest.macArm64Zip!, url: "https://evil.example/a.zip" },
        },
        testPubB64
      )
    ).toBe(false);
  });
});

describe("validateUpdateUrl", () => {
  it("仅放行本项目 GitHub Releases 下载前缀", () => {
    expect(validateUpdateUrl(`${ALLOWED_RELEASE_PREFIX}v0.36.1/HotClip-0.36.1-mac-arm64.zip`)).toBe(true);
    expect(validateUpdateUrl("https://evil.example/HotClip-0.36.1-mac-arm64.zip")).toBe(false);
    expect(validateUpdateUrl("http://github.com/ChrisssWong/hotclip/releases/download/v0.36.1/a.zip")).toBe(false);
    expect(validateUpdateUrl(`${ALLOWED_RELEASE_PREFIX}v0.36.1/../../other/repo`)).toBe(false);
  });
});

describe("resolveMacAppBundlePath & checkSelfUpdateCapability", () => {
  it("正确识别已安装路径，并拦截 DMG 与 AppTranslocation 路径", () => {
    expect(resolveMacAppBundlePath("/Applications/HotClip.app/Contents/MacOS/HotClip")).toEqual({
      ok: true,
      appPath: "/Applications/HotClip.app",
    });

    const fromDmg = resolveMacAppBundlePath("/Volumes/HotClip 0.36.1/HotClip.app/Contents/MacOS/HotClip");
    expect(fromDmg.ok).toBe(false);
    expect(fromDmg.reason).toContain("DMG");

    const translocated = resolveMacAppBundlePath(
      "/private/var/folders/xx/AppTranslocation/1234/d/HotClip.app/Contents/MacOS/HotClip"
    );
    expect(translocated.ok).toBe(false);
    expect(translocated.reason).toContain("隔离");

    expect(resolveMacAppBundlePath("/usr/local/bin/node").ok).toBe(false);
  });

  it("非 macOS / 非 arm64 / 开发态均明确不支持自更新", () => {
    expect(checkSelfUpdateCapability({ isPackaged: true, platform: "win32", arch: "x64" }).supported).toBe(false);
    expect(checkSelfUpdateCapability({ isPackaged: true, platform: "darwin", arch: "x64" }).supported).toBe(false);
    expect(checkSelfUpdateCapability({ isPackaged: false, platform: "darwin", arch: "arm64" }).supported).toBe(false);
  });

  it("替换脚本使用环境变量并包含回滚与重启指令", () => {
    const script = buildMacReplaceScript();
    expect(script).toContain('"$HOTCLIP_OLD_PID"');
    expect(script).toContain('"$HOTCLIP_TARGET_APP"');
    expect(script).toContain('"$HOTCLIP_NEW_APP"');
    expect(script).toContain("/usr/bin/open -a");
  });
});
