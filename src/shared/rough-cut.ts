/**
 * 精剪字幕工作流核心纯逻辑：
 * 根据逐句稿与用户划删的句子集合，自动裁掉首尾多余静音、合并相邻保留句为
 * 多段拼接区间（pieces），直接复用既有导出管线完成原画幅剪气口成片与对齐 SRT。
 */
import type { ClipPiece, HighlightCandidate, Transcript } from "./api-types";
import { clipDurationSec } from "./pieces";

/** 整片首尾自动裁静音时，首句前与末句后保留的自然气口余量（秒）。 */
export const ROUGH_CUT_HEAD_PAD_SEC = 0.15;
export const ROUGH_CUT_TAIL_PAD_SEC = 0.2;
/** 中间划删切口处保留的微小安全余量，避免切掉首尾辅音（且绝不越界进入被删句）。 */
export const ROUGH_CUT_SEAM_PAD_SEC = 0.08;

export interface RoughCutSummary {
  totalSegments: number;
  keptSegments: number;
  excludedSegments: number;
  excludedDurationSec: number;
  keptDurationSec: number;
}

/** 汇总当前精剪状态（保留句数、划删句数、预计时长）。 */
export function summarizeRoughCut(
  transcript: Transcript,
  excludedIds: ReadonlySet<number>,
  durationSec = transcript.durationSec
): RoughCutSummary {
  const totalSegments = transcript.segments.length;
  let keptSegments = 0;
  let excludedSegments = 0;
  let excludedDurationSec = 0;
  for (const seg of transcript.segments) {
    const dur = Math.max(0, seg.endSec - seg.startSec);
    if (excludedIds.has(seg.id)) {
      excludedSegments += 1;
      excludedDurationSec += dur;
    } else {
      keptSegments += 1;
    }
  }
  const candidate = buildRoughCutCandidate(transcript, durationSec, excludedIds, "roughcut");
  const keptDurationSec = candidate ? clipDurationSec(candidate) : 0;
  return {
    totalSegments,
    keptSegments,
    excludedSegments,
    excludedDurationSec,
    keptDurationSec,
  };
}

/**
 * 将逐句稿 + 划删集合构造为一条标准 HighlightCandidate（manualBounds=true）：
 * - 首尾自动裁掉多余静音（保留首前 0.15s、尾后 0.2s，夹在 [0, durationSec] 内）
 * - 被划删的句子作为硬切间隙，相邻保留句自动合并成连续 piece
 * - 全都被划删或无有效句子时返回 null
 */
export function buildRoughCutCandidate(
  transcript: Transcript,
  durationSec: number,
  excludedIds: ReadonlySet<number>,
  title: string
): HighlightCandidate | null {
  const segs = transcript.segments;
  if (segs.length === 0) return null;
  const maxDur = Math.max(
    Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
    segs[segs.length - 1]?.endSec ?? 0
  );
  if (!(maxDur > 0)) return null;

  // 将连续未被划删的句子分组
  const groups: Array<{ firstIdx: number; lastIdx: number }> = [];
  for (let i = 0; i < segs.length; i++) {
    if (excludedIds.has(segs[i].id)) continue;
    const prev = groups[groups.length - 1];
    if (prev && prev.lastIdx === i - 1) prev.lastIdx = i;
    else groups.push({ firstIdx: i, lastIdx: i });
  }
  if (groups.length === 0) return null;

  const pieces: ClipPiece[] = [];
  const keptTexts: string[] = [];
  for (let g = 0; g < groups.length; g++) {
    const { firstIdx, lastIdx } = groups[g];
    const firstSeg = segs[firstIdx];
    const lastSeg = segs[lastIdx];
    const prevSeg = firstIdx > 0 ? segs[firstIdx - 1] : null;
    const nextSeg = lastIdx + 1 < segs.length ? segs[lastIdx + 1] : null;

    const headPad = g === 0 && !prevSeg ? ROUGH_CUT_HEAD_PAD_SEC : ROUGH_CUT_SEAM_PAD_SEC;
    const tailPad = g === groups.length - 1 && !nextSeg ? ROUGH_CUT_TAIL_PAD_SEC : ROUGH_CUT_SEAM_PAD_SEC;

    const lowerBound = prevSeg ? Math.min(firstSeg.startSec, prevSeg.endSec) : 0;
    const upperBound = nextSeg ? Math.max(lastSeg.endSec, nextSeg.startSec) : maxDur;

    const startSec = Math.max(lowerBound, Math.max(0, firstSeg.startSec - headPad));
    const endSec = Math.min(upperBound, Math.min(maxDur, lastSeg.endSec + tailPad));
    if (endSec <= startSec) continue;

    // 防重叠：若与上一段相接则合并，否则追加新段
    const prevPiece = pieces[pieces.length - 1];
    if (prevPiece && startSec <= prevPiece.endSec) {
      prevPiece.endSec = Math.max(prevPiece.endSec, endSec);
    } else {
      pieces.push({ startSec, endSec });
    }
    for (let i = firstIdx; i <= lastIdx; i++) {
      if (segs[i].text.trim()) keptTexts.push(segs[i].text.trim());
    }
  }
  if (pieces.length === 0) return null;

  const startSec = pieces[0].startSec;
  const endSec = pieces[pieces.length - 1].endSec;
  return {
    id: 1,
    startSec,
    endSec,
    pieces: pieces.length > 1 ? pieces : undefined,
    text: keptTexts.join(" "),
    title: title.trim() || "精剪成片",
    hook: "",
    score: 100,
    reason: "",
    boundary: "segment",
    keywords: [],
    recommended: true,
    reviewNote: "",
    manualBounds: true,
  };
}
