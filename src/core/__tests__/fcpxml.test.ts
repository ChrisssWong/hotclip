import { describe, it, expect } from "vitest";
import { buildFcpXml, framesToFcpTime, resolveFrameDuration, secToFrames } from "../fcpxml";

describe("FCPXML v1.10 无损工程生成", () => {
  it("准确映射 23.976 / 29.97 / 30 / 60 fps 的有理数 frameDuration", () => {
    expect(resolveFrameDuration(60)).toEqual({ num: 100, den: 6000, fpsTag: "60" });
    expect(resolveFrameDuration(59.94)).toEqual({ num: 1001, den: 60000, fpsTag: "5994" });
    expect(resolveFrameDuration(29.97)).toEqual({ num: 1001, den: 30000, fpsTag: "2997" });
    expect(resolveFrameDuration(23.976)).toEqual({ num: 1001, den: 24000, fpsTag: "2398" });
  });

  it("时间值严格对齐帧边界并简化整秒", () => {
    const f60 = resolveFrameDuration(60);
    expect(secToFrames(1.5, f60)).toBe(90);
    expect(framesToFcpTime(60, f60)).toBe("1s");
    expect(framesToFcpTime(90, f60)).toBe("9000/6000s");
    expect(framesToFcpTime(0, f60)).toBe("0s");
  });

  it("生成合法 4K 60fps FCPXML，正确转义中文/特殊字符且连续拼接 spine offset", () => {
    const xml = buildFcpXml({
      projectName: "V0.1 & 认知实验室",
      sourcePath: "/Users/demo/Videos/V0.1 认知&实验.mp4",
      sourceDurationSec: 766,
      width: 3840,
      height: 2160,
      fps: 60,
      hasVideo: true,
      hasAudio: true,
      segments: [
        { startSec: 2.0, endSec: 12.5 },
        { startSec: 14.0, endSec: 20.0 },
      ],
    });

    expect(xml).toContain('<fcpxml version="1.10">');
    expect(xml).toContain('frameDuration="100/6000s" width="3840" height="2160"');
    expect(xml).toContain('name="V0.1 &amp; 认知实验室"');
    expect(xml).toContain('src="file:///');
    // 第一段 offset=0s, start=2s, duration=10.5s (63000/6000s)
    expect(xml).toContain('offset="0s"');
    expect(xml).toContain('start="2s"');
    expect(xml).toContain('duration="63000/6000s"');
    // 第二段紧接 offset=63000/6000s, start=14s, duration=6s
    expect(xml).toContain('offset="63000/6000s"');
    expect(xml).toContain('start="14s"');
    expect(xml).toContain('duration="6s"');
    // 总时长 = 10.5 + 6 = 16.5s = 99000/6000s
    expect(xml).toContain('<sequence format="r1" duration="99000/6000s"');
  });
});
