/**
 * 精剪字幕工作流专属底部导出栏：
 * 面向 5～30 分钟口播/教程/Vlog——无需 AI 找爆点、保留原画幅、支持「仅导出完整原句 SRT」
 * （秒出不编码视频）与「导出精剪成片 + 对齐后的 SRT」（剔除划删句 + 自动裁首尾静音 + 剪气口）。
 */
import { useState } from "react";
import { LuFileText, LuFolderOpen, LuScissors } from "react-icons/lu";
import { useT } from "../../i18n/store";
import { getApi, isElectron } from "../../api/provider";
import { useSession } from "../../stores/session-store";
import { useRenderPrefs } from "../../stores/render-prefs-store";
import { summarizeRoughCut } from "../../../../shared/rough-cut";
import type { CaptionStyleChoice } from "../../../../shared/api-types";

export function RoughCutBar({
  defaultOutDir,
  durationSec,
  onExportVideo,
}: {
  defaultOutDir: string;
  durationSec: number;
  onExportVideo: () => void;
}): React.JSX.Element {
  const t = useT("workbench");
  const th = useT("highlights");
  const { file, transcript, excludedSegmentIds } = useSession();
  const { prefs, setPref } = useRenderPrefs();
  const [srtBusy, setSrtBusy] = useState(false);
  const [srtNotice, setSrtNotice] = useState<{ kind: "ok" | "err"; text: string; path?: string } | null>(null);

  if (!transcript || !file) return <></>;

  const summary = summarizeRoughCut(transcript, excludedSegmentIds, durationSec);
  const canExportVideo = summary.keptSegments > 0;

  const pickOutDir = async (): Promise<void> => {
    const dir = await getApi().selectDir();
    if (dir) setPref({ outDir: dir });
  };

  const handleExportSrt = async (): Promise<void> => {
    if (srtBusy) return;
    setSrtBusy(true);
    setSrtNotice(null);
    try {
      const saved = await getApi().exportSrtOnly(file.path, transcript);
      if (saved) {
        setSrtNotice({ kind: "ok", text: t("roughCutExportSrtDone", { n: saved.cues }), path: saved.path });
      }
    } catch (e) {
      setSrtNotice({ kind: "err", text: t("roughCutExportSrtFailed", { msg: e instanceof Error ? e.message : String(e) }) });
    } finally {
      setSrtBusy(false);
    }
  };

  const toggleCls = (on: boolean): string =>
    `inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors ${
      on ? "border-ember/50 bg-ember/12 text-ember" : "border-line text-mut hover:border-mut hover:text-fg"
    }`;

  return (
    <div className="export-dock flex-wrap gap-y-2">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold text-fg/90" title={t("roughCutAutoTrimHint")}>
          {t("roughCutSummary", { kept: summary.keptSegments, total: summary.totalSegments, sec: Math.round(summary.keptDurationSec) })}
        </span>
        {summary.excludedSegments > 0 && (
          <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-amber-300">
            {t("roughCutRemoved", { n: summary.excludedSegments, sec: Math.round(summary.excludedDurationSec) })}
          </span>
        )}
        <span className="hidden text-[10.5px] text-mut/80 xl:inline">{t("roughCutAutoTrimHint")}</span>
      </div>

      <span className="dock-space" />

      {/* 精剪常用开关：原画幅固定保留，不干扰切片模式偏好 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" aria-pressed={prefs.jumpCut} onClick={() => setPref({ jumpCut: !prefs.jumpCut })} className={toggleCls(prefs.jumpCut)}>
          {t("roughCutJumpCut")}
        </button>
        {prefs.jumpCut && (
          <button type="button" aria-pressed={prefs.keepBreath} onClick={() => setPref({ keepBreath: !prefs.keepBreath })} className={toggleCls(prefs.keepBreath)}>
            {t("roughCutKeepBreath")}
          </button>
        )}
        <button type="button" aria-pressed={prefs.cleanFillers} onClick={() => setPref({ cleanFillers: !prefs.cleanFillers })} className={toggleCls(prefs.cleanFillers)}>
          {t("roughCutFillers")}
        </button>
        <button type="button" aria-pressed={prefs.normalizeLoudness} onClick={() => setPref({ normalizeLoudness: !prefs.normalizeLoudness })} className={toggleCls(prefs.normalizeLoudness)}>
          {t("roughCutLoudness")}
        </button>
        <button type="button" aria-pressed={prefs.jianyingDraft} onClick={() => setPref({ jianyingDraft: !prefs.jianyingDraft })} className={toggleCls(prefs.jianyingDraft)}>
          {t("roughCutJianying")}
        </button>
        <label className="flex items-center gap-1 text-[11px] text-mut">
          <span className="sr-only">{t("roughCutCaptionsLabel")}</span>
          <select
            value={prefs.roughCutCaptionStyle}
            onChange={(e) => setPref({ roughCutCaptionStyle: e.target.value as CaptionStyleChoice })}
            className="rounded-lg border border-line bg-panel-2 px-2 py-1 text-[11px] font-semibold text-fg outline-none focus:border-ember/60"
          >
            <option value="none">{t("roughCutCaptionsNone")}</option>
            <option value="keyword">{t("roughCutCaptionsKeyword")}</option>
            <option value="minimal">{t("roughCutCaptionsMinimal")}</option>
            <option value="pop">{t("roughCutCaptionsPop")}</option>
            <option value="bubble">{t("roughCutCaptionsBubble")}</option>
          </select>
        </label>
      </div>

      <span className="hidden max-w-44 shrink-0 items-center gap-1 text-[10.5px] text-mut/70 2xl:flex">
        <LuFolderOpen className="h-3 w-3 shrink-0" />
        <span className="truncate" title={prefs.outDir || defaultOutDir}>
          {(prefs.outDir || defaultOutDir || "…").split(/[\\/]/).slice(-2).join("/")}
        </span>
        {isElectron() && (
          <button type="button" onClick={() => void pickOutDir()} className="shrink-0 font-semibold text-ember/80 underline-offset-2 hover:underline">
            {th("outDirChange")}
          </button>
        )}
      </span>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={srtBusy}
          title={t("roughCutExportSrtHint")}
          onClick={() => void handleExportSrt()}
          className="flex h-8.5 items-center gap-1.5 rounded-lg border border-line bg-panel-2 px-3 text-[12px] font-semibold whitespace-nowrap text-fg transition-colors hover:border-ember/50 hover:text-ember disabled:opacity-40"
        >
          <LuFileText className="h-3.5 w-3.5" />
          {t("roughCutExportSrt")}
        </button>
        <button
          type="button"
          disabled={!canExportVideo}
          title={canExportVideo ? t("roughCutExportVideoHint") : t("roughCutAllExcluded")}
          onClick={onExportVideo}
          className="btn-flame flex h-8.5 items-center gap-1.5 rounded-lg px-4 text-[12.5px] font-extrabold whitespace-nowrap text-white disabled:opacity-40"
        >
          <LuScissors className="h-4 w-4" />
          {t("roughCutExportVideo")}
        </button>
      </div>

      {srtNotice && (
        <div role="status" className={`flex w-full items-center gap-2 text-[11px] ${srtNotice.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>
          <span>{srtNotice.text}</span>
          {srtNotice.path && isElectron() && (
            <button type="button" onClick={() => getApi().revealClip(srtNotice.path!)} className="font-semibold underline">
              {t("roughCutReveal")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
