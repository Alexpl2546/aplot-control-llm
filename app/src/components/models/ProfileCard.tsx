import { Box, FolderOpen, Layers3, Play, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { modelCatalog } from "../../lib/modelCatalog";
import type { ServerEngine } from "../../types/app";
import { Button, Panel } from "../ui/Primitives";
import { EngineBadge } from "./EngineBadge";

export interface ProfileSpec { label: string; value: string; icon: LucideIcon; tone: "Blue" | "Violet" | "Green" | "Gold"; }

export function ProfileCard({ name, modelName, engine, path, description, badges, specs, metadata, actions, busy, onSelect, onReveal }: {
  name: string; modelName: string; engine: ServerEngine; path?: string; description?: string;
  badges?: ReactNode; specs: ProfileSpec[]; metadata?: ReactNode; actions?: ReactNode; busy: boolean;
  onSelect: () => void; onReveal?: () => void;
}) {
  const { t } = useTranslation();
  const catalog = modelCatalog({ name: modelName, path: path ?? "" });
  return <Panel className="profileCard profileShowcase">
    <div className="modelCardTop"><div className="chips modelEngineChips"><EngineBadge engine={engine}/>{badges}</div><Layers3 className="profileGlyph" size={21} aria-hidden="true"/></div>
    <div className="modelHeading">
      <div className="modelEmblem" title={catalog?.creator}>{catalog ? <img src={`/creators/${catalog.icon}.${["ornith", "prism"].includes(catalog.icon) ? "png" : "svg"}`} alt={catalog.creator}/> : <Box size={26}/>}</div>
      <div><h3>{name}</h3>{modelName && modelName !== name && <p className="profileModelName" title={modelName}>{modelName}</p>}</div>
    </div>
    <dl className="modelSpecs profileSpecs">{specs.map(({ label, value, icon: Icon, tone }) => <div className={`spec${tone}`} key={label}><Icon size={21}/><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {description && <p className="profileDescription">{description}</p>}
    {metadata && <div className="profileMetadata">{metadata}</div>}
    <div className="modelCardFooter">
      <Button className="primary modelConfigure" disabled={busy} onClick={onSelect}><Play size={18}/>{t("profiles.select")}</Button>
      {actions && <div className="profileSecondaryActions">{actions}</div>}
      {path && <div className="modelLocation"><span className="mono" title={path}>{path}</span>{onReveal && <Button className="modelFolder" disabled={busy} onClick={onReveal} title={t("models.openFolder")} aria-label={t("models.openFolder")}><FolderOpen size={16}/></Button>}</div>}
    </div>
  </Panel>;
}
