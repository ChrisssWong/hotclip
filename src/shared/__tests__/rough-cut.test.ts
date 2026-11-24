import { describe, expect, it } from "vitest";
import {
  buildRoughCutCandidate,
  summarizeRoughCut,
  ROUGH_CUT_HEAD_PAD_SEC,
  ROUGH_CUT_TAIL_PAD_SEC,
  ROUGH_CUT_SEAM_PAD_SEC,
} from "../rough-cut";
import type { Transcript } from "../api-types";

const transcript: Transcript = {
  language: "zh",
  engine: "paraformer-local",
  durationSec: 40,
  segments: [
    { id: 1, startSec: 3.0, endSec: 8.0, text: "大家好欢迎回来", words: [] },
    { id: 2, startSec: 8.5, endSec: 15.0, text: "哎呀这里说错了重来", words: [] },
    { id: 3, startSec: 16.0, endSec: 25.0, text: "今天聊一个实用技巧", words: [] },
    { id: 4, startSec: 26.0, endSec: 34.0, text: "点赞收藏下期见", words: [] },
  ],
};

describe("buildRoughCutCandidate", () => {
  it("无划删时自动裁掉首尾静音并保留整段", () => {
    const clip = buildRoughCutCandidate(transcript, 40, new Set(), "口播原片");
    expect(clip).not.toBeNull();
    expect(clip!.manualBounds).toBe(true);
    expect(clip!.pieces).toBeUndefined();
    expect(clip!.startSec).toBeCloseTo(3.0 - ROUGH_CUT_HEAD_PAD_SEC, 5);
    expect(clip!.endSec).toBeCloseTo(34.0 + ROUGH_CUT_TAIL_PAD_SEC, 5);
    expect(clip!.title).toBe("口播原片");
  });

  it("划删中间一句时自动拆成两段 pieces 且不串入被删句", () => {
    const clip = buildRoughCutCandidate(transcript, 40, new Set([2]), "口播原片");
    expect(clip).not.toBeNull();
    expect(clip!.pieces).toHaveLength(2);
    expect(clip!.pieces![0].startSec).toBeCloseTo(3.0 - ROUGH_CUT_HEAD_PAD_SEC, 5);
    expect(clip!.pieces![0].endSec).toBeCloseTo(8.0 + ROUGH_CUT_SEAM_PAD_SEC, 5);
    expect(clip!.pieces![1].startSec).toBeCloseTo(16.0 - ROUGH_CUT_SEAM_PAD_SEC, 5);
    expect(clip!.pieces![1].endSec).toBeCloseTo(34.0 + ROUGH_CUT_TAIL_PAD_SEC, 5);
    expect(clip!.text).not.toContain("说错了");
    expect(clip!.text).toContain("大家好欢迎回来");
    expect(clip!.text).toContain("点赞收藏下期见");
  });

  it("划删首句或尾句时自动推进边界且不越界", () => {
    const clip = buildRoughCutCandidate(transcript, 40, new Set([1, 4]), "精剪");
    expect(clip).not.toBeNull();
    expect(clip!.pieces).toBeUndefined();
    expect(clip!.startSec).toBeGreaterThanOrEqual(8.0);
    expect(clip!.endSec).toBeLessThanOrEqual(26.0);
  });

  it("全部划删或空逐句稿时返回 null", () => {
    expect(buildRoughCutCandidate(transcript, 40, new Set([1, 2, 3, 4]), "精剪")).toBeNull();
    expect(buildRoughCutCandidate({ ...transcript, segments: [] }, 40, new Set(), "精剪")).toBeNull();
  });
});

describe("summarizeRoughCut", () => {
  it("准确统计保留句数、划删句数与预计时长", () => {
    const summary = summarizeRoughCut(transcript, new Set([2]), 40);
    expect(summary.totalSegments).toBe(4);
    expect(summary.keptSegments).toBe(3);
    expect(summary.excludedSegments).toBe(1);
    expect(summary.excludedDurationSec).toBeCloseTo(6.5, 5);
    expect(summary.keptDurationSec).toBeGreaterThan(20);
  });
});
