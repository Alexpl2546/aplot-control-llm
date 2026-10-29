import { Box, Check, CircleAlert, Cpu, Database, File, FileText, FolderOpen, Image, Settings2, Star, Trash2, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { modelCardDetails } from "../../lib/modelCard";
import { formatModelSize } from "../../lib/models";
import { modelStoragePath, needsStrataPreparation, supportsEngine, type EngineModel } from "../../lib/engineModels";
import type { ServerEngine } from "../../types/app";
import { Button, Panel } from "../ui/Primitives";
import { useControlStore } from "../../store/control";
import { openExternalUrl } from "../../services/desktop";
import { EngineBadge } from "./EngineBadge";
import type { ModelCompanion } from "../../lib/modelCompanions";

const engines: ServerEngine[] = ["llama_cpp", "strata"];

export function ModelCard({ model, favorite, favoriteDisabled, configureDisabled, onFavorite, onConfigure, onReveal, onPrepareStrata, companions = [], onRemove, removeDisabled }: {
  model: EngineModel; favorite: boolean; favoriteDisabled: boolean; configureDisabled: boolean;
  onFavorite: () => void; onConfigure: () => void; onReveal: () => void;
  onPrepareStrata?: () => void;
  companions?: ModelCompanion[]; onRemove?: () => void; removeDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const profiles = useControlStore(state => state.profiles);
  const details = modelCardDetails(model, profiles);
  const needsPreparation = needsStrataPreparation(model);
  // Files a feature needs beside the model: the vision projector unless vision is built in, and any draft or n-gram file.
  const projector = companions.find(item => item.kind === "mmproj");
  const extras: { label: string; companion?: ModelCompanion }[] = [
    ...(details.vision && details.visionState !== "runtime" ? [{ label: t("models.files.mmproj"), companion: projector }] : projector ? [{ label: t("models.files.mmproj"), companion: projector }] : []),
    ...companions.filter(item => item.kind !== "mmproj").map(item => ({ label: t(`models.files.${item.kind}`), companion: item })),
  ];
  return <Panel className="modelCard modelShowcase">
    <div className="modelCardTop">
      <div className="chips modelEngineChips">
        {engines.filter(engine => supportsEngine(model, engine)).map(engine => <EngineBadge key={engine} engine={engine}/>)}
        {needsPreparation && <span className="badge">{t("models.strataPreparationRequired")}</span>}
      </div>
      <Button className={`modelFavorite ${favorite ? "isFavorite" : ""}`} aria-pressed={favorite}
        aria-label={t(favorite ? "models.unfavorite" : "models.favorite", { name: model.name })}
        title={t(favorite ? "models.unfavorite" : "models.favorite", { name: model.name })}
        disabled={favoriteDisabled} onClick={onFavorite}><Star size={21}/></Button>
    </div>
    <div className="modelHeading">
      <div className="modelEmblem" title={details.catalog?.creator}>{details.catalog ? <img src={`/creators/${details.catalog.icon}.svg`} alt={details.catalog.creator}/> : <Box size={26}/>}</div>
      <div><h3>{model.name}</h3></div>
    </div>
    <dl className="modelSpecs">
      <div className="specViolet"><Cpu size={21}/><dt>{t("models.parameters")}</dt><dd>{details.parameterLabel}</dd></div>
      <div className="specBlue"><Database size={21}/><dt>{t("models.context")}</dt><dd>{details.contextLabel}</dd></div>
      <div className="specGreen"><Box size={21}/><dt>{t("models.size")}</dt><dd>{model.sizeBytes > 0 ? formatModelSize(model.sizeBytes) : "—"}</dd></div>
      <div className="specGold"><File size={21}/><dt>{t("models.format")}</dt><dd>{details.format}{model.quantization && <small>{model.quantization}</small>}</dd></div>
    </dl>
    <div className="modelSupport">
      <span className="modelSectionLabel">{t("models.support")}</span>
      <div className="chips">
        {details.text && <span className="modelCapability capabilityText"><FileText size={16}/>{t("models.text")}</span>}
        {details.vision && <span className="modelCapability capabilityVision"><Image size={16}/>Vision</span>}
        {details.tools && <span className="modelCapability capabilityTools"><Wrench size={16}/>{t("models.tools")}</span>}
      </div>
    </div>
    {details.vision && <p className="modelVisionNote">{t(`models.visionState.${details.visionState}`)}</p>}
    {extras.length > 0 && <div className="modelFiles"><span className="modelSectionLabel">{t("models.files.title")}</span>
      <ul>{extras.map(({ label, companion }) => <li key={label + (companion?.path ?? "")} className={companion?.installed ? "isInstalled" : "isMissing"} title={companion?.path}>
        {companion?.installed ? <Check size={14}/> : <CircleAlert size={14}/>}<span>{label}</span><small>{t(companion ? companion.installed ? "models.files.installed" : "models.files.incomplete" : "models.files.missing")}</small>
      </li>)}</ul></div>}
    {needsPreparation && <p className="modelVisionNote">{t("models.strataPreparationHint")}</p>}
    <div className="modelApplications"><span className="modelSectionLabel">{t("models.application")}</span><div className="chips">{details.catalog?.uses.map(use => <span className="modelUse" key={use}>{t(`models.use.${use}`)}</span>) ?? <span className="modelVisionNote">{t("models.applicationUnknown")}</span>}</div>{details.catalog && <button className="modelSource" onClick={() => void openExternalUrl(details.catalog!.source).catch(error => useControlStore.getState().notify("error", String(error)))}>{t("models.modelSource")} ↗</button>}</div>
    <div className="modelCardFooter">
      {needsPreparation && onPrepareStrata
        ? <Button className="primary modelConfigure" disabled={favoriteDisabled} onClick={onPrepareStrata}><Settings2 size={18}/>{t("models.prepareStrata")}</Button>
        : <Button className="primary modelConfigure" disabled={configureDisabled} onClick={onConfigure}><Settings2 size={18}/>{t("models.configureModel")}</Button>}
      <div className="modelLocation"><span className="mono" title={model.path}>{model.path}</span>
        <Button className="modelFolder" disabled={!modelStoragePath(model)} onClick={onReveal}
          title={t("models.openFolder")} aria-label={t("models.openFolder")}><FolderOpen size={16}/></Button>
        {onRemove && <Button className="modelFolder dangerGhost" disabled={removeDisabled} onClick={onRemove}
          title={t("models.remove.action")} aria-label={t("models.remove.label", { name: model.name })}><Trash2 size={16}/></Button>}
      </div>
    </div>
  </Panel>;
}
