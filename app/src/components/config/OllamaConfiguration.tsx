import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Send, Save } from "lucide-react";
import { useControlStore } from "../../store/control";
import { ollamaAction, type OllamaAnswer } from "../../services/ollama";
import { Button, Input, Panel, Select } from "../ui/Primitives";

export function OllamaConfiguration() {
  const { t } = useTranslation();
  const { settings, ollamaModels, updateSettings, saveCurrentProfile, config, updateConfig, busy, notify } = useControlStore();
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState<OllamaAnswer>();
  const [generating, setGenerating] = useState(false);
  const [contextDraft, setContextDraft] = useState(String(settings.ollamaContext));
  useEffect(() => { setContextDraft(String(settings.ollamaContext)); }, [settings.ollamaContext]);
  const commitContext = async () => {
    const context = Number(contextDraft);
    if (!contextDraft.trim() || !Number.isInteger(context) || context < 512 || context > 262144) {
      setContextDraft(String(settings.ollamaContext));
      return;
    }
    if (context !== settings.ollamaContext) await updateSettings({ ollamaContext: context });
  };
  const local = ollamaModels.filter(model => model.capabilities?.includes("completion"));
  const generate = async () => {
    if (busy || generating) return;
    useControlStore.setState({ busy: true }); setGenerating(true); setAnswer(undefined);
    try {
      await commitContext();
      const snapshot = { ...useControlStore.getState().settings };
      setAnswer(await ollamaAction(snapshot.ollamaEndpoint, snapshot.ollamaModel, "generate", snapshot.ollamaContext, prompt));
    }
    catch (error) { notify("error", String(error)); }
    finally { useControlStore.setState({ busy: false }); setGenerating(false); }
  };
  return <Panel className="settingsSection ollamaConfiguration">
    <h3>Ollama</h3>
    <label>{t("ollama.chooseModel")}<Select value={settings.ollamaModel} disabled={busy || generating} onChange={event => { const id = useControlStore.getState().libraryModels.find(model => model.sources.ollama?.name === event.target.value)?.id; if (id) void useControlStore.getState().selectLibraryModel(id, "ollama").catch(error => notify("error", String(error))); }}><option value="">{t("ollama.chooseModel")}</option>{local.map(model => <option key={model.name} value={model.name}>{model.name}</option>)}</Select></label>
    <label>{t("profiles.profileName")}<Input value={config.engine === "ollama" ? config.profileName : settings.ollamaModel} onChange={event => updateConfig("profileName", event.target.value)}/></label>
    <label>{t("parameters.ctxSize")}<Input type="number" min={512} max={262144} value={contextDraft} disabled={busy || generating} onChange={event => setContextDraft(event.target.value)} onBlur={() => void commitContext().catch(error => notify("error", String(error)))} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}/></label>
    <Button disabled={busy || generating || !settings.ollamaModel} onClick={() => void commitContext().then(() => saveCurrentProfile()).catch(error => notify("error", String(error)))}><Save size={14}/>{t("actions.save")}</Button>
    <label>{t("ollama.prompt")}<textarea className="uiTextarea" rows={3} value={prompt} disabled={generating} onChange={event => setPrompt(event.target.value)}/></label>
    <Button disabled={generating || busy || !settings.ollamaModel || !prompt.trim()} onClick={() => void generate()}><Send size={14}/>{t("ollama.generate")}</Button>
    {generating && <p role="status">{t("ollama.generateBusy")}</p>}
    {answer && <div className="ollamaAnswer">{answer.thinking && <details><summary>{t("ollama.thinking")}</summary><pre>{answer.thinking}</pre></details>}<pre>{answer.response}</pre><p>{answer.eval_count ?? 0} {t("ollama.tokens")} · {answer.eval_duration ? ((answer.eval_count ?? 0) * 1e9 / answer.eval_duration).toFixed(1) : "—"} tok/s</p></div>}
  </Panel>;
}
