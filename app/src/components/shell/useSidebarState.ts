import { useState } from "react";

/** Presentation preferences stay local to the shell, separate from engine/run settings. */
export function useSidebarState() {
  const [pinned, setPinned] = useState(() => { try { return localStorage.getItem("aplot.sidebarPinned") !== "false"; } catch { return true; } });
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    try { localStorage.setItem("aplot.sidebarPinned", String(next)); } catch { /* Retain session preference. */ }
  };
  return { pinned, rail: !pinned, expanded: pinned || hovered || focused, togglePin, setHovered, setFocused };
}
