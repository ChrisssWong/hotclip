/**
 * 纯声学「去气口」规划算法（前后端共享，零外部依赖）：
 * 融合音频峰值包络 + Silero VAD 人声区间 + 人工微调覆写，毫秒级算出
 * 保留片段清单（keptSegments）与可视化待剪区间（cuts）。
 */

export interface TimeSpan {
  startSec: number;
  endSec: number;
}

export type BreathCutPresetId = "tight" | "natural" | "relaxed";

export interface BreathCutParams {
  /** 停顿超过此时长（秒）才判定为气口 */
  minSilenceSec: number;
  /** 说话开始前保留的缓冲（秒），防止吃字头 */
  leadPadSec: number;
  /** 说话结束后保留的缓冲（秒），防止截断尾音 */
  trailPadSec: number;
  /** 相对全片 95 分位声压的静音门限比例（0.02..0.28） */
  thresholdRatio: number;
  /** 是否自动裁除片头和片尾静音 */
  trimEdges: boolean;
  /** 是否启用 Silero VAD 人声保护 */
  useVad: boolean;
}

export const BREATH_CUT_PRESETS: Record<BreathCutPresetId, BreathCutParams> = {
  tight: {
    minSilenceSec: 0.3,
    leadPadSec: 0.04,
    trailPadSec: 0.08,
    thresholdRatio: 0.1,
    trimEdges: true,
    useVad: true,
  },
  natural: {
    minSilenceSec: 0.45,
    leadPadSec: 0.06,
    trailPadSec: 0.12,
    thresholdRatio: 0.08,
    trimEdges: true,
    useVad: true,
  },
  relaxed: {
    minSilenceSec: 0.75,
    leadPadSec: 0.08,
    trailPadSec: 0.18,
    thresholdRatio: 0.06,
    trimEdges: true,
    useVad: true,
  },
};

export interface SilenceAnalysisData {
  durationSec: number;
  hopSec: number;
  /** 归一化峰值（0..1），每秒约 30 格 */
  peaks: number[];
  /** Silero VAD 检测到的绝对人声区间；模型不可用或失败时为空数组 */
  vadSpans: TimeSpan[];
}

export type BreathCutKind = "edge" | "silence" | "filler" | "manual";

export interface BreathCutRegion {
  /** 稳定键，供用户点击单独保留/恢复使用 */
  key: string;
  startSec: number;
  endSec: number;
  kind: BreathCutKind;
  /** true = 用户手动保留了这段气口（不会被剪除） */
  restored: boolean;
  /** 可选标签（例如命中的口头禅原文） */
  label?: string;
}

export interface BreathCutExtraCut {
  key: string;
  startSec: number;
  endSec: number;
  kind: "filler" | "manual";
  label?: string;
}

export interface BreathCutPlan {
  keptSegments: TimeSpan[];
  /** 全部标出的候选剪除区间（含用户手动恢复保留的，供波形 UI 渲染） */
  regions: BreathCutRegion[];
  /** 实际将被剪除的区间（已排序、合并，供跳红段试听使用） */
  activeCuts: TimeSpan[];
  originalSec: number;
  keptSec: number;
  removedSec: number;
  cutCount: number;
}

const MIN_KEEP_SEGMENT_SEC = 0.06;
const MIN_GAP_TO_KEEP_SPLIT_SEC = 0.04;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 计算非零峰值的 95 分位作为本片参考电平，自适应不同录音音量。 */
export function referencePeakLevel(peaks: readonly number[]): number {
  const nonZero: number[] = [];
  for (let i = 0; i < peaks.length; i++) {
    const v = peaks[i];
    if (v > 1e-4) nonZero.push(v);
  }
  if (nonZero.length === 0) return 0;
  nonZero.sort((a, b) => a - b);
  const idx = Math.min(nonZero.length - 1, Math.floor(nonZero.length * 0.95));
  return nonZero[idx];
}

function mergeSpans(spans: TimeSpan[], mergeGapSec = 0): TimeSpan[] {
  const valid = spans
    .filter((s) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec)
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  const out: TimeSpan[] = [];
  for (const s of valid) {
    const prev = out[out.length - 1];
    if (prev && s.startSec <= prev.endSec + mergeGapSec) {
      prev.endSec = Math.max(prev.endSec, s.endSec);
    } else {
      out.push({ startSec: s.startSec, endSec: s.endSec });
    }
  }
  return out;
}

function subtractCuts(durationSec: number, cuts: TimeSpan[]): TimeSpan[] {
  const merged = mergeSpans(
    cuts.map((c) => ({
      startSec: clamp(c.startSec, 0, durationSec),
      endSec: clamp(c.endSec, 0, durationSec),
    })),
    0.001
  );
  const kept: TimeSpan[] = [];
  let cursor = 0;
  for (const c of merged) {
    if (c.startSec - cursor >= MIN_KEEP_SEGMENT_SEC) {
      kept.push({ startSec: cursor, endSec: c.startSec });
    }
    cursor = Math.max(cursor, c.endSec);
  }
  if (durationSec - cursor >= MIN_KEEP_SEGMENT_SEC) {
    kept.push({ startSec: cursor, endSec: durationSec });
  }
  return kept;
}

function cutKey(kind: BreathCutKind, startSec: number, endSec: number): string {
  return `${kind}:${Math.round(startSec * 20)}-${Math.round(endSec * 20)}`;
}

/**
 * 核心纯函数：根据声学峰值、Silero VAD 区间、用户参数、手动恢复集合和附加剪除项，
 * 计算完整去气口方案。耗时 < 2ms（针对 30 分钟音频），可直接响应滑块拖动。
 */
export function computeBreathCutPlan(
  analysis: SilenceAnalysisData,
  params: BreathCutParams,
  options: {
    restoredKeys?: ReadonlySet<string>;
    extraCuts?: readonly BreathCutExtraCut[];
  } = {}
): BreathCutPlan {
  const durationSec = Math.max(0, analysis.durationSec);
  if (durationSec <= 0) {
    return {
      keptSegments: [],
      regions: [],
      activeCuts: [],
      originalSec: 0,
      keptSec: 0,
      removedSec: 0,
      cutCount: 0,
    };
  }

  const minSilenceSec = clamp(params.minSilenceSec, 0.12, 3);
  const leadPadSec = clamp(params.leadPadSec, 0, 0.5);
  const trailPadSec = clamp(params.trailPadSec, 0, 0.5);
  const thresholdRatio = clamp(params.thresholdRatio, 0.015, 0.4);
  const restoredKeys = options.restoredKeys ?? new Set<string>();
  const extraCuts = options.extraCuts ?? [];

  const peaks = analysis.peaks;
  const hopSec = analysis.hopSec > 0 ? analysis.hopSec : 1 / 30;
  const refLevel = referencePeakLevel(peaks);
  const baseThreshold = Math.max(0.008, refLevel * thresholdRatio);
  const hasVad = params.useVad && analysis.vadSpans.length > 0;
  const vadSorted = hasVad ? mergeSpans(analysis.vadSpans, 0.04) : [];

  // 1. 构建初始有声区间
  let activeSpans: TimeSpan[] = [];
  if (peaks.length > 0 && refLevel > 0) {
    // 扫一遍 peaks + 双指针查 VAD，O(N) 线性时间
    const nonSpeechTransientThreshold = Math.max(baseThreshold * 2.4, refLevel * 0.22);
    let vadIdx = 0;
    let runStart = -1;

    for (let i = 0; i < peaks.length; i++) {
      const t0 = i * hopSec;
      const t1 = Math.min(durationSec, (i + 1) * hopSec);
      while (vadIdx < vadSorted.length && vadSorted[vadIdx].endSec <= t0) vadIdx++;
      const inVad =
        hasVad &&
        vadIdx < vadSorted.length &&
        vadSorted[vadIdx].startSec < t1 &&
        vadSorted[vadIdx].endSec > t0;

      const peak = peaks[i];
      const active = hasVad
        ? inVad || peak >= nonSpeechTransientThreshold
        : peak >= baseThreshold;

      if (active) {
        if (runStart < 0) runStart = t0;
      } else if (runStart >= 0) {
        activeSpans.push({ startSec: runStart, endSec: t0 });
        runStart = -1;
      }
    }
    if (runStart >= 0) {
      activeSpans.push({ startSec: runStart, endSec: durationSec });
    }
  } else if (hasVad) {
    activeSpans = vadSorted.map((s) => ({
      startSec: clamp(s.startSec, 0, durationSec),
      endSec: clamp(s.endSec, 0, durationSec),
    }));
  }

  // 若整条几乎全静音，兜底保留全片，避免导出空视频
  if (activeSpans.length === 0) {
    return {
      keptSegments: [{ startSec: 0, endSec: durationSec }],
      regions: [],
      activeCuts: [],
      originalSec: durationSec,
      keptSec: durationSec,
      removedSec: 0,
      cutCount: 0,
    };
  }

  // 2. 合并间隔小于 minSilenceSec 的相邻活跃段
  const mergedSpeech = mergeSpans(activeSpans, minSilenceSec);

  // 3. 施加前后呼吸留白（padding）并合并重叠段
  const padded: TimeSpan[] = mergedSpeech.map((seg, index) => {
    const startSec =
      !params.trimEdges && index === 0 ? 0 : Math.max(0, seg.startSec - leadPadSec);
    const endSec =
      !params.trimEdges && index === mergedSpeech.length - 1
        ? durationSec
        : Math.min(durationSec, seg.endSec + trailPadSec);
    return { startSec, endSec };
  });
  const baseKept = mergeSpans(padded, MIN_GAP_TO_KEEP_SPLIT_SEC);

  // 4. 由 baseKept 反推出所有自动气口与首尾静音区间
  const regions: BreathCutRegion[] = [];
  let cursor = 0;
  for (let i = 0; i < baseKept.length; i++) {
    const seg = baseKept[i];
    if (seg.startSec - cursor >= MIN_GAP_TO_KEEP_SPLIT_SEC) {
      const kind: BreathCutKind = i === 0 && cursor === 0 ? "edge" : "silence";
      // 若不裁首尾静音，跳过首尾段
      if (kind !== "edge" || params.trimEdges) {
        const key = cutKey(kind, cursor, seg.startSec);
        regions.push({
          key,
          startSec: cursor,
          endSec: seg.startSec,
          kind,
          restored: restoredKeys.has(key),
        });
      }
    }
    cursor = seg.endSec;
  }
  if (params.trimEdges && durationSec - cursor >= MIN_GAP_TO_KEEP_SPLIT_SEC) {
    const key = cutKey("edge", cursor, durationSec);
    regions.push({
      key,
      startSec: cursor,
      endSec: durationSec,
      kind: "edge",
      restored: restoredKeys.has(key),
    });
  }

  // 5. 叠加上层可选剪除项（口头禅 / 手动框选）
  for (const extra of extraCuts) {
    const startSec = clamp(extra.startSec, 0, durationSec);
    const endSec = clamp(extra.endSec, 0, durationSec);
    if (endSec - startSec < MIN_GAP_TO_KEEP_SPLIT_SEC) continue;
    regions.push({
      key: extra.key,
      startSec,
      endSec,
      kind: extra.kind,
      restored: restoredKeys.has(extra.key),
      label: extra.label,
    });
  }

  regions.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

  const activeCuts = mergeSpans(
    regions.filter((r) => !r.restored).map((r) => ({ startSec: r.startSec, endSec: r.endSec })),
    0.01
  );

  let keptSegments = subtractCuts(durationSec, activeCuts);
  if (keptSegments.length === 0) {
    keptSegments = [{ startSec: 0, endSec: durationSec }];
  }

  const keptSec = keptSegments.reduce((sum, s) => sum + (s.endSec - s.startSec), 0);
  const removedSec = Math.max(0, durationSec - keptSec);

  return {
    keptSegments,
    regions,
    activeCuts,
    originalSec: durationSec,
    keptSec,
    removedSec,
    cutCount: activeCuts.length,
  };
}
