/** `uiScale = 0` means "Auto": the interface scale follows the window size. */
export const AUTO_UI_SCALE = 0;

const DESIGN_WIDTH = 1600;
const DESIGN_HEIGHT = 920;

/**
 * Picks a zoom for a window measured in device-independent pixels (Windows scaling already applied).
 * Windows already handles pixel density. A large window keeps the normal 100% scale instead of
 * magnifying the interface again; a small window can shrink gently, never below 90%.
 * A larger manual scale remains available for remote access or individual reading preferences.
 */
export function autoUiScale(width: number, height: number) {
  const fit = Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT);
  const scale = Math.max(0.9, Math.min(1, fit));
  return Math.round(scale * 20) / 20;
}

export function effectiveUiScale(setting: number, width: number, height: number) {
  return setting > 0 ? setting : autoUiScale(width, height);
}
