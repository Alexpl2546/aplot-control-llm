// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import '../src/lib/i18n';
import { AplotSelect,AplotCombobox,AplotTaskSelect,filterSelectOptions } from '../src/components/ui/AplotSelect';
import { NativeSelectAdapter,nativeOptions } from '../src/components/ui/NativeSelectAdapter';

beforeAll(()=>{
  Object.defineProperty(document.documentElement,'clientWidth',{get:()=>1024});Object.defineProperty(document.documentElement,'clientHeight',{get:()=>768});
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(()=>({x:30,y:30,top:30,left:30,right:330,bottom:70,width:300,height:40,toJSON:()=>({})}));
  window.matchMedia=vi.fn(()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()})) as unknown as typeof window.matchMedia;});
afterEach(cleanup);
const options=[{value:'a',label:'Alpha',description:'128K · Q4'},{value:'b',label:'Beta',disabled:true},{value:'c',label:'Gamma',description:'64K · CUDA'}];
function Controlled(){const[value,setValue]=useState('a');return <AplotSelect label="Model" value={value} onChange={setValue} options={options}/>;}

describe('Glass Select interactions',()=>{
  it('selects with the mouse, restores focus and allows the same option to close the menu',async()=>{
    const user=userEvent.setup();render(<Controlled/>);const trigger=screen.getByRole('combobox');
    await user.click(trigger);await user.click(screen.getByRole('option',{name:/Gamma/}));
    await waitFor(()=>expect(screen.queryByRole('listbox')).toBeNull());expect(trigger.textContent).toContain('Gamma');expect(document.activeElement).toBe(trigger);
    await user.click(trigger);await user.click(screen.getByRole('option',{name:/Gamma/}));await waitFor(()=>expect(screen.queryByRole('listbox')).toBeNull());
  });
  it('navigates with arrows/Home/End, skips disabled values, selects with Enter and closes with Escape',async()=>{
    const user=userEvent.setup();render(<Controlled/>);const trigger=screen.getByRole('combobox');trigger.focus();
    await user.keyboard('{ArrowDown}{End}{Enter}');await waitFor(()=>expect(trigger.textContent).toContain('Gamma'));
    await user.keyboard('{ArrowDown}{Home}{ArrowDown}{Enter}');expect(trigger.textContent).toContain('Gamma');
    await user.click(trigger);await user.keyboard('{Escape}');await waitFor(()=>expect(screen.queryByRole('listbox')).toBeNull());
  });
  it('searches real metadata case-insensitively, shows no matches and clears search',async()=>{
    const user=userEvent.setup();render(<AplotCombobox label="Model" value="a" onChange={vi.fn()} options={options}/>);
    await user.click(screen.getByRole('combobox'));const search=await screen.findByRole('combobox',{name:/Search:|Поиск:/});
    await user.type(search,'cuda');expect(screen.getAllByRole('option')).toHaveLength(1);expect(screen.getByRole('option').textContent).toContain('Gamma');
    await user.clear(search);await user.type(search,'unknown');expect(screen.queryAllByRole('option')).toHaveLength(0);expect(screen.getByRole('status')).toBeTruthy();
    await user.click(screen.getByRole('button',{name:/Clear search|Очистить поиск/}));expect(screen.getAllByRole('option')).toHaveLength(3);
  });
  it('closes on outside press and leaves disabled controls inert',async()=>{
    const user=userEvent.setup();render(<><AplotSelect label="Disabled" value="a" options={options} disabled onChange={vi.fn()}/><Controlled/><button>Outside</button></>);
    await user.click(screen.getByRole('combobox',{name:'Disabled'}));expect(screen.queryByRole('listbox')).toBeNull();
    await user.click(screen.getByRole('combobox',{name:'Model'}));await user.click(screen.getByRole('button',{name:'Outside'}));await waitFor(()=>expect(screen.queryByRole('listbox')).toBeNull());
  });
  it('keeps empty controls usable so an honest empty state can be read',async()=>{
    const user=userEvent.setup();render(<AplotTaskSelect label="Task" value="" options={[]} onChange={vi.fn()}/>);await user.click(screen.getByRole('combobox'));expect(screen.getByRole('status')).toBeTruthy();
  });
});
describe('native handler compatibility',()=>{
  it('mirrors the native fallback when options are disabled or removed',()=>{
    const {rerender}=render(<NativeSelectAdapter aria-label="Engine" name="engine"><option key="one" value="one" disabled>One</option><option key="two" value="two">Two</option></NativeSelectAdapter>);
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('two');
    expect(screen.getByRole('combobox').textContent).toContain('Two');
    rerender(<NativeSelectAdapter aria-label="Engine" name="engine"><option key="three" value="three">Three</option></NativeSelectAdapter>);
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('three');
    expect(screen.getByRole('combobox').textContent).toContain('Three');
  });
  it('dispatches a real select change with value/name and preserves form data',async()=>{
    const user=userEvent.setup(),changed=vi.fn();render(<form aria-label="Settings"><label>Engine<NativeSelectAdapter name="engine" defaultValue="one" onChange={e=>changed(e.target.value,e.target.name)}><option value="one">One</option><option value="two">Two</option></NativeSelectAdapter></label></form>);
    await user.click(screen.getByRole('combobox',{name:'Engine'}));await user.click(screen.getByRole('option',{name:'Two'}));expect(changed).toHaveBeenCalledWith('two','engine');expect(new FormData(screen.getByRole('form') as HTMLFormElement).get('engine')).toBe('two');
    await waitFor(()=>expect(screen.queryByRole('listbox')).toBeNull());await user.click(screen.getByRole('combobox'));await user.click(screen.getByRole('option',{name:'Two'}));expect(changed).toHaveBeenCalledTimes(1);
    await act(async()=>{(screen.getByRole('form') as HTMLFormElement).reset();});expect(screen.getByRole('combobox').textContent).toContain('One');
  });
  it('keeps option groups, disabled choices and implicit option values',()=>{
    expect(nativeOptions(<optgroup label="Group" disabled><option>Auto</option><option value="off">Off</option></optgroup>)).toEqual([{value:'Auto',label:'Auto',group:'Group',disabled:true,description:undefined,keywords:undefined},{value:'off',label:'Off',group:'Group',disabled:true,description:undefined,keywords:undefined}]);
  });
  it('searches a large catalogue by all query words',()=>{
    const large=Array.from({length:10000},(_,i)=>({value:String(i),label:`Model ${i}`,description:i%2?'64K Vulkan':'128K CUDA'}));
    expect(filterSelectOptions(large,'MODEL 9998 cuda').map(o=>o.value)).toEqual(['9998']);
  });
});

describe('additional accessibility states',()=>{
 it('selects a filtered model with the keyboard and restores trigger focus',async()=>{
  const user=userEvent.setup(),changed=vi.fn();render(<AplotCombobox label="Model" value="a" options={options} onChange={changed}/>);const trigger=screen.getByRole('combobox');await user.click(trigger);const search=await screen.findByRole('combobox',{name:/Search:|Поиск:/});await user.type(search,'cuda');await user.keyboard('{ArrowDown}{Enter}');expect(changed).toHaveBeenCalledWith('c');await waitFor(()=>expect(screen.queryByRole('listbox')).toBeNull());expect(document.activeElement).toBe(trigger);
 });
 it('redirects required form validation to the visible trigger and makes loading inert',async()=>{
  const user=userEvent.setup();render(<><NativeSelectAdapter aria-label="Required" required defaultValue=""><option value="">Choose</option><option value="x">X</option></NativeSelectAdapter><AplotSelect label="Loading" value="" options={[]} loading invalid onChange={vi.fn()}/></>);fireEvent.invalid(document.querySelector('select')!);const required=screen.getByRole('combobox',{name:'Required'});expect(required.getAttribute('aria-invalid')).toBe('true');expect(document.activeElement).toBe(required);const loading=screen.getByRole('combobox',{name:'Loading'});await user.click(loading);expect(loading.hasAttribute('disabled')).toBe(true);expect(screen.queryByRole('listbox')).toBeNull();
 });
});
