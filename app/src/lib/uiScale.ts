/** `uiScale = 0` means "Auto": the interface scale follows the window size. */
export const AUTO_UI_SCALE = 0;

const DESIGN_WIDTH = 1600;
const DESIGN_HEIGHT = 920;

/**
 * Picks a zoom for a window measured in device-independent pixels (Windows scaling already applied).
 * A 24" 1080p screen lands near 1.1 (the previous default), a 27" 1440p or 32" 4K-at-150% screen grows
 * to 1.3–1.4 so text stays readable from a normal distance, and a small laptop never drops below 0.9.
 */
export function autoUiScale(width: number, height: number) {
  const fit = Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT);
  const scale = Math.max(0.9, Math.min(1.5, fit));
  return Math.round(scale * 20) / 20;
}

export function effectiveUiScale(setting: number, width: number, height: number) {
  return setting > 0 ? setting : autoUiScale(width, height);
}
