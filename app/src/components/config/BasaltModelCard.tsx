import { Cpu, FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { pickBasaltPack } from "../../services/dialog";
import { isTauri } from "../../services/tauri";
import { useControlStore } from "../../store/control";
import { pathKey } from "../../lib/engineModels";
import { ChoiceSelect } from "../ui/ChoiceSelect";
import { Button, Input, Panel } from "../ui/Primitives";

export function BasaltModelCard() {
  const { t } = useTranslation();
  const { config, libraryModels, busy, updateConfig, replaceConfig, setView, notify } = useControlStore();
  const packs = libraryModels.filter(model => model.sources.basalt);
  const options = packs.map(model => ({ value: model.path, label: model.name, description: model.path }));
  if (/\.basalt$/i.test(config.modelPath) && !options.some(item => pathKey(item.value) === pathKey(config.modelPath))) {
    options.unshift({ value: config.modelPath, label: config.modelPath.split(/[\\/]/).pop() ?? config.modelPath, description: config.modelPath });
  }
  const choose = (path: string) => {
    const selected = packs.find(model => pathKey(model.path) === pathKey(path));
    replaceConfig({
      ...config, engine: "basalt", modelPath: path, modelAlias: selected?.name || path.split(/[\\/]/).pop()?.replace(/\.basalt$/i, ""),
      modelBytes: selected?.sizeBytes, modelArchitecture: selected?.architecture, modelQuantization: selected?.quantization,
      // The model owns its tokenizer and projector.
      mmprojPath: "", loraPaths: [],
    });
  };
  return <Panel className="strataModelCard strataEditor">
    <header>
      <div className="modelGlyph" aria-hidden="true"><Cpu size={28}/></div>
      <div><h3>Basalt</h3><p>{t("engine.hint.basalt")}</p></div>
    </header>
    <label className="strataEditorConfig">
      <span>{t("basalt.pack")}</span>
      <ChoiceSelect label={t("basalt.pack")} value={config.modelPath} options={options} searchable disabled={busy} onChange={choose}/>
    </label>
    <div className="toolbar">
      <Button type="button" disabled={!isTauri() || busy} onClick={() => void pickBasaltPack().then(path => { if (path) choose(path); }).catch(error => notify("error", String(error)))}>
        <FolderOpen size={15}/>{t("actions.browse")}
      </Button>
      <Button type="button" onClick={() => setView("models")}>{t("nav.library")}</Button>
    </div>
    <div className="strataEditorFields">
      <label><span>{t("basalt.context")}</span>
        <Input type="number" min={1} value={config.ctxSize || ""} disabled={busy} onChange={event => updateConfig("ctxSize", Number(event.target.value))}/>
      </label>
      <label><span>{t("basalt.parallel")}</span>
        <Input type="number" min={1} max={8} value={config.parallel || ""} disabled={busy} onChange={event => updateConfig("parallel", Number(event.target.value))}/>
      </label>
      <label><span>{t("settings.strataHost")}</span>
        <Input value={config.host} disabled={busy} onChange={event => updateConfig("host", event.target.value)}/>
      </label>
      <label><span>{t("settings.strataPort")}</span>
        <Input type="number" min={1} max={65535} value={config.port || ""} disabled={busy} onChange={event => updateConfig("port", Number(event.target.value))}/>
      </label>
      <label><span>{t("router.apiKey")}</span>
        <Input type="password" value={config.apiKey || ""} disabled={busy} onChange={event => updateConfig("apiKey", event.target.value)}/>
      </label>
    </div>
  </Panel>;
}
