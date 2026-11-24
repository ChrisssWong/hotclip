/**
 * 「去气口」工作流后端服务：
 * 1. 全片声学峰值 + Silero VAD 人声区间分析（免 ASR 转写，带内存缓存）；
 * 2. 秒出无损剪映专业版草稿（自动探测本机剪映草稿目录，反链原片零重编码）；
 * 3. 秒出无损 Final Cut Pro FCPXML v1.10 工程（严格帧对齐，零重编码）；
 * 4. 可选口头禅（嗯/呃）检测辅助，供用户按需叠加到波形图。
 */
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractPeaks } from "./audio-peaks";
import { chunkSpeechRanges, PEAK_SPAN_MAX_SEC } from "./export";
import { buildFcpXml } from "./fcpxml";
import { findFillerWords } from "./fillers";
import { buildDraftContent, buildDraftMetaInfo } from "./jianying";
import { probeMedia } from "./probe";
import { detectSpeechActivity, normalizeSpeechSpans } from "./speech-activity";
import type { Transcript, TranscriptWord } from "../shared/api-types";
import type { BreathCutExtraCut, SilenceAnalysisData, TimeSpan } from "../shared/silence-cut";

const analysisCache = new Map<string, SilenceAnalysisData>();
const MAX_CACHE_ENTRIES = 4;

function sanitizeName(raw: string, fallback = "HotClip"): string {
  const cleaned = raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 80) || fallback;
}

/**
 * 免转写提取全片声学峰值轨与 Silero VAD 人声区间（支持最长 60 分钟）。
 * 若 Silero VAD 不可用或出错，自动静默降级为纯峰值（vadSpans = []）。
 */
export async function analyzeBreathCutAudio(
  filePath: string,
  modelsRoot: string,
  signal?: AbortSignal
): Promise<SilenceAnalysisData> {
  const fileStat = await stat(filePath);
  const cacheKey = `${filePath}|${fileStat.size}|${Math.floor(fileStat.mtimeMs)}`;
  const cached = analysisCache.get(cacheKey);
  if (cached) return cached;

  const info = await probeMedia(filePath);
  if (!info.hasAudio) {
    throw new Error("该媒体文件没有音轨，无法分析气口");
  }
  const durationSec = Math.min(info.durationSec, PEAK_SPAN_MAX_SEC);
  if (durationSec <= 0) {
    throw new Error("媒体时长无效");
  }

  const peakTrack = await extractPeaks(filePath, 0, durationSec, info.audioStreamIndex);
  signal?.throwIfAborted();

  let vadSpans: TimeSpan[] = [];
  if (modelsRoot) {
    try {
      const chunks = chunkSpeechRanges([{ startSec: 0, endSec: durationSec }], 180, PEAK_SPAN_MAX_SEC);
      const raw: TimeSpan[] = [];
      for (const chunk of chunks) {
        signal?.throwIfAborted();
        const spans = await detectSpeechActivity(
          filePath,
          chunk.startSec,
          chunk.endSec,
          modelsRoot,
          signal,
          info.audioStreamIndex
        );
        raw.push(...spans);
      }
      vadSpans = normalizeSpeechSpans(raw, 0, durationSec);
    } catch {
      // fail-open：VAD 模型缺失或出错时退化为纯峰值判定，不阻断波形去气口
      vadSpans = [];
    }
  }

  const result: SilenceAnalysisData = {
    durationSec,
    hopSec: peakTrack.hopSec,
    peaks: Array.from(peakTrack.values),
    vadSpans,
  };

  if (analysisCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = analysisCache.keys().next().value;
    if (oldestKey) analysisCache.delete(oldestKey);
  }
  analysisCache.set(cacheKey, result);
  return result;
}

/** 探测本机剪映专业版 / CapCut 默认草稿目录（存在且可写时返回绝对路径）。 */
export function detectJianyingDraftRoot(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const candidates: string[] = [];
  if (platform === "darwin") {
    candidates.push(
      path.join(homeDir, "Movies", "JianyingPro", "User Data", "Projects", "com.lveditor.draft"),
      path.join(homeDir, "Movies", "CapCut", "User Data", "Projects", "com.lveditor.draft")
    );
  } else if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
    candidates.push(
      path.join(localAppData, "JianyingPro", "User Data", "Projects", "com.lveditor.draft"),
      path.join(localAppData, "CapCut", "User Data", "Projects", "com.lveditor.draft")
    );
  }
  for (const dir of candidates) {
    try {
      accessSync(dir, fsConstants.W_OK);
      return dir;
    } catch {
      continue;
    }
  }
  return null;
}

/** 秒出无损剪映专业版草稿（纯保留段，不带任何字幕轨，零重编码）。 */
export async function writeBreathCutJianyingDraft(options: {
  filePath: string;
  segments: readonly TimeSpan[];
  targetParentDir: string;
}): Promise<{ path: string; segments: number }> {
  const validSegs = options.segments.filter((s) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec);
  if (validSegs.length === 0) {
    throw new Error("没有可导出的保留片段");
  }
  const info = await probeMedia(options.filePath);
  if (!info.hasVideo) {
    throw new Error("剪映草稿需要包含视频轨的媒体文件");
  }

  const stem = sanitizeName(path.basename(options.filePath, path.extname(options.filePath)), "HotClip");
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(4, 12);
  const draftName = `${stem}-去气口-${stamp}`;
  const draftDir = path.join(options.targetParentDir, draftName);
  await mkdir(draftDir, { recursive: true });

  const fps = info.fps > 0 ? Math.round(info.fps) : 30;
  const content = buildDraftContent({
    sourcePath: options.filePath,
    sourceName: path.basename(options.filePath),
    sourceDurationSec: info.durationSec,
    width: info.width,
    height: info.height,
    fps,
    clip: {
      title: draftName,
      segments: validSegs,
    },
  });

  const meta = buildDraftMetaInfo();
  const keptSec = validSegs.reduce((sum, s) => sum + (s.endSec - s.startSec), 0);
  meta.draft_name = draftName;
  meta.draft_fold_path = draftDir;
  meta.draft_root_path = options.targetParentDir;
  meta.tm_duration = Math.round(keptSec * 1_000_000);

  await writeFile(path.join(draftDir, "draft_content.json"), JSON.stringify(content, null, 2), "utf8");
  await writeFile(path.join(draftDir, "draft_meta_info.json"), JSON.stringify(meta, null, 2), "utf8");

  return { path: draftDir, segments: validSegs.length };
}

/** 秒出 Final Cut Pro 无损 FCPXML v1.10 工程文件。 */
export async function writeBreathCutFcpxml(options: {
  filePath: string;
  segments: readonly TimeSpan[];
  outputFilePath: string;
}): Promise<{ path: string; segments: number }> {
  const validSegs = options.segments.filter((s) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec);
  if (validSegs.length === 0) {
    throw new Error("没有可导出的保留片段");
  }
  const info = await probeMedia(options.filePath);
  const stem = sanitizeName(path.basename(options.filePath, path.extname(options.filePath)), "HotClip");
  const xml = buildFcpXml({
    projectName: `${stem}-去气口`,
    sourcePath: options.filePath,
    sourceDurationSec: info.durationSec,
    width: info.width,
    height: info.height,
    fps: info.fps,
    hasVideo: info.hasVideo,
    hasAudio: info.hasAudio,
    segments: validSegs,
  });

  await writeFile(options.outputFilePath, xml, "utf8");
  return { path: options.outputFilePath, segments: validSegs.length };
}

/** 从可选转写结果提取口头禅/口吃候选剪除区间，叠加到去气口波形图。 */
export function extractFillerExtraCuts(transcript: Transcript): BreathCutExtraCut[] {
  const words: TranscriptWord[] = transcript.segments
    .flatMap((seg) => (Array.isArray(seg.words) ? seg.words : []))
    .filter((w) => Number.isFinite(w.startSec) && Number.isFinite(w.endSec) && w.endSec > w.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  if (words.length === 0) return [];
  const hits = findFillerWords(words);
  const merged: BreathCutExtraCut[] = [];
  for (const h of hits) {
    const prev = merged[merged.length - 1];
    if (prev && h.startSec - prev.endSec < 0.08) {
      prev.endSec = Math.max(prev.endSec, h.endSec);
      prev.label = prev.label ? `${prev.label}/${h.text}` : h.text;
    } else {
      merged.push({
        key: `filler:${Math.round(h.startSec * 100)}-${Math.round(h.endSec * 100)}`,
        startSec: h.startSec,
        endSec: h.endSec,
        kind: "filler",
        label: h.text,
      });
    }
  }
  return merged;
}
