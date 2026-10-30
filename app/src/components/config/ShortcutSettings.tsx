import { Keyboard, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Panel } from "../ui/Primitives";
import { SHORTCUT_ACTIONS, comboLabel, comboOf, useShortcuts, type ShortcutAction } from "../../lib/shortcuts";

/** Settings → Shortcuts: each action with its combo; «Изменить» waits for the next combo, Escape cancels. */
export function ShortcutSettings() {
  const { t } = useTranslation();
  const map = useShortcuts(state => state.map);
  const [listening, setListening] = useState<ShortcutAction>();
  const [error, setError] = useState("");
  return <Panel className="settingsSection shortcutSettings">
    <h3><Keyboard size={15}/>{t("shortcuts.title")}</h3>
    <p className="shortcutHint">{t("shortcuts.hint")}</p>
    <ul>{SHORTCUT_ACTIONS.map(action => <li key={action}>
      <span>{t(`shortcuts.action.${action}`)}</span>
      <button type="button" className={`shortcutCombo${listening === action ? " isListening" : ""}`} aria-label={`${t(`shortcuts.action.${action}`)}: ${listening === action ? t("shortcuts.press") : comboLabel(map[action]) || t("shortcuts.none")}`}
        onClick={() => { setError(""); setListening(listening === action ? undefined : action); }}
        onBlur={() => setListening(current => current === action ? undefined : current)}
        onKeyDown={event => {
          if (listening !== action) return;
          event.preventDefault(); event.stopPropagation();
          if (event.key === "Escape") { setListening(undefined); return; }
          const combo = comboOf(event.nativeEvent);
          if (!combo) return; // a modifier alone: keep waiting for the key
          if (!(event.ctrlKey || event.metaKey || event.altKey) && !/^F\d+$/.test(event.code)) { setError(t("shortcuts.needModifier")); return; }
          useShortcuts.getState().assign(action, combo);
          setListening(undefined); setError("");
        }}>{listening === action ? t("shortcuts.press") : comboLabel(map[action]) || t("shortcuts.none")}</button>
    </li>)}</ul>
    {error && <p role="alert" className="shortcutError">{error}</p>}
    <Button onClick={() => { useShortcuts.getState().reset(); setListening(undefined); setError(""); }}><RotateCcw size={14}/>{t("shortcuts.reset")}</Button>
  </Panel>;
}
