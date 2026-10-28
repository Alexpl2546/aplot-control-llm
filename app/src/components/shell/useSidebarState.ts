import { useEffect, useRef, useState } from "react";
import { useUiPrefs } from "../../lib/uiPrefs";

/** Pinned: the sidebar is a full pane. Unpinned: a slim rail that slides out over the page on hover or keyboard focus. */
export function useSidebarState() {
  const pinned = useUiPrefs(state => state.sidebarPinned);
  const [hovered, setHoveredRaw] = useState(false);
  const [focused, setFocused] = useState(false);
  // A short grace period: leaving the panel by a few pixels (e.g. toward a menu) must not snap it shut.
  const timer = useRef<number | undefined>(undefined);
  const setHovered = (value: boolean) => {
    window.clearTimeout(timer.current);
    if (value) setHoveredRaw(true);
    else timer.current = window.setTimeout(() => setHoveredRaw(false), 260);
  };
  useEffect(() => { if (pinned) { setHoveredRaw(false); setFocused(false); } }, [pinned]);
  const togglePin = () => useUiPrefs.getState().setSidebarPinned(!pinned);
  return { pinned, rail: !pinned, expanded: pinned || hovered || focused, togglePin, setHovered, setFocused };
}
