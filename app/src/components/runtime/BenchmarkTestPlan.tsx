import { useTranslation } from "react-i18next";
import type { BenchmarkResult, BenchmarkSuiteDefinition } from "../../types/app";
import { Panel } from "../ui/Primitives";

export function BenchmarkTestPlan({ suite, runs, search, minimumQuality }: { suite?: BenchmarkSuiteDefinition; runs: number; search: boolean; minimumQuality: number }) {
  const { t } = useTranslation();
  if (!suite) return null;
  const tests = suite.kind === "throughput" ? ["throughput"] : suite.kind === "context_continuity" ? ["recall", "carryover", "compaction"] : ["recall", "compaction"];
  return <Panel className="benchmarkTestPlan"><h3>{t("benchmark.plan.title")}</h3><p>{search ? t("benchmark.plan.search") : `${t(suite.nameKey)} · ${runs} × ${suite.windowCount} ${t("benchmark.plan.windows")}`}</p><div>{(search ? ["throughput", "recall", "carryover", "compaction"] : tests).map(test => <article key={test}><strong>{t(`benchmark.plan.${test}.name`)}</strong><span>{t(`benchmark.plan.${test}.description`)}</span><small>{t(`benchmark.plan.${test}.score`, { threshold: Math.round((suite.minimumAccuracy ?? 0.95) * 100), max: (suite.checkpointMaxTokens ?? 500) + 100 })}</small></article>)}</div>{(search || suite.kind !== "throughput") && <p className="benchmarkHint">{t("benchmark.plan.targets", { threshold: minimumQuality })}</p>}</Panel>;
}

export function BenchmarkTestResults({ result }: { result: BenchmarkResult }) {
  const { t } = useTranslation();
  const ratio = (matches: number, total: number) => total ? `${matches}/${total} · ${(matches / total * 100).toFixed(0)}%` : "—";
  return <details className="benchmarkTestResults"><summary>{t("benchmark.plan.results")} · {result.profileName}</summary><div className="tableScroll"><table><thead><tr><th>{t("benchmark.plan.test")}</th><th>{t("benchmark.plan.result")}</th><th>{t("benchmark.plan.score")}</th></tr></thead><tbody>{result.suiteWindows?.length ? result.suiteWindows.map(window => <tr key={`${window.run}-${window.window}`}><td>{t("benchmark.live.position", { run: window.run, window: window.window })}</td><td>{t(`benchmark.windowStatus.${window.status}`, { defaultValue: window.status })}{window.failureReason && <small>{window.failureReason}</small>}</td><td>{t("benchmark.plan.recall.name")}: {ratio(window.currentMatches, window.currentTotal)}<br/>{t("benchmark.plan.carryover.name")}: {ratio(window.carryoverMatches, window.carryoverTotal)}<br/>{t("benchmark.plan.compaction.name")}: {ratio(window.checkpointMatches, window.checkpointTotal)} · {window.checkpointOutputTokens} tok</td></tr>) : result.samples.map((sample, index) => <tr key={index}><td>{sample.run} · {t(sample.phase === "compaction" ? "benchmark.plan.compaction.name" : sample.phase === "recall" ? "benchmark.plan.recall.name" : "benchmark.plan.throughput.name")}</td><td>{sample.generationTps.toFixed(1)} tok/s · {sample.totalMs.toFixed(0)} ms</td><td>{sample.qualityTotal != null ? ratio(sample.qualityMatches ?? 0, sample.qualityTotal) : t("benchmark.throughputOnly")}</td></tr>)}</tbody></table></div></details>;
}
