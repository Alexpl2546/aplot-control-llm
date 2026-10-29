import { invoke } from '@tauri-apps/api/core';
import type { ServerEngine } from '../../types/app';
import { isTauri } from '../../services/tauri';
import strataFallback from './strataCatalogFallback.json';

export interface ModelRecipe {
  id: string; name: string; engine: ServerEngine; source?: string;
  ramGiB: number; vramGiB: number; downloadGiB: number; use: 'chat'|'coding';
  family?: string; model?: string; configTag?: string; about?: string;
  images?: boolean; tools?: boolean; experimental?: boolean; memoryGiB?: number; memoryTotal?: boolean;
  fitMessage?: string | null; nvidiaOnly?: boolean; engineMin?: string;
  fitStatus?: 'fits'|'tight'|'spills'|'over_budget'|'low_ram'|'unknown';
  recommended?: boolean;
}
// llama.cpp entries use the publisher's GGUF releases. Strata entries mirror
// setup.py's supported families, which also acquire packs, tokenizer and MTP.
// The bundled Strata snapshot is from upstream v0.2.2 (engine 0.1.47). Desktop
// refreshes it from the installed Strata catalog, including its own-path models.
export const MODEL_RECIPES: readonly ModelRecipe[] = [
  {id:'qwen3-4b',name:'Qwen3 4B · Q4_K_M',engine:'llama_cpp',source:'Qwen/Qwen3-4B-GGUF',ramGiB:8,vramGiB:0,downloadGiB:2.5,use:'chat'},
  {id:'qwen3-8b',name:'Qwen3 8B · Q4_K_M',engine:'llama_cpp',source:'Qwen/Qwen3-8B-GGUF',ramGiB:12,vramGiB:0,downloadGiB:4.7,use:'chat'},
  {id:'qwen3-14b',name:'Qwen3 14B · Q4_K_M',engine:'llama_cpp',source:'Qwen/Qwen3-14B-GGUF',ramGiB:20,vramGiB:0,downloadGiB:8.5,use:'chat'},
  ...strataFallback as ModelRecipe[],
];
const knownRecipes = new Map(MODEL_RECIPES.map(recipe => [recipe.id, recipe]));
export function findModelRecipe(id: string): ModelRecipe | undefined { return knownRecipes.get(id); }
export async function loadModelRecipes(rootValue?: string): Promise<readonly ModelRecipe[]> {
  if (!isTauri()) return MODEL_RECIPES;
  const strata = await invoke<ModelRecipe[]>('strata_model_catalog', { rootValue: rootValue ?? '' });
  if (!Array.isArray(strata) || !strata.length || strata.some(recipe => recipe.engine !== 'strata' || !recipe.id || !recipe.family || !recipe.model || !recipe.configTag)) {
    throw new Error('The installed Strata component did not provide a valid model catalog');
  }
  const recipes = [...MODEL_RECIPES.filter(recipe => recipe.engine !== 'strata'), ...strata];
  for (const recipe of recipes) knownRecipes.set(recipe.id, recipe);
  return recipes;
}
export interface RecipeHardware { ramGiB:number; freeRamGiB:number; vramGiB:number; freeVramGiB?:number; }
export function recipeFits(recipe:ModelRecipe,hardware:RecipeHardware) {
  const freeVramGiB = Math.max(0, hardware.freeVramGiB ?? hardware.vramGiB);
  // Prefer Strata's own current-machine verdict. Its low-RAM path and model
  // recommendations are engine-specific and cannot be reproduced by a single
  // RAM + VRAM threshold. Keep the Strata pick visible even when its verdict is
  // tight, since the engine treats this as guidance rather than a launch gate.
  if (recipe.engine === 'strata' && recipe.recommended) return true;
  if (recipe.engine === 'strata' && recipe.fitStatus && recipe.fitStatus !== 'unknown') {
    return recipe.fitStatus === 'fits' || recipe.fitStatus === 'low_ram';
  }
  // Fallback and Hub estimates use currently free memory. VRAM is measured from
  // the hardware snapshot when available; older/unsupported snapshots fall back
  // to total VRAM and remain explicitly advisory in the UI.
  if (recipe.engine === 'strata') return Number.isFinite(hardware.freeRamGiB)
    && hardware.freeRamGiB + Math.max(0, freeVramGiB - 6) >= (recipe.memoryGiB ?? recipe.ramGiB)
    && (!recipe.nvidiaOnly || hardware.vramGiB > 0);
  return Number.isFinite(hardware.ramGiB)&&hardware.ramGiB>=recipe.ramGiB-1
    &&hardware.freeRamGiB>=recipe.ramGiB*.75&&freeVramGiB>=recipe.vramGiB;
}
