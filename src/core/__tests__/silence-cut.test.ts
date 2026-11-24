import { describe, it, expect } from "vitest";
import {
  BREATH_CUT_PRESETS,
  computeBreathCutPlan,
  referencePeakLevel,
  type SilenceAnalysisData,
} from "../../shared/silence-cut";

function makeAnalysis(durationSec: number, activeRanges: Array<[number, number]>, vadRanges?: Array<[number, number]>): SilenceAnalysisData {
  const hopSec = 1 / 30;
  const count = Math.ceil(durationSec / hopSec);
  const peaks = new Array<number>(count).fill(0.01);
  for (let i = 0; i < count; i++) {
    const t = i * hopSec;
    if (activeRanges.some(([a, b]) => t >= a && t < b)) {
      peaks[i] = 0.65;
    }
  }
  return {
    durationSec,
    hopSec,
    peaks,
    vadSpans: (vadRanges ?? activeRanges).map(([startSec, endSec]) => ({ startSec, endSec })),
  };
}

describe("computeBreathCutPlan", () => {
  it("准确裁除首尾静音与中间长气口，并保留前后呼吸留白", () => {
    const analysis = makeAnalysis(20, [
      [2.0, 7.0],
      [9.5, 16.0],
    ]);
    const plan = computeBreathCutPlan(analysis, {
      ...BREATH_CUT_PRESETS.natural,
      minSilenceSec: 0.5,
      leadPadSec: 0.06,
      trailPadSec: 0.12,
      trimEdges: true,
      useVad: true,
    });

    expect(plan.keptSegments).toHaveLength(2);
    expect(plan.keptSegments[0].startSec).toBeCloseTo(1.94, 1);
    expect(plan.keptSegments[0].endSec).toBeCloseTo(7.12, 1);
    expect(plan.keptSegments[1].startSec).toBeCloseTo(9.44, 1);
    expect(plan.keptSegments[1].endSec).toBeCloseTo(16.12, 1);
    expect(plan.cutCount).toBe(3); // 片头 + 中间 + 片尾
    expect(plan.removedSec).toBeGreaterThan(7.5);
  });

  it("关闭裁首尾静音时仅剪中间气口", () => {
    const analysis = makeAnalysis(20, [
      [2.0, 7.0],
      [10.0, 16.0],
    ]);
    const plan = computeBreathCutPlan(analysis, {
      ...BREATH_CUT_PRESETS.natural,
      trimEdges: false,
    });

    expect(plan.keptSegments[0].startSec).toBe(0);
    expect(plan.keptSegments.at(-1)?.endSec).toBe(20);
    expect(plan.cutCount).toBe(1);
  });

  it("启用 VAD 人声保护时，轻声尾音不会被静音门限误切", () => {
    const analysis = makeAnalysis(10, [[1.0, 4.0]], [[1.0, 6.0]]);
    // 4.0~6.0 是极轻人声（peak 0.01，但 VAD 明确检测到人声）
    const withVad = computeBreathCutPlan(analysis, {
      ...BREATH_CUT_PRESETS.natural,
      useVad: true,
    });
    const withoutVad = computeBreathCutPlan(analysis, {
      ...BREATH_CUT_PRESETS.natural,
      useVad: false,
    });

    expect(withVad.keptSec).toBeGreaterThan(withoutVad.keptSec + 1.5);
  });

  it("支持单击恢复某段气口、叠加口头禅与手动删减区间", () => {
    const analysis = makeAnalysis(18, [
      [1.0, 6.0],
      [8.0, 15.0],
    ]);
    const base = computeBreathCutPlan(analysis, BREATH_CUT_PRESETS.natural);
    const middleSilence = base.regions.find((r) => r.kind === "silence");
    expect(middleSilence).toBeDefined();

    const adjusted = computeBreathCutPlan(analysis, BREATH_CUT_PRESETS.natural, {
      restoredKeys: new Set([middleSilence!.key]),
      extraCuts: [
        { key: "filler:300-340", startSec: 3.0, endSec: 3.4, kind: "filler", label: "嗯" },
        { key: "manual:1100-1200", startSec: 11.0, endSec: 12.0, kind: "manual" },
      ],
    });

    // 中间停顿被恢复后不再出现在 activeCuts，而新增了口头禅与手动剪段
    expect(adjusted.regions.find((r) => r.key === middleSilence!.key)?.restored).toBe(true);
    expect(adjusted.activeCuts.some((c) => Math.abs(c.startSec - 3.0) < 0.05)).toBe(true);
    expect(adjusted.activeCuts.some((c) => Math.abs(c.startSec - 11.0) < 0.05)).toBe(true);
  });

  it("全静音兜底保留全片，不输出空片段列表", () => {
    const silent: SilenceAnalysisData = {
      durationSec: 10,
      hopSec: 1 / 30,
      peaks: new Array(300).fill(0),
      vadSpans: [],
    };
    expect(referencePeakLevel(silent.peaks)).toBe(0);
    const plan = computeBreathCutPlan(silent, BREATH_CUT_PRESETS.natural);
    expect(plan.keptSegments).toEqual([{ startSec: 0, endSec: 10 }]);
    expect(plan.cutCount).toBe(0);
  });
});
