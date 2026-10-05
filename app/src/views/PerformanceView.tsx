import { BenchmarkMonitor } from "../components/runtime/BenchmarkMonitor";
import { BenchmarkTestPlan, BenchmarkTestResults } from "../components/runtime/BenchmarkTestPlan";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BrainCircuit, Play } from "lucide-react";
import type { BenchmarkResult } from "../types/app";
import { useControlStore } from "../store/control";
import { Button, Input, Panel, SectionTitle } from "../components/ui/Primitives";
import { MINIMUM_AGENT_CONTEXT, DEFAULT_SEARCH_CONTEXT, MAXIMUM_SEARCH_CONTEXT } from "../lib/benchmarkOptimizer";

const formatMs = (value: number | null) => value == null ? "—" : `${value.toFixed(0)} ms`;

export function PerformanceView() {
  const { t, i18n } = useTranslation();
  const { benchmarks, benchmarkSuites, profiles, models, config, runningConfig, runtime, runBenchmark, runAutoTune, cancelAutoTune, applyOptimizerRecommendation, optimizerProgress, optimizerRecommendation, optimizerProfiles, optimizerRunning, busy, settings, runningMode, runningEngine, setView, selectProfile } = useControlStore();
  const [promptTokens, setPromptTokens] = useState(2048);
  const [generationTokens, setGenerationTokens] = useState(512);
  const [runs, setRuns] = useState(settings.benchmarkRuns);
  const [suiteId, setSuiteId] = useState("throughput-v1");
  const [objective, setObjective] = useState<"speed" | "quality" | "balanced">("balanced");
  const [minimumQualityPercent, setMinimumQualityPercent] = useState(95);
  const [minimumGenerationTps, setMinimumGenerationTps] = useState(0);
  const [requestedProfileId, setRequestedProfileId] = useState("");
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [autoSelectProfiles, setAutoSelectProfiles] = useState(false);
  const [minimumContextTokens, setMinimumContextTokens] = useState(MINIMUM_AGENT_CONTEXT);
  const [requestedMaximumContext, setRequestedMaximumContext] = useState<number>();
  const selectedProfileId = requestedProfileId || runningConfig?.profileId || config.profileId;
  const effectiveEngine = runningEngine ?? settings.serverEngine;
  const searchConfig = profiles.find(profile => profile.id === selectedProfileId)?.config ?? runningConfig ?? config;
  const modelContext = models.find(model => model.path.toLowerCase().replaceAll("\\", "/") === searchConfig.modelPath.toLowerCase().replaceAll("\\", "/"))?.contextLength;
  const maximumContextTokens = requestedMaximumContext ?? Math.min(MAXIMUM_SEARCH_CONTEXT, modelContext && modelContext > 0 ? modelContext : Math.max(searchConfig.ctxSize, DEFAULT_SEARCH_CONTEXT));
  const useProfileSearch = autoSelectProfiles && effectiveEngine === "llama_cpp";
  const invalidSearchRange = !Number.isInteger(minimumContextTokens) || minimumContextTokens < MINIMUM_AGENT_CONTEXT
    || !Number.isInteger(maximumContextTokens) || maximumContextTokens < minimumContextTokens || maximumContextTokens > MAXIMUM_SEARCH_CONTEXT;
  const selectedSuite = benchmarkSuites.find(suite => suite.id === suiteId);
  const isQualitySuite = selectedSuite?.kind !== "throughput";
  const isOllama = (runningEngine ?? settings.serverEngine) === "ollama";
  useEffect(() => { if (isOllama) setSuiteId("throughput-v1"); }, [isOllama]);
  const canBenchmark = Boolean(runningConfig && (!isOllama || suiteId === "throughput-v1") && ((runningEngine ?? settings.serverEngine) !== "llama_cpp" ? runningMode !== "router" : runningMode === "router" ? profiles.some(profile => profile.id === selectedProfileId) : selectedProfileId === runningConfig.profileId) && ["ready", "busy"].includes(runtime.state) && !busy);
  const latest = benchmarks[0];
  const compared = benchmarks.filter(result => compareIds.includes(result.id));
  const compareMetrics: { label: string; value: (result: BenchmarkResult) => string }[] = [
    { label: t("metrics.prompt"), value: result => result.averages.promptTps.toFixed(1) + " tok/s" },
    { label: t("metrics.generation"), value: result => result.averages.generationTps.toFixed(1) + " tok/s" },
    { label: t("metrics.ttft"), value: result => formatMs(result.averages.ttftMs) },
    { label: t("benchmark.qualityScore"), value: result => result.averages.qualityScore == null ? "—" : `${(result.averages.qualityScore * 100).toFixed(1)}%` },
    { label: t("benchmark.recommendationScore"), value: result => result.recommendationScore == null ? "—" : `${(result.recommendationScore * 100).toFixed(0)}%` },
    { label: t("benchmark.vramPeak"), value: result => (result.averages.vramPeakMiB / 1024).toFixed(1) + " GB" },
    { label: t("benchmark.ramPeak"), value: result => (result.averages.ramPeakMiB / 1024).toFixed(1) + " GB" },
    { label: t("benchmark.gpuPeak"), value: result => result.averages.gpuPeakPercent.toFixed(0) + "%" },
    { label: t("benchmark.duration"), value: result => result.averages.totalMs.toFixed(0) + " ms" },
  ];
  const toggleCompare = (id: string) => setCompareIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  const selectSuite = (id: string) => {
    const suite = benchmarkSuites.find(candidate => candidate.id === id);
    setSuiteId(id);
    if (!suite) return;
    const contextTarget = runtime.contextTotal > 0 && suite.promptTargetRatio
      ? Math.floor(runtime.contextTotal * suite.promptTargetRatio)
      : suite.defaultPromptTokens;
    setPromptTokens(Math.max(1024, contextTarget));
    setGenerationTokens(suite.defaultGenerationTokens);
    setRuns(suite.defaultRuns);
  };
  const startBenchmark = async () => {
    document.querySelector(".benchmarkMonitor")?.scrollIntoView({ behavior: "smooth", block: "start" });
    setBenchmarkRunning(true);
    try { await runBenchmark({
    ...(settings.serverEngine === "llama_cpp" ? { profileId: selectedProfileId } : {}),
    promptTokens,
    generationTokens,
    runs,
    suiteId,
    suiteVersion: selectedSuite?.version,
    objective,
    minimumQuality: isQualitySuite ? minimumQualityPercent / 100 : undefined,
    minimumGenerationTps: minimumGenerationTps > 0 ? minimumGenerationTps : undefined,
    contextLimitTokens: runtime.contextTotal || config.ctxSize,
    windowCount: selectedSuite?.windowCount,
    autoSelectProfiles: useProfileSearch,
    minimumContextTokens,
    maximumContextTokens,
  });
    } finally { setBenchmarkRunning(false); }
  };
  const startAutoTune = () => {
    document.querySelector(".benchmarkMonitor")?.scrollIntoView({ behavior: "smooth", block: "start" });
    void runAutoTune({
    profileId: selectedProfileId,
    promptTokens,
    generationTokens,
    runs,
    suiteId,
    suiteVersion: selectedSuite?.version,
    objective,
    minimumQuality: minimumQualityPercent / 100,
    minimumGenerationTps: minimumGenerationTps > 0 ? minimumGenerationTps : undefined,
    contextLimitTokens: runtime.contextTotal || config.ctxSize,
    windowCount: selectedSuite?.windowCount,
  });

  };

  const profileSelections = optimizerProfiles.length > 0 && <Panel className="benchmarkSelectedProfiles">
    <h3>{t("benchmark.selectedProfiles")}</h3><p className="benchmarkHint">{t("benchmark.selectedProfilesDescription")}</p>
    <div className="benchmarkProfileCards">{optimizerProfiles.map(selection => <article key={selection.goal}>
      <h4>{t(`benchmark.profileGoal.${selection.goal}`)}</h4>
      <p>{selection.profile.name}</p>
      <div className="benchmarkMetrics">
        <B l={t("parameters.ctxSize")} v={selection.profile.config.ctxSize.toLocaleString(i18n.language)}/>
        <B l={t("metrics.generation")} v={`${selection.result.averages.generationTps.toFixed(1)} tok/s`}/>
        <B l={t("benchmark.completedWindows")} v={`${selection.verification.suiteSummary?.completedWindows ?? 0} / ${selection.verification.suiteSummary?.requestedWindows ?? 0}`}/>
      </div>
      <small>{t("benchmark.savedVerifiedProfile")}</small>
      <Button disabled={busy} onClick={async () => { await selectProfile(selection.profile.id); setView("configuration"); }}>{t("benchmark.openSelectedProfile")}</Button>
    </article>)}</div>
  </Panel>;

  return <div className="page">
    <SectionTitle title={t("nav.benchmarks")} description={t("benchmark.pageDescription")} />
    <BenchmarkMonitor/>
    <BenchmarkTestPlan suite={selectedSuite} runs={runs} search={useProfileSearch} minimumQuality={minimumQualityPercent}/>
    {profileSelections}

    <div className="benchmarkGrid"><Panel className="benchmarkForm"><h3>{t("benchmark.title")}</h3>{settings.serverEngine !== "llama_cpp" ? <label>{t("profiles.profile")}<Input readOnly value={runtime.modelName || (settings.serverEngine === "ollama" ? settings.ollamaModel : settings.serverEngine === "qwfnfer" ? "QwFNfer" : "Strata")}/></label> : <label>{t("profiles.profile")}<select className="uiSelect" value={selectedProfileId} onChange={event => setRequestedProfileId(event.target.value)}>{profiles.filter(profile => !profile.config.engine || profile.config.engine === "llama_cpp").map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>}{!canBenchmark&&!benchmarkRunning&&!optimizerRunning&&<div className="benchmarkHint"><p>{t("benchmark.profileMustBeRunning")}</p><Button onClick={() => { if (profiles.some(profile => profile.id === selectedProfileId)) selectProfile(selectedProfileId); setView("dashboard"); }}>{t("apiDocs.back")}</Button></div>}
        <label>{t("benchmark.suite")}<select className="uiSelect" value={suiteId} onChange={event => selectSuite(event.target.value)}>{benchmarkSuites.filter(suite => settings.serverEngine !== "ollama" || suite.kind === "throughput").map(suite => <option key={suite.id} value={suite.id}>{t(suite.nameKey)}</option>)}</select></label>
        {selectedSuite&&<p className="benchmarkHint">{t(selectedSuite.descriptionKey)} · {selectedSuite.probeCount > 0 ? t("benchmark.probes", { count: selectedSuite.probeCount }) : t("benchmark.throughputOnly")}</p>}
        <label>{t("benchmark.promptTokens")}<Input type="number" min={1} max={Math.max(1, runtime.contextTotal || config.ctxSize)} value={promptTokens} onChange={event => setPromptTokens(Number(event.target.value))}/></label>
        <label>{t("benchmark.generationTokens")}<Input type="number" min={1} value={generationTokens} onChange={event => setGenerationTokens(Number(event.target.value))}/></label>
        <label>{t("benchmark.runs")}<Input type="number" min={1} max={isQualitySuite ? 3 : 20} value={runs} onChange={event => setRuns(Math.max(1, Math.min(Number(event.target.value), isQualitySuite ? 3 : 20)))}/></label>
        {isQualitySuite&&<label>{t("benchmark.minimumQuality")}<Input type="number" min={0} max={100} value={minimumQualityPercent} onChange={event => setMinimumQualityPercent(Number(event.target.value))}/></label>}
        {selectedSuite&&<p className="benchmarkHint">{t("benchmark.plannedWindows", { count: runs * selectedSuite.windowCount })}</p>}
        {effectiveEngine === "llama_cpp" && <div className="benchmarkProfileSearch">
          <label className="benchmarkSearchToggle"><input type="checkbox" checked={autoSelectProfiles} disabled={busy} onChange={event => setAutoSelectProfiles(event.target.checked)}/><span>{t("benchmark.autoSelectProfiles")}</span></label>
          {useProfileSearch && <>
            <p className="benchmarkHint">{t("benchmark.profileSearchDescription")}</p>
            <label>{t("benchmark.minimumContext")}<Input type="number" min={MINIMUM_AGENT_CONTEXT} max={MAXIMUM_SEARCH_CONTEXT} step={1024} disabled={busy} value={minimumContextTokens} onChange={event => setMinimumContextTokens(Number(event.target.value))}/></label>
            <label>{t("benchmark.maximumContext")}<Input type="number" min={minimumContextTokens} max={MAXIMUM_SEARCH_CONTEXT} step={1024} disabled={busy} value={maximumContextTokens} onChange={event => setRequestedMaximumContext(Number(event.target.value))}/></label>
            <p className="benchmarkHint">{t("benchmark.profileSearchLimits")}</p>
            {invalidSearchRange && <p role="alert" className="benchmarkHint">{t("benchmark.profileSearchInvalidRange")}</p>}
          </>}
        </div>}
        <div className="benchmarkActions"><Button className="primary" disabled={!canBenchmark || (useProfileSearch && invalidSearchRange)} onClick={startBenchmark}><Play size={14}/>{t(useProfileSearch ? "benchmark.runProfileSearch" : "benchmark.run")}</Button></div>
        <details className="benchmarkAdvanced"><summary>{t("benchmark.advancedTuning")}</summary>        <label>{t("benchmark.objective")}<select className="uiSelect" value={objective} onChange={event => setObjective(event.target.value as typeof objective)}><option value="balanced">{t("benchmark.objectiveBalanced")}</option><option value="speed">{t("benchmark.objectiveSpeed")}</option><option value="quality">{t("benchmark.objectiveQuality")}</option></select></label>

        <label>{t("benchmark.minimumGenerationTps")}<Input type="number" min={0} step={0.1} value={minimumGenerationTps} onChange={event => setMinimumGenerationTps(Number(event.target.value))}/></label>
<Button disabled={!canBenchmark||settings.serverEngine!=="llama_cpp"} onClick={startAutoTune}><BrainCircuit size={14}/>{t("benchmark.autoTune")}</Button></details>
        {benchmarkRunning&&!optimizerRunning&&<div className="optimizerProgress" role="status"><strong>{t("benchmark.running")}</strong><progress/></div>}
        {settings.serverEngine!=="llama_cpp"&&<p className="benchmarkHint">{t("benchmark.autoTuneEngineUnsupported")}</p>}
        {optimizerProgress&&<div className="optimizerProgress"><div><span>{optimizerRunning?t("benchmark.autoTuning"):optimizerProgress.candidate}</span><strong>{optimizerProgress.current}/{optimizerProgress.total}</strong></div><div className="uiProgress"><span style={{width:`${optimizerProgress.total?optimizerProgress.current/optimizerProgress.total*100:0}%`}}/></div>{optimizerRunning&&<><small>{t("benchmark.currentCandidate", {candidate:optimizerProgress.candidate})}</small><Button onClick={cancelAutoTune}>{t("benchmark.cancelTuning")}</Button></>}</div>}
        {optimizerRecommendation&&<div className="optimizerRecommendation"><div><strong>{t("benchmark.recommendation")}</strong><span>{optimizerRecommendation.configSnapshot?.profileName}</span></div><Button onClick={applyOptimizerRecommendation}>{t("benchmark.applyRecommendation")}</Button></div>}
      </Panel>
      <Panel className="benchmarkResult"><h3>{t("benchmark.latest")}</h3>{latest?<><BenchmarkTestResults result={latest}/><div className="benchmarkMetrics"><B l={t("metrics.prompt")} v={latest.averages.promptTps.toFixed(1)+" tok/s"}/><B l={t("metrics.generation")} v={latest.averages.generationTps.toFixed(1)+" tok/s"}/><B l={t("metrics.ttft")} v={formatMs(latest.averages.ttftMs)}/><B l={t("benchmark.vramPeak")} v={(latest.averages.vramPeakMiB/1024).toFixed(1)+" GB"}/><B l={t("benchmark.ramPeak")} v={(latest.averages.ramPeakMiB/1024).toFixed(1)+" GB"}/><B l={t("benchmark.gpuPeak")} v={latest.averages.gpuPeakPercent.toFixed(0)+"%"}/></div>{latest.suiteSummary&&<div className="benchmarkSuiteSummary"><B l={t("benchmark.suiteStatus")} v={t(latest.suiteSummary.passed?"benchmark.passed":"benchmark.failed")}/><B l={t("benchmark.currentAccuracy")} v={`${(latest.suiteSummary.currentAccuracy*100).toFixed(1)}%`}/><B l={t("benchmark.carryoverAccuracy")} v={latest.suiteSummary.carryoverAccuracy==null?"—":`${(latest.suiteSummary.carryoverAccuracy*100).toFixed(1)}%`}/><B l={t("benchmark.checkpointAccuracy")} v={`${(latest.suiteSummary.checkpointAccuracy*100).toFixed(1)}%`}/><B l={t("benchmark.completedWindows")} v={`${latest.suiteSummary.completedWindows} / ${latest.suiteSummary.requestedWindows}`}/><B l={t("benchmark.recommendationScore")} v={latest.recommendationScore==null?"—":`${(latest.recommendationScore*100).toFixed(0)}%`}/></div>}{latest.suiteWindows&&latest.suiteWindows.length>0&&<div className="suiteWindowTable"><table><thead><tr><th>{t("benchmark.cycle")}</th><th>{t("benchmark.promptTokens")}</th><th>{t("benchmark.currentAccuracy")}</th><th>{t("benchmark.carryoverAccuracy")}</th><th>{t("benchmark.checkpointAccuracy")}</th><th>{t("benchmark.suiteStatus")}</th></tr></thead><tbody>{latest.suiteWindows.map(window=><tr key={`${window.run}-${window.window}`}><td>{window.run}.{window.window}</td><td>{window.promptTokens.toLocaleString(i18n.language)}</td><td>{window.currentTotal?`${(window.currentMatches/window.currentTotal*100).toFixed(0)}%`:"—"}</td><td>{window.carryoverTotal?`${(window.carryoverMatches/window.carryoverTotal*100).toFixed(0)}%`:"—"}</td><td>{window.checkpointTotal?`${(window.checkpointMatches/window.checkpointTotal*100).toFixed(0)}%`:"—"}</td><td>{t(window.status==="passed"?"benchmark.passed":"benchmark.failed")}</td></tr>)}</tbody></table></div>}</>:<p className="subtle">{t("benchmark.none")}</p>}</Panel></div>

    {compared.length >= 2 && <Panel className="benchmarkCompare"><h3>{t("benchmark.compare")}</h3><div className="tableScroll"><table><thead><tr><th>{t("profiles.profile")}</th>{compared.map(result=><th key={result.id}>{result.profileName}<small>{new Date(result.createdAt).toLocaleString(i18n.language)}</small></th>)}</tr></thead><tbody>{compareMetrics.map(metric=><tr key={metric.label}><th>{metric.label}</th>{compared.map(result=><td key={result.id}>{metric.value(result)}</td>)}</tr>)}</tbody></table></div></Panel>}
    <Panel className="benchmarkTable"><h3>{t("benchmark.history")}</h3><p className="subtle compareHint">{t("benchmark.compareHint")}</p><div className="tableScroll"><table><thead><tr><th>{t("benchmark.compareSelection")}</th><th>{t("profiles.profile")}</th><th>{t("metrics.prompt")}</th><th>{t("metrics.generation")}</th><th>{t("metrics.ttft")}</th><th>{t("benchmark.qualityScore")}</th><th>{t("benchmark.recommendationScore")}</th><th>{t("benchmark.vramPeak")}</th><th>{t("benchmark.runs")}</th><th>{t("benchmark.duration")}</th></tr></thead><tbody>{benchmarks.map(result=><tr key={result.id}><td><input type="checkbox" checked={compareIds.includes(result.id)} aria-label={t("benchmark.compareSelection")} onChange={() => toggleCompare(result.id)}/></td><td>{result.profileName}<BenchmarkTestResults result={result}/><small>{new Date(result.createdAt).toLocaleString(i18n.language)}</small></td><td>{result.averages.promptTps.toFixed(1)}</td><td>{result.averages.generationTps.toFixed(1)}</td><td>{formatMs(result.averages.ttftMs)}</td><td>{result.averages.qualityScore==null?"—":`${(result.averages.qualityScore*100).toFixed(1)}%`}</td><td>{result.recommendationScore==null?"—":`${(result.recommendationScore*100).toFixed(0)}%`}</td><td>{(result.averages.vramPeakMiB/1024).toFixed(1)} GB</td><td>{result.suiteSummary?`${result.suiteSummary.completedWindows}/${result.suiteSummary.requestedWindows}`:result.samples.length}</td><td>{result.averages.totalMs.toFixed(0)} ms</td></tr>)}</tbody></table></div></Panel>
  </div>;
}

function B({l,v}:{l:string;v:string}){return <div><span>{l}</span><strong>{v}</strong></div>}
