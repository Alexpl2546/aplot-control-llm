import { Save, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { Button, Input } from "../ui/Primitives";

export function SaveAsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { config, duplicateProfile, busy, optimizerRunning } = useControlStore();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const titleId = useId();
  useEffect(() => { if (open) { setName(`${config.profileName} ${t("profiles.copySuffix")}`.trim()); setError(""); } }, [open, config.profileName, t]);
  if (!open) return null;
  const pending = busy || optimizerRunning || saving;
  const close = () => { if (!busy && !savingRef.current) onClose(); };
  const submit = async () => {
    const clean = name.trim();
    if (!clean || busy || optimizerRunning || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try { await duplicateProfile(clean); onClose(); }
    catch (reason) { setError(String(reason)); }
    finally { savingRef.current = false; setSaving(false); }
  };
  return <div className="modalBackdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) close(); }}>
    <section className="modalCard saveAsDialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={saving} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); close(); } }}>
      <header><div><h2 id={titleId}>{t("profiles.saveAsTitle")}</h2><p>{t("profiles.saveAsText")}</p></div><Button aria-label={t("actions.close")} disabled={busy || saving} onClick={close}><X size={15}/></Button></header>
      <div className="dialogBody"><label>{t("profiles.profileName")}<Input autoFocus disabled={pending} value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }}/></label>{error && <p role="alert">{error}</p>}</div>
      <footer><Button disabled={busy || saving} onClick={close}>{t("actions.cancel")}</Button><Button className="primary" disabled={pending || !name.trim()} onClick={() => void submit()}><Save size={14}/>{t("actions.saveAs")}</Button></footer>
    </section>
  </div>;
}
