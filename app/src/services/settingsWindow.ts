import { useControlStore } from '../store/control';
import type { SettingsSection } from '../types/app';

/** Every settings entry point selects a section in the same window. */
export function openSettingsSection(section: SettingsSection) {
  useControlStore.setState({ settingsOpen: true, settingsSection: section });
}
