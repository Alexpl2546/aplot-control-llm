// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { PreparationPanel } from '../src/features/modelDownloads/PreparationPanel';
import { useAcquisitionStore } from '../src/features/modelDownloads/acquisition';
afterEach(()=>{cleanup();useAcquisitionStore.setState({preparation:undefined});});
it('uses the shared full-width download layout for known and indeterminate Strata progress',()=>{
 useAcquisitionStore.setState({preparation:{id:'download',recipeId:'deepseek',state:'installing',lines:['weights.gguf: 0.21 / 39.54 GB (1%)']}});
 const view=render(<PreparationPanel/>);
 expect(screen.getByRole('progressbar').getAttribute('value')).toBe('1');
 expect(screen.getByRole('progressbar').parentElement?.className).toBe('downloadTaskProgress');
 expect(screen.getByRole('button').parentElement?.className).toBe('downloadTaskActions');
 useAcquisitionStore.setState({preparation:{id:'download',recipeId:'deepseek',state:'installing',lines:['Preparing tokenizer']}});
 view.rerender(<PreparationPanel/>);
 expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false);
});
