/**
 * 「去气口」独立工作台：
 * 默认免 ASR 转写，直接基于全片音频峰值 + Silero VAD 绘制可缩放交互波形；
 * 支持 3 档预设、4 个实时滑块、单击切换单段保留/剪除、Shift 框选手动删减、
 * 跳红段实时试听、可选口头禅辅助，以及三路无字幕导出（剪映草稿 / FCPXML / 干净原画幅 MP4）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LuFilm,
  LuFolderOpen,
  LuLayers,
  LuLoaderCircle,
  LuRotateCcw,
  LuScissors,
  LuShieldCheck,
  LuSparkles,
  LuVolume2,
  LuZoomIn,
  LuZoomOut,
} from "react-icons/lu";
import { useT } from "../../i18n/store";
import { getApi, isElectron } from "../../api/provider";
import { useSession } from "../../stores/session-store";
import { useRenderPrefs } from "../../stores/render-prefs-store";
import { PreviewPane, type PreviewTransportCommand } from "./PreviewPane";
import {
  BREATH_CUT_PRESETS,
  computeBreathCutPlan,
  type BreathCutExtraCut,
  type BreathCutParams,
  type BreathCutPresetId,
  type BreathCutRegion,
  type SilenceAnalysisData,
  type TimeSpan,
} from "../../../../shared/silence-cut";

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
}

function formatShortSec(sec: number): string {
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return formatClock(sec);
}

const CANVAS_HEIGHT = 176;
const RULER_HEIGHT = 22;

export function BreathCutWorkspace({
  filePath,
  hasVideo,
  durationSec,
  defaultOutDir,
  transportCommand,
  onExportMp4,
}: {
  filePath: string;
  hasVideo: boolean;
  durationSec: number;
  defaultOutDir: string;
  transportCommand?: PreviewTransportCommand | null;
  onExportMp4: (keptSegments: TimeSpan[]) => void;
}): React.JSX.Element {
  const t = useT("workbench");
  const { transcript, setTranscript } = useSession();
  const { prefs, setPref } = useRenderPrefs();

  const [analysis, setAnalysis] = useState<SilenceAnalysisData | null>(null);
  const [analyzing, setAnalyzing] = useState(true);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const [preset, setPreset] = useState<BreathCutPresetId | "custom">("natural");
  const [params, setParams] = useState<BreathCutParams>({ ...BREATH_CUT_PRESETS.natural });
  const [previewSkip, setPreviewSkip] = useState(true);
  const [restoredKeys, setRestoredKeys] = useState<Set<string>>(() => new Set());
  const [manualCuts, setManualCuts] = useState<BreathCutExtraCut[]>([]);

  // 可选口头禅辅助（默认完全关闭，点击后按需转写）
  const [fillersEnabled, setFillersEnabled] = useState(false);
  const [fillersLoading, setFillersLoading] = useState(false);
  const [fillerProgressPct, setFillerProgressPct] = useState<number | null>(null);
  const [fillerCuts, setFillerCuts] = useState<BreathCutExtraCut[]>([]);
  const [fillerError, setFillerError] = useState<string | null>(null);

  // 播放器与波形交互状态
  const [seekSec, setSeekSec] = useState(Number.NaN);
  const [currentSec, setCurrentSec] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [viewportWidth, setViewportWidth] = useState(860);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; text: string } | null>(null);
  const [dragSelection, setDragSelection] = useState<{ startSec: number; endSec: number } | null>(null);

  // 导出工程反馈与剪映默认目录探测
  const [jianyingDefaultDir, setJianyingDefaultDir] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState<"jianying" | "fcpxml" | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string; path?: string; isDir?: boolean } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragOriginSecRef = useRef<number | null>(null);

  const effectiveDuration = analysis?.durationSec || durationSec;

  const seek = useCallback((sec: number): void => {
    setSeekSec(Math.max(0, Math.min(effectiveDuration || 0, sec)) + Math.random() * 1e-6);
  }, [effectiveDuration]);

  // 自动探测本机剪映草稿目录
  useEffect(() => {
    void getApi().detectJianyingDraftDir().then(setJianyingDefaultDir).catch(() => {});
  }, []);

  // 载入/切换文件时免转写直接做声学分析
  const loadAnalysis = useCallback(async () => {
    setAnalyzing(true);
    setAnalyzeError(null);
    setNotice(null);
    setRestoredKeys(new Set());
    setManualCuts([]);
    setFillerCuts([]);
    setFillersEnabled(false);
    setFillerError(null);
    try {
      const data = await getApi().analyzeBreathCut(filePath);
      setAnalysis(data);
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }, [filePath]);

  useEffect(() => {
    void loadAnalysis();
  }, [loadAnalysis]);

  // 监听波形容器宽度变化
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const updateWidth = (): void => {
      if (el.clientWidth > 0) setViewportWidth(el.clientWidth);
    };
    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, [analyzing]);

  // 汇总附加剪除项（手动框选 + 可选口头禅）
  const extraCuts = useMemo(
    () => (fillersEnabled ? [...manualCuts, ...fillerCuts] : manualCuts),
    [fillersEnabled, manualCuts, fillerCuts]
  );

  // 实时计算去气口方案（纯函数 < 2ms）
  const plan = useMemo(() => {
    if (!analysis) return null;
    return computeBreathCutPlan(analysis, params, { restoredKeys, extraCuts });
  }, [analysis, params, restoredKeys, extraCuts]);

  const applyPreset = (id: BreathCutPresetId): void => {
    setPreset(id);
    setParams({ ...BREATH_CUT_PRESETS[id] });
    setRestoredKeys(new Set());
  };

  const patchParams = (patch: Partial<BreathCutParams>): void => {
    setPreset("custom");
    setParams((prev) => ({ ...prev, ...patch }));
  };

  const toggleRegionRestored = useCallback((region: BreathCutRegion): void => {
    if (region.kind === "manual") {
      setManualCuts((prev) => prev.filter((item) => item.key !== region.key));
      return;
    }
    setRestoredKeys((prev) => {
      const next = new Set(prev);
      if (next.has(region.key)) next.delete(region.key);
      else next.add(region.key);
      return next;
    });
  }, []);

  // 可选：按需启用口头禅（嗯/呃）检测
  const toggleFillers = async (): Promise<void> => {
    if (fillersLoading) {
      getApi().cancelTranscribe();
      return;
    }
    if (fillersEnabled) {
      setFillersEnabled(false);
      return;
    }
    setFillerError(null);
    // 若当前已有转写或已经提取过口头禅，直接秒开
    if (fillerCuts.length > 0) {
      setFillersEnabled(true);
      return;
    }
    if (transcript) {
      setFillersLoading(true);
      try {
        const cuts = await getApi().detectBreathCutFillers(transcript);
        setFillerCuts(cuts);
        setFillersEnabled(true);
      } catch (err) {
        setFillerError(err instanceof Error ? err.message : String(err));
      } finally {
        setFillersLoading(false);
      }
      return;
    }

    // 尚未转写：在后台静默跑本地 SenseVoice，完成后直接提取口头禅叠到波形上
    setFillersLoading(true);
    setFillerProgressPct(0);
    const off = getApi().onTranscribeProgress((p) => {
      if (p.stage === "transcribing" || p.stage === "downloading-model") {
        setFillerProgressPct(Math.round((p.fraction || 0) * 100));
      }
    });
    try {
      const tr = await getApi().transcribeMedia(filePath, "sensevoice");
      setTranscript(tr);
      const cuts = await getApi().detectBreathCutFillers(tr);
      setFillerCuts(cuts);
      setFillersEnabled(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancel/i.test(msg)) setFillerError(msg);
    } finally {
      off();
      setFillersLoading(false);
      setFillerProgressPct(null);
    }
  };

  // Canvas 实际像素宽度
  const canvasCssWidth = Math.max(viewportWidth, Math.round(viewportWidth * zoom));

  // 绘制高清交互波形
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analysis || !plan || effectiveDuration <= 0) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(canvasCssWidth * dpr);
    canvas.height = Math.round(CANVAS_HEIGHT * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);

    const w = canvasCssWidth;
    const h = CANVAS_HEIGHT;
    const waveTop = RULER_HEIGHT;
    const waveH = h - RULER_HEIGHT;
    const midY = waveTop + waveH / 2;
    const timeToX = (sec: number): number => (sec / effectiveDuration) * w;

    // 背景
    ctx.fillStyle = "#121318";
    ctx.fillRect(0, 0, w, h);

    // 刻度尺背景
    ctx.fillStyle = "#181a21";
    ctx.fillRect(0, 0, w, RULER_HEIGHT);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT - 0.5);
    ctx.lineTo(w, RULER_HEIGHT - 0.5);
    ctx.stroke();

    // 刻度线与时间文字
    const pxPerSec = w / effectiveDuration;
    const stepCandidates = [1, 2, 5, 10, 15, 30, 60, 120, 300];
    const stepSec = stepCandidates.find((s) => s * pxPerSec >= 72) ?? 300;
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    for (let sec = 0; sec <= effectiveDuration; sec += stepSec) {
      const x = Math.round(timeToX(sec)) + 0.5;
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT - 6);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.stroke();
      ctx.fillText(formatClock(sec), x + 4, RULER_HEIGHT / 2);
    }

    // 中轴基准线
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    // 绘制候选剪除区域（红=气口/首尾/手动，橙=口头禅，淡绿虚线=已手动恢复保留）
    for (const r of plan.regions) {
      const x0 = timeToX(r.startSec);
      const x1 = timeToX(r.endSec);
      const rw = Math.max(2, x1 - x0);
      if (r.restored) {
        ctx.fillStyle = "rgba(52, 211, 153, 0.10)";
        ctx.fillRect(x0, waveTop, rw, waveH);
        ctx.strokeStyle = "rgba(52, 211, 153, 0.55)";
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x0 + 0.5, waveTop + 1, Math.max(1, rw - 1), waveH - 2);
        ctx.setLineDash([]);
      } else if (r.kind === "filler") {
        ctx.fillStyle = "rgba(251, 146, 60, 0.28)";
        ctx.fillRect(x0, waveTop, rw, waveH);
        ctx.fillStyle = "rgba(251, 146, 60, 0.85)";
        ctx.fillRect(x0, waveTop, rw, 2.5);
      } else {
        ctx.fillStyle = r.kind === "manual" ? "rgba(244, 63, 94, 0.32)" : "rgba(239, 68, 68, 0.24)";
        ctx.fillRect(x0, waveTop, rw, waveH);
        ctx.fillStyle = "rgba(248, 113, 113, 0.82)";
        ctx.fillRect(x0, waveTop, rw, 2.5);
      }
    }

    // 绘制音频波形柱（逐列取最大峰，保证缩放时依然锐利不模糊）
    const peaks = analysis.peaks;
    if (peaks.length > 0) {
      const cols = Math.max(1, Math.floor(w / 2));
      const barWidth = 1.5;
      let cutIdx = 0;
      const activeCuts = plan.activeCuts;

      for (let col = 0; col < cols; col++) {
        const x = col * 2;
        const t0 = (x / w) * effectiveDuration;
        const t1 = ((x + 2) / w) * effectiveDuration;
        const i0 = Math.max(0, Math.floor(t0 / analysis.hopSec));
        const i1 = Math.min(peaks.length - 1, Math.ceil(t1 / analysis.hopSec));
        let peak = 0;
        for (let i = i0; i <= i1; i++) {
          if (peaks[i] > peak) peak = peaks[i];
        }
        while (cutIdx < activeCuts.length && activeCuts[cutIdx].endSec <= t0) cutIdx++;
        const inCut =
          cutIdx < activeCuts.length &&
          activeCuts[cutIdx].startSec < t1 &&
          activeCuts[cutIdx].endSec > t0;

        const amp = Math.max(1.5, Math.min(waveH * 0.44, Math.pow(peak, 0.72) * waveH * 0.46));
        ctx.fillStyle = inCut ? "rgba(252, 165, 165, 0.42)" : "rgba(244, 244, 245, 0.78)";
        ctx.fillRect(x, midY - amp, barWidth, amp * 2);
      }
    }

    // Shift 手动框选高亮
    if (dragSelection && Math.abs(dragSelection.endSec - dragSelection.startSec) > 0.05) {
      const sx = timeToX(Math.min(dragSelection.startSec, dragSelection.endSec));
      const ex = timeToX(Math.max(dragSelection.startSec, dragSelection.endSec));
      ctx.fillStyle = "rgba(244, 63, 94, 0.35)";
      ctx.fillRect(sx, waveTop, ex - sx, waveH);
      ctx.strokeStyle = "#fb7185";
      ctx.strokeRect(sx + 0.5, waveTop + 0.5, ex - sx - 1, waveH - 1);
    }

    // 当前播放头
    const playX = Math.round(timeToX(currentSec)) + 0.5;
    ctx.strokeStyle = "#ff6a2b";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(playX, 0);
    ctx.lineTo(playX, h);
    ctx.stroke();

    ctx.fillStyle = "#ff6a2b";
    ctx.beginPath();
    ctx.moveTo(playX - 5, 0);
    ctx.lineTo(playX + 5, 0);
    ctx.lineTo(playX, 7);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }, [analysis, plan, canvasCssWidth, effectiveDuration, currentSec, dragSelection]);

  const xToTime = (clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas || effectiveDuration <= 0) return 0;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * effectiveDuration;
  };

  const findRegionAt = (sec: number): BreathCutRegion | undefined => {
    if (!plan) return undefined;
    // 扩大一点点击命中容差（至少 5px 对应的时间）
    const tolSec = Math.max(0.06, (5 / canvasCssWidth) * effectiveDuration);
    return plan.regions.find((r) => sec >= r.startSec - tolSec && sec <= r.endSec + tolSec);
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (!plan || effectiveDuration <= 0) return;
    const sec = xToTime(e.clientX);
    if (e.shiftKey) {
      dragOriginSecRef.current = sec;
      setDragSelection({ startSec: sec, endSec: sec });
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    // 点击顶部刻度尺始终只跳播；点击波形区且命中气口块则切换该段保留/剪除
    if (y >= RULER_HEIGHT) {
      const hit = findRegionAt(sec);
      if (hit) {
        toggleRegionRestored(hit);
        seek(Math.max(0, hit.startSec - 0.8));
        return;
      }
    }
    seek(sec);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (!plan || effectiveDuration <= 0) return;
    const sec = xToTime(e.clientX);
    if (dragOriginSecRef.current !== null) {
      setDragSelection({ startSec: dragOriginSecRef.current, endSec: sec });
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const hit = y >= RULER_HEIGHT ? findRegionAt(sec) : undefined;
    if (hit) {
      const dur = (hit.endSec - hit.startSec).toFixed(2);
      const kindLabel =
        hit.kind === "edge"
          ? t("breathCutKindEdge")
          : hit.kind === "filler"
            ? `${t("breathCutKindFiller")}${hit.label ? `「${hit.label}」` : ""}`
            : hit.kind === "manual"
              ? t("breathCutKindManual")
              : t("breathCutKindSilence");
      const actionTip = hit.kind === "manual"
        ? t("breathCutClickRemoveManual")
        : hit.restored
          ? t("breathCutClickCutAgain")
          : t("breathCutClickKeep");
      setHoverInfo({
        x: e.clientX - rect.left,
        text: `${kindLabel} ${dur}s · ${actionTip}`,
      });
    } else {
      setHoverInfo(null);
    }
  };

  const finishDrag = (): void => {
    if (dragOriginSecRef.current !== null && dragSelection) {
      const startSec = Math.min(dragSelection.startSec, dragSelection.endSec);
      const endSec = Math.max(dragSelection.startSec, dragSelection.endSec);
      if (endSec - startSec >= 0.12) {
        setManualCuts((prev) => [
          ...prev,
          {
            key: `manual:${Date.now()}-${Math.round(startSec * 100)}`,
            startSec,
            endSec,
            kind: "manual",
          },
        ]);
      }
    }
    dragOriginSecRef.current = null;
    setDragSelection(null);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom((z) => {
        const next = e.deltaY < 0 ? z * 1.25 : z / 1.25;
        return Math.max(1, Math.min(16, Number(next.toFixed(2))));
      });
    }
  };

  // 导出剪映草稿（1 秒无损）
  const handleExportJianying = async (toDefaultDir: boolean): Promise<void> => {
    if (!plan || plan.keptSegments.length === 0 || exportBusy) return;
    setExportBusy("jianying");
    setNotice(null);
    try {
      const res = await getApi().exportBreathCutJianying(filePath, plan.keptSegments, {
        toDefaultDir,
      });
      if (res) {
        setNotice({
          kind: "ok",
          text: res.inJianyingDir
            ? t("breathCutJianyingDirectDone", { n: res.segments })
            : t("breathCutJianyingDone", { n: res.segments }),
          path: res.path,
          isDir: true,
        });
      }
    } catch (err) {
      setNotice({
        kind: "err",
        text: t("breathCutExportFailed", { msg: err instanceof Error ? err.message : String(err) }),
      });
    } finally {
      setExportBusy(null);
    }
  };

  // 导出 Final Cut Pro FCPXML（1 秒无损）
  const handleExportFcpxml = async (): Promise<void> => {
    if (!plan || plan.keptSegments.length === 0 || exportBusy) return;
    setExportBusy("fcpxml");
    setNotice(null);
    try {
      const res = await getApi().exportBreathCutFcpxml(filePath, plan.keptSegments);
      if (res) {
        setNotice({
          kind: "ok",
          text: t("breathCutFcpxmlDone", { n: res.segments }),
          path: res.path,
          isDir: false,
        });
      }
    } catch (err) {
      setNotice({
        kind: "err",
        text: t("breathCutExportFailed", { msg: err instanceof Error ? err.message : String(err) }),
      });
    } finally {
      setExportBusy(null);
    }
  };

  const stepRegion = (dir: 1 | -1): void => {
    if (!plan || plan.regions.length === 0) return;
    const list = plan.regions;
    if (dir > 0) {
      const next = list.find((r) => r.startSec > currentSec + 0.15) ?? list[0];
      seek(Math.max(0, next.startSec - 0.6));
    } else {
      const prev = [...list].reverse().find((r) => r.startSec < currentSec - 0.8) ?? list[list.length - 1];
      seek(Math.max(0, prev.startSec - 0.6));
    }
  };

  const toggleCls = (on: boolean): string =>
    `inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors ${
      on ? "border-ember/50 bg-ember/12 text-ember" : "border-line text-mut hover:border-mut hover:text-fg"
    }`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        {/* 1. 全宽原画幅监视器（彻底去掉右侧 9:16 竖屏预览干扰，支持跳红段试听） */}
        <PreviewPane
          hasVideo={hasVideo}
          filePath={filePath}
          durationSec={effectiveDuration}
          seekSec={seekSec}
          onTime={setCurrentSec}
          onPrevCandidate={() => stepRegion(-1)}
          onNextCandidate={() => stepRegion(1)}
          transportCommand={transportCommand}
          hideVertical
          skipRanges={previewSkip && plan ? plan.activeCuts : undefined}
        />

        {/* 2. 主去气口波形面板 */}
        {analyzing ? (
          <div className="flex min-h-[240px] flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-line/70 bg-panel/70 p-6">
            <LuLoaderCircle className="h-6 w-6 animate-spin text-ember" />
            <p className="text-[12.5px] font-semibold text-fg">{t("breathCutAnalyzing")}</p>
            <p className="text-[11px] text-mut">{t("breathCutAnalyzingHint")}</p>
          </div>
        ) : analyzeError || !analysis || !plan ? (
          <div className="flex min-h-[220px] flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-line/70 bg-panel/70 p-6">
            <p className="max-w-lg text-center text-[12px] text-red-400">
              {t("breathCutAnalyzeFailed", { msg: analyzeError ?? "unknown" })}
            </p>
            <button
              type="button"
              onClick={() => void loadAnalysis()}
              className="btn-flame inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-semibold text-white"
            >
              <LuRotateCcw className="h-3.5 w-3.5" />
              {t("breathCutRetry")}
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 rounded-xl border border-line bg-panel/80 p-3">
            {/* 预设 + 快捷开关 + 缩放 */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 rounded-lg border border-line bg-panel-2/70 p-0.5 text-[11px] font-semibold">
                {(
                  [
                    ["tight", t("breathCutPresetTight")],
                    ["natural", t("breathCutPresetNatural")],
                    ["relaxed", t("breathCutPresetRelaxed")],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={preset === id}
                    onClick={() => applyPreset(id)}
                    className={`rounded-md px-2.5 py-1 transition-colors ${
                      preset === id ? "bg-ember/15 text-ember" : "text-mut hover:text-fg"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                aria-pressed={previewSkip}
                onClick={() => setPreviewSkip((v) => !v)}
                className={toggleCls(previewSkip)}
                title={t("breathCutPreviewSkipHint")}
              >
                <LuVolume2 className="h-3 w-3" />
                {t("breathCutPreviewSkip")}
              </button>

              <button
                type="button"
                aria-pressed={params.trimEdges}
                onClick={() => patchParams({ trimEdges: !params.trimEdges })}
                className={toggleCls(params.trimEdges)}
              >
                {t("breathCutTrimEdges")}
              </button>

              <button
                type="button"
                aria-pressed={params.useVad && analysis.vadSpans.length > 0}
                disabled={analysis.vadSpans.length === 0}
                onClick={() => patchParams({ useVad: !params.useVad })}
                title={analysis.vadSpans.length > 0 ? t("breathCutVadHint") : t("breathCutVadUnavailable")}
                className={`${toggleCls(params.useVad && analysis.vadSpans.length > 0)} disabled:cursor-not-allowed disabled:opacity-45`}
              >
                <LuShieldCheck className="h-3 w-3" />
                {t("breathCutVad")}
              </button>

              {/* 锦上添花：按需辅助删口头禅（默认不跑转写） */}
              <button
                type="button"
                aria-pressed={fillersEnabled}
                onClick={() => void toggleFillers()}
                title={t("breathCutFillersHint")}
                className={toggleCls(fillersEnabled)}
              >
                {fillersLoading ? (
                  <LuLoaderCircle className="h-3 w-3 animate-spin" />
                ) : (
                  <LuSparkles className="h-3 w-3" />
                )}
                {fillersLoading
                  ? t("breathCutFillersBusy", { pct: fillerProgressPct ?? 0 })
                  : fillersEnabled
                    ? t("breathCutFillersOn", { n: fillerCuts.length })
                    : t("breathCutFillersAdd")}
              </button>

              {manualCuts.length > 0 && (
                <button
                  type="button"
                  onClick={() => setManualCuts([])}
                  className="rounded-md border border-rose-400/35 bg-rose-400/10 px-2 py-1 text-[11px] font-semibold text-rose-200 hover:bg-rose-400/20"
                >
                  {t("breathCutClearManual", { n: manualCuts.length })}
                </button>
              )}

              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Zoom out"
                  onClick={() => setZoom((z) => Math.max(1, Number((z / 1.5).toFixed(2))))}
                  disabled={zoom <= 1}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-line text-mut hover:border-mut hover:text-fg disabled:opacity-35"
                >
                  <LuZoomOut className="h-3.5 w-3.5" />
                </button>
                <span className="min-w-10 text-center font-mono text-[11px] text-mut">{zoom.toFixed(1)}×</span>
                <button
                  type="button"
                  aria-label="Zoom in"
                  onClick={() => setZoom((z) => Math.min(16, Number((z * 1.5).toFixed(2))))}
                  disabled={zoom >= 16}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-line text-mut hover:border-mut hover:text-fg disabled:opacity-35"
                >
                  <LuZoomIn className="h-3.5 w-3.5" />
                </button>
                {zoom > 1 && (
                  <button
                    type="button"
                    onClick={() => setZoom(1)}
                    className="rounded-md border border-line px-2 py-1 text-[10.5px] text-mut hover:border-mut hover:text-fg"
                  >
                    {t("breathCutZoomReset")}
                  </button>
                )}
              </div>
            </div>

            {fillerError && (
              <p className="text-[11px] text-amber-300">{t("breathCutFillersFailed", { msg: fillerError })}</p>
            )}

            {/* 4 个精准实时微调滑块 */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-line/60 bg-panel-2/50 px-3 py-2 text-[11px] lg:grid-cols-4">
              <label className="flex flex-col gap-1">
                <span className="flex items-center justify-between text-mut">
                  <span>{t("breathCutMinSilence")}</span>
                  <span className="font-mono font-semibold text-fg">{params.minSilenceSec.toFixed(2)}s</span>
                </span>
                <input
                  type="range"
                  min={0.2}
                  max={1.5}
                  step={0.05}
                  value={params.minSilenceSec}
                  onChange={(e) => patchParams({ minSilenceSec: Number(e.target.value) })}
                  className="accent-[--color-ember]"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="flex items-center justify-between text-mut">
                  <span>{t("breathCutLeadPad")}</span>
                  <span className="font-mono font-semibold text-fg">{Math.round(params.leadPadSec * 1000)}ms</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={250}
                  step={10}
                  value={Math.round(params.leadPadSec * 1000)}
                  onChange={(e) => patchParams({ leadPadSec: Number(e.target.value) / 1000 })}
                  className="accent-[--color-ember]"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="flex items-center justify-between text-mut">
                  <span>{t("breathCutTrailPad")}</span>
                  <span className="font-mono font-semibold text-fg">{Math.round(params.trailPadSec * 1000)}ms</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={300}
                  step={10}
                  value={Math.round(params.trailPadSec * 1000)}
                  onChange={(e) => patchParams({ trailPadSec: Number(e.target.value) / 1000 })}
                  className="accent-[--color-ember]"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="flex items-center justify-between text-mut">
                  <span>{t("breathCutThreshold")}</span>
                  <span className="font-mono font-semibold text-fg">{Math.round(params.thresholdRatio * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={2}
                  max={24}
                  step={1}
                  value={Math.round(params.thresholdRatio * 100)}
                  onChange={(e) => patchParams({ thresholdRatio: Number(e.target.value) / 100 })}
                  className="accent-[--color-ember]"
                />
              </label>
            </div>

            {/* 可滚动缩放 Canvas 波形 */}
            <div className="relative flex flex-col gap-1.5">
              <div
                ref={scrollRef}
                onWheel={handleWheel}
                className="relative overflow-x-auto rounded-lg border border-line/80 bg-[#121318]"
              >
                <canvas
                  ref={canvasRef}
                  style={{ width: `${canvasCssWidth}px`, height: `${CANVAS_HEIGHT}px` }}
                  className="block cursor-crosshair select-none"
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={finishDrag}
                  onMouseLeave={() => {
                    setHoverInfo(null);
                    finishDrag();
                  }}
                />
                {hoverInfo && (
                  <div
                    className="pointer-events-none absolute top-7 z-10 -translate-x-1/2 rounded-md border border-line bg-panel/95 px-2 py-1 text-[10.5px] whitespace-nowrap text-fg shadow-lg"
                    style={{ left: `${Math.max(96, Math.min(canvasCssWidth - 96, hoverInfo.x))}px` }}
                  >
                    {hoverInfo.text}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-mut">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-red-500/60" />
                    {t("breathCutLegendCut")}
                  </span>
                  {fillersEnabled && (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-sm bg-orange-400/70" />
                      {t("breathCutLegendFiller")}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm border border-dashed border-emerald-400 bg-emerald-400/20" />
                    {t("breathCutLegendRestored")}
                  </span>
                </div>
                <span>{t("breathCutInteractHint")}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 3. 底部极简三路导出栏（剪映草稿 / Final Cut Pro FCPXML / 干净原画幅 MP4，零字幕） */}
      {plan && (
        <div className="export-dock flex-wrap gap-y-2">
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <span className="font-mono text-[12px] font-semibold text-fg">
              {formatClock(plan.originalSec)} → {formatClock(plan.keptSec)}
            </span>
            <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-amber-300">
              {t("breathCutSavedBadge", { n: plan.cutCount, saved: formatShortSec(plan.removedSec) })}
            </span>
          </div>

          <span className="dock-space" />

          {/* 音频整理开关（作用于导出 MP4） */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              aria-pressed={prefs.denoise}
              onClick={() => setPref({ denoise: !prefs.denoise })}
              className={toggleCls(prefs.denoise)}
            >
              {t("breathCutDenoise")}
            </button>
            <button
              type="button"
              aria-pressed={prefs.normalizeLoudness}
              onClick={() => setPref({ normalizeLoudness: !prefs.normalizeLoudness })}
              className={toggleCls(prefs.normalizeLoudness)}
            >
              {t("roughCutLoudness")}
            </button>
          </div>

          {/* 导出目录快捷显示（MP4 用） */}
          <span className="hidden max-w-40 shrink-0 items-center gap-1 text-[10.5px] text-mut/70 2xl:flex">
            <LuFolderOpen className="h-3 w-3 shrink-0" />
            <span className="truncate" title={prefs.outDir || defaultOutDir}>
              {(prefs.outDir || defaultOutDir || "…").split(/[\\/]/).slice(-2).join("/")}
            </span>
          </span>

          {/* 三路下游出口 */}
          <div className="flex flex-wrap items-center gap-1.5">
            {hasVideo && (
              <div className="inline-flex items-center">
                <button
                  type="button"
                  disabled={exportBusy !== null || plan.keptSegments.length === 0}
                  onClick={() => void handleExportJianying(Boolean(jianyingDefaultDir))}
                  title={jianyingDefaultDir ? t("breathCutJianyingDirectHint") : t("breathCutJianyingPickHint")}
                  className={`inline-flex shrink-0 items-center gap-1.5 border border-line bg-panel-2 px-2.5 py-2 text-[11.5px] font-semibold text-fg transition-colors hover:border-ember/50 hover:text-ember disabled:opacity-50 ${
                    jianyingDefaultDir ? "rounded-l-lg border-r-0" : "rounded-lg"
                  }`}
                >
                  <LuLayers className="h-3.5 w-3.5" />
                  {exportBusy === "jianying"
                    ? t("breathCutExporting")
                    : jianyingDefaultDir
                      ? t("breathCutExportJianyingDirect")
                      : t("breathCutExportJianying")}
                </button>
                {jianyingDefaultDir && (
                  <button
                    type="button"
                    disabled={exportBusy !== null || plan.keptSegments.length === 0}
                    onClick={() => void handleExportJianying(false)}
                    title={t("breathCutJianyingPickHint")}
                    className="rounded-r-lg border border-line bg-panel-2 px-1.5 py-2 text-[11px] text-mut transition-colors hover:border-ember/50 hover:text-fg disabled:opacity-50"
                  >
                    <LuFolderOpen className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}

            <button
              type="button"
              disabled={exportBusy !== null || plan.keptSegments.length === 0}
              onClick={() => void handleExportFcpxml()}
              title={t("breathCutFcpxmlHint")}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-[11.5px] font-semibold text-fg transition-colors hover:border-ember/50 hover:text-ember disabled:opacity-50"
            >
              <LuFilm className="h-3.5 w-3.5" />
              {exportBusy === "fcpxml" ? t("breathCutExporting") : t("breathCutExportFcpxml")}
            </button>

            <button
              type="button"
              disabled={plan.keptSegments.length === 0}
              onClick={() => onExportMp4(plan.keptSegments)}
              title={t("breathCutMp4Hint")}
              className="btn-flame inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-[12px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <LuScissors className="h-3.5 w-3.5" />
              {t("breathCutExportMp4")}
            </button>
          </div>

          {notice && (
            <div
              role="status"
              className={`flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-[11px] ${
                notice.kind === "ok"
                  ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                  : "border-red-400/30 bg-red-400/10 text-red-300"
              }`}
            >
              <span className="truncate">{notice.text}</span>
              {notice.path && isElectron() && (
                <button
                  type="button"
                  onClick={() =>
                    notice.isDir ? getApi().openFolder(notice.path!) : getApi().revealClip(notice.path!)
                  }
                  className="shrink-0 font-semibold underline underline-offset-2"
                >
                  {t("roughCutReveal")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
