import {expect,it} from 'vitest';
import {MODEL_RECIPES,recipeFits} from '../src/features/modelDownloads/recipes';
it('keeps engine recipes separate and excludes recipes with insufficient free memory',()=>{
 const small=MODEL_RECIPES.find(recipe=>recipe.id==='qwen3-4b')!;
 const strata=MODEL_RECIPES.find(recipe=>recipe.id==='strata-qwen-iq2')!;
 expect(small.engine).toBe('llama_cpp');expect(strata.engine).toBe('strata');
 expect(recipeFits(small,{ramGiB:16,freeRamGiB:10,vramGiB:0})).toBe(true);
 expect(recipeFits(strata,{ramGiB:64,freeRamGiB:50,vramGiB:16})).toBe(true);
 expect(recipeFits(strata,{ramGiB:64,freeRamGiB:20,vramGiB:16})).toBe(false);
 expect(recipeFits(strata,{ramGiB:64,freeRamGiB:50,vramGiB:0})).toBe(true);
 expect(recipeFits({...strata,nvidiaOnly:true},{ramGiB:128,freeRamGiB:100,vramGiB:0})).toBe(false);
 expect(recipeFits(small,{ramGiB:NaN,freeRamGiB:10,vramGiB:16})).toBe(false);
});
