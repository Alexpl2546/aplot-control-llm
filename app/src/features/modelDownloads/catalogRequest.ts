import { create } from 'zustand';

/** Another screen asks the library to open the download catalog (e.g. «Подобрать» found no suitable model). */
export const useCatalogRequest = create<{ requested: boolean; request: () => void; clear: () => void }>(set => ({
  requested: false,
  request: () => set({ requested: true }),
  clear: () => set({ requested: false }),
}));
