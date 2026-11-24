import { useEffect, useState } from "react";
import { LuArrowUpRight, LuCircleArrowUp, LuLoaderCircle, LuShieldCheck, LuX } from "react-icons/lu";
import { useT } from "../i18n/store";
import { getApi } from "../api/provider";
import type { SelfUpdateCapability, SelfUpdateProgress, UpdateInfo } from "../../../shared/api-types";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SelfUpdateModal({
  update,
  capability,
  onClose,
}: {
  update: UpdateInfo;
  capability: SelfUpdateCapability;
  onClose: () => void;
}): React.JSX.Element {
  const tc = useT("common");
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<SelfUpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const off = getApi().onSelfUpdateProgress((p) => {
      setProgress(p);
    });
    return () => off();
  }, []);

  const stageLabel = (stage: SelfUpdateProgress["stage"]): string => {
    switch (stage) {
      case "checking":
        return tc("updateStageChecking");
      case "verifying":
        return tc("updateStageVerifying");
      case "downloading":
        return tc("updateStageDownloading");
      case "extracting":
        return tc("updateStageExtracting");
      case "installing":
        return tc("updateStageInstalling");
      case "restarting":
        return tc("updateStageRestarting");
    }
  };

  const startInstall = async (): Promise<void> => {
    setInstalling(true);
    setError(null);
    setProgress({ stage: "checking" });
    try {
      await getApi().selfUpdateInstall(update.latest);
    } catch (err) {
      const isAbort = err instanceof Error && (err.name === "AbortError" || /aborted|取消/i.test(err.message));
      setError(isAbort ? tc("updateCancelled") : err instanceof Error ? err.message : String(err));
      setInstalling(false);
      setProgress(null);
    }
  };

  const cancelOrClose = (): void => {
    if (installing) {
      getApi().cancelSelfUpdate();
      return;
    }
    onClose();
  };

  const pct =
    progress?.stage === "downloading" && typeof progress.fraction === "number"
      ? Math.round(progress.fraction * 100)
      : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="self-update-title"
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flame-gradient flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white">
              <LuCircleArrowUp className="h-5 w-5" />
            </div>
            <div>
              <h2 id="self-update-title" className="text-sm font-semibold text-fg">
                {tc("updateModalTitle", { v: update.latest })}
              </h2>
              <p className="mt-0.5 font-mono text-xs text-mut">
                {tc("updateModalVersion", { current: update.current, latest: update.latest })}
              </p>
            </div>
          </div>
          {!installing && (
            <button
              type="button"
              onClick={onClose}
              aria-label={tc("cancel")}
              className="rounded-md p-1 text-mut transition-colors hover:bg-panel-2 hover:text-fg"
            >
              <LuX className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="mt-4 space-y-3 text-xs leading-relaxed text-mut">
          {capability.supported ? (
            <div className="flex items-start gap-2 rounded-lg border border-emerald-400/20 bg-emerald-400/5 p-3 text-fg/90">
              <LuShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              <span>{tc("updateModalDesc")}</span>
            </div>
          ) : (
            <div className="space-y-1.5 rounded-lg border border-amber-400/25 bg-amber-400/5 p-3 text-amber-200/90">
              <p>{tc("updateUnsupportedHint")}</p>
              {capability.reason && <p className="text-amber-200">{capability.reason}</p>}
            </div>
          )}

          {installing && progress && (
            <div className="space-y-2 rounded-lg border border-line bg-panel-2/60 p-3">
              <div className="flex items-center justify-between gap-2 text-fg">
                <span className="flex items-center gap-2">
                  <LuLoaderCircle className="h-3.5 w-3.5 animate-spin text-ember" />
                  {stageLabel(progress.stage)}
                </span>
                {pct !== null && <span className="font-mono tabular-nums text-ember">{pct}%</span>}
              </div>
              {progress.stage === "downloading" && (
                <>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
                    <div
                      className="flame-gradient h-full transition-all duration-150"
                      style={{ width: `${pct ?? 0}%` }}
                    />
                  </div>
                  {typeof progress.downloadedBytes === "number" && (
                    <p className="font-mono text-[11px] tabular-nums text-mut">
                      {formatBytes(progress.downloadedBytes)}
                      {typeof progress.totalBytes === "number" && progress.totalBytes > 0
                        ? ` / ${formatBytes(progress.totalBytes)}`
                        : ""}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-lg border border-rose-400/30 bg-rose-400/10 p-3 text-rose-200">
              {error}
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => getApi().openUrl(update.url)}
            className="flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-xs text-mut transition-colors hover:border-mut hover:text-fg"
          >
            <span>{tc("updateOpenPage")}</span>
            <LuArrowUpRight className="h-3.5 w-3.5" />
          </button>

          {capability.supported ? (
            <>
              <button
                type="button"
                onClick={cancelOrClose}
                disabled={progress?.stage === "installing" || progress?.stage === "restarting"}
                className="rounded-md border border-line px-3 py-1.5 text-xs text-mut transition-colors hover:border-mut hover:text-fg disabled:opacity-40"
              >
                {tc("cancel")}
              </button>
              {!installing && (
                <button
                  type="button"
                  onClick={() => void startInstall()}
                  className="btn-flame rounded-md px-3.5 py-1.5 text-xs font-semibold"
                >
                  {error ? tc("updateRetry") : tc("updateNow")}
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-line px-3 py-1.5 text-xs text-mut transition-colors hover:border-mut hover:text-fg"
            >
              {tc("cancel")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
