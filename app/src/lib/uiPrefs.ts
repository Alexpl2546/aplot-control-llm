import { create } from "zustand";

/** Presentation-only preferences. They live in this browser profile, never in engine settings. */
export type Density = "auto" | "comfortable" | "compact";
interface UiPrefs {
  density: Density;
  mica: boolean;
  /** Sidebar stays open (true) or folds to a rail and slides out on hover (false). */
  sidebarPinned: boolean;
  setDensity: (density: Density) => void;
  setMica: (mica: boolean) => void;
  setSidebarPinned: (pinned: boolean) => void;
}
type Stored = Pick<UiPrefs, "density" | "mica" | "sidebarPinned">;

const KEY = "aplot.uiPrefs";
function read(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<UiPrefs>;
    return {
      density: raw.density === "compact" || raw.density === "comfortable" ? raw.density : "auto",
      mica: raw.mica === true,
      // Older builds kept the pin in its own key.
      sidebarPinned: typeof raw.sidebarPinned === "boolean" ? raw.sidebarPinned : localStorage.getItem("aplot.sidebarPinned") !== "false",
    };
  } catch { return { density: "auto", mica: false, sidebarPinned: true }; }
}
function write(state: Stored) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* Keep the preference for this session only. */ }
}

const pick = (state: UiPrefs): Stored => ({ density: state.density, mica: state.mica, sidebarPinned: state.sidebarPinned });

/** Compact below 900 CSS px of height or 1500 of width: laptops get more rows, large monitors more air. */
export function resolveDensity(density: Density, width: number, height: number): "comfortable" | "compact" {
  return density === "auto" ? (height < 900 || width < 1500 ? "compact" : "comfortable") : density;
}

export const useUiPrefs = create<UiPrefs>((set, get) => ({
  ...read(),
  setDensity: density => { set({ density }); write({ ...pick(get()), density }); },
  setMica: mica => { set({ mica }); write({ ...pick(get()), mica }); },
  setSidebarPinned: sidebarPinned => { set({ sidebarPinned }); write({ ...pick(get()), sidebarPinned }); },
}));
