/**
 * Final Cut Pro 无损时间线工程（FCPXML v1.10）纯函数生成器：
 * - 反链源片 file:// 路径，零复制媒体、1 秒生成；
 * - 严格按源视频真实帧率做有理数帧对齐（支持 23.976/24/25/29.97/30/50/59.94/60fps），
 *   导入 Final Cut Pro 时不触发帧边界漂移警告；
 * - 每一段保留区间对应时间线上一个独立可微调的 <asset-clip>。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { TimeSpan } from "../shared/silence-cut";

export interface FcpXmlInput {
  /** 工程/时间线名称 */
  projectName: string;
  /** 源媒体绝对路径 */
  sourcePath: string;
  /** 源媒体总时长（秒） */
  sourceDurationSec: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** 音频采样率（默认 48000） */
  audioRate?: number;
  /** 音频声道数（默认 2） */
  audioChannels?: number;
  /** 按时间排序的保留区间（绝对源片秒） */
  segments: readonly TimeSpan[];
}

export interface RationalFrameDuration {
  /** 单帧分子 */
  num: number;
  /** 单帧分母 */
  den: number;
  /** FCP 格式名称后缀，如 FFVideoFormat3840x2160p60 */
  fpsTag: string;
}

/** 将浮点帧率映射为 Final Cut Pro 认可的标准有理数 frameDuration。 */
export function resolveFrameDuration(fps: number): RationalFrameDuration {
  const f = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const presets: Array<{ match: number; tol: number; num: number; den: number; fpsTag: string }> = [
    { match: 23.976, tol: 0.05, num: 1001, den: 24000, fpsTag: "2398" },
    { match: 24, tol: 0.05, num: 100, den: 2400, fpsTag: "24" },
    { match: 25, tol: 0.05, num: 100, den: 2500, fpsTag: "25" },
    { match: 29.97, tol: 0.05, num: 1001, den: 30000, fpsTag: "2997" },
    { match: 30, tol: 0.05, num: 100, den: 3000, fpsTag: "30" },
    { match: 50, tol: 0.1, num: 100, den: 5000, fpsTag: "50" },
    { match: 59.94, tol: 0.1, num: 1001, den: 60000, fpsTag: "5994" },
    { match: 60, tol: 0.1, num: 100, den: 6000, fpsTag: "60" },
  ];
  for (const p of presets) {
    if (Math.abs(f - p.match) <= p.tol) {
      return { num: p.num, den: p.den, fpsTag: p.fpsTag };
    }
  }
  const rounded = Math.max(1, Math.round(f));
  return { num: 100, den: rounded * 100, fpsTag: String(rounded) };
}

/** 将秒数量化为整帧对应的 FCPXML 有理时间字符串（如 "12000/6000s" 或 "0s"）。 */
export function framesToFcpTime(frames: number, frameDur: RationalFrameDuration): string {
  const safeFrames = Math.max(0, Math.round(frames));
  if (safeFrames === 0) return "0s";
  const totalNum = safeFrames * frameDur.num;
  if (totalNum % frameDur.den === 0) {
    return `${totalNum / frameDur.den}s`;
  }
  return `${totalNum}/${frameDur.den}s`;
}

export function secToFrames(sec: number, frameDur: RationalFrameDuration): number {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.max(0, Math.round((sec * frameDur.den) / frameDur.num));
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toFileUrl(filePath: string): string {
  if (/^file:\/\//i.test(filePath)) return filePath;
  return pathToFileURL(path.resolve(filePath)).href;
}

/** 生成标准 Final Cut Pro FCPXML v1.10 文本。 */
export function buildFcpXml(input: FcpXmlInput): string {
  const frameDur = resolveFrameDuration(input.fps);
  const width = Math.max(16, Math.round(input.width || 1920));
  const height = Math.max(16, Math.round(input.height || 1080));
  const audioRate = input.audioRate ?? 48000;
  const audioChannels = input.audioChannels ?? 2;
  const sourceName = path.basename(input.sourcePath);
  const clipBaseName = sourceName.replace(/\.[^.]+$/, "") || sourceName;
  const projectName = input.projectName.trim() || `${clipBaseName}-去气口`;
  const sourceUrl = toFileUrl(input.sourcePath);

  // 将所有保留区间量化到整帧边界并过滤零帧碎片
  const quantized: Array<{ startFrames: number; durFrames: number }> = [];
  let maxEndFrames = secToFrames(input.sourceDurationSec, frameDur);

  for (const seg of input.segments) {
    if (!Number.isFinite(seg.startSec) || !Number.isFinite(seg.endSec) || seg.endSec <= seg.startSec) continue;
    const startFrames = secToFrames(seg.startSec, frameDur);
    const endFrames = secToFrames(seg.endSec, frameDur);
    const durFrames = endFrames - startFrames;
    if (durFrames <= 0) continue;
    quantized.push({ startFrames, durFrames });
    if (endFrames > maxEndFrames) maxEndFrames = endFrames;
  }

  const totalSeqFrames = quantized.reduce((sum, q) => sum + q.durFrames, 0);
  const assetDurStr = framesToFcpTime(Math.max(1, maxEndFrames), frameDur);
  const seqDurStr = framesToFcpTime(totalSeqFrames, frameDur);
  const frameDurStr = `${frameDur.num}/${frameDur.den}s`;
  const formatName = `FFVideoFormat${width}x${height}p${frameDur.fpsTag}`;

  let offsetFrames = 0;
  const clipLines = quantized.map((seg, idx) => {
    const offsetStr = framesToFcpTime(offsetFrames, frameDur);
    const startStr = framesToFcpTime(seg.startFrames, frameDur);
    const durStr = framesToFcpTime(seg.durFrames, frameDur);
    offsetFrames += seg.durFrames;
    const name = escapeXml(`${clipBaseName} #${idx + 1}`);
    return `            <asset-clip ref="r2" offset="${offsetStr}" name="${name}" start="${startStr}" duration="${durStr}" tcFormat="NDF" audioRole="dialogue"/>`;
  });

  const assetAttrs = [
    `id="r2"`,
    `name="${escapeXml(sourceName)}"`,
    `start="0s"`,
    `duration="${assetDurStr}"`,
    `hasVideo="${input.hasVideo ? "1" : "0"}"`,
    `format="r1"`,
    `hasAudio="${input.hasAudio ? "1" : "0"}"`,
    ...(input.hasAudio ? [`audioSources="1"`, `audioChannels="${audioChannels}"`, `audioRate="${audioRate}"`] : []),
  ].join(" ");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE fcpxml>`,
    `<fcpxml version="1.10">`,
    `  <resources>`,
    `    <format id="r1" name="${escapeXml(formatName)}" frameDuration="${frameDurStr}" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)"/>`,
    `    <asset ${assetAttrs}>`,
    `      <media-rep kind="original-media" src="${escapeXml(sourceUrl)}"/>`,
    `    </asset>`,
    `  </resources>`,
    `  <library>`,
    `    <event name="${escapeXml(projectName)}">`,
    `      <project name="${escapeXml(projectName)}">`,
    `        <sequence format="r1" duration="${seqDurStr}" tcStart="0s" tcFormat="NDF" audioLayout="${audioChannels === 1 ? "mono" : "stereo"}" audioRate="${audioRate === 44100 ? "44.1k" : "48k"}">`,
    `          <spine>`,
    ...clipLines,
    `          </spine>`,
    `        </sequence>`,
    `      </project>`,
    `    </event>`,
    `  </library>`,
    `</fcpxml>`,
    "",
  ].join("\n");
}
