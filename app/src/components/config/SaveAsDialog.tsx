import { Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { Button, Input } from "../ui/Primitives";

export function SaveAsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { config, duplicateProfile, busy } = useControlStore();
  const [name, setName] = useState("");
  useEffect(() => { if (open) setName(`${config.profileName} ${t("profiles.copySuffix")}`.trim()); }, [open, config.profileName, t]);
  if (!open) return null;
  const submit = async () => {
    const clean = name.trim();
    if (!clean) return;
    await duplicateProfile(clean);
    onClose();
  };
  return <div className="modalBackdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="modalCard saveAsDialog" role="dialog" aria-modal="true">
      <header><div><h2>{t("profiles.saveAsTitle")}</h2><p>{t("profiles.saveAsText")}</p></div><Button aria-label={t("actions.close")} onClick={onClose}><X size={15}/></Button></header>
      <div className="dialogBody"><label>{t("profiles.profileName")}<Input autoFocus value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void submit(); }}/></label></div>
      <footer><Button disabled={busy} onClick={onClose}>{t("actions.cancel")}</Button><Button className="primary" disabled={busy || !name.trim()} onClick={() => void submit()}><Save size={14}/>{t("actions.saveAs")}</Button></footer>
    </section>
  </div>;
}
