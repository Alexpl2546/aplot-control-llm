// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../src/lib/i18n';
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog';

const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {configurable:true, value:function(this:HTMLDialogElement){this.setAttribute('open','');}});
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {configurable:true, value:function(this:HTMLDialogElement){this.removeAttribute('open');}});
});
afterEach(cleanup);
afterAll(() => {
  if(originalShow)Object.defineProperty(HTMLDialogElement.prototype,'showModal',originalShow);else Reflect.deleteProperty(HTMLDialogElement.prototype,'showModal');
  if(originalClose)Object.defineProperty(HTMLDialogElement.prototype,'close',originalClose);else Reflect.deleteProperty(HTMLDialogElement.prototype,'close');
});
const props={open:true,title:'Delete profile?',text:'The profile will be removed.',confirmLabel:'Delete',dangerous:true,onCancel:vi.fn(),onConfirm:vi.fn()};

describe('confirmation dialog',()=>{
  it('opens as a named modal, focuses cancel, handles native Escape and restores focus',()=>{
    const opener=document.createElement('button');document.body.append(opener);opener.focus();
    const cancelled=vi.fn();
    const {rerender}=render(<ConfirmDialog {...props} onCancel={cancelled}/>);
    const dialog=screen.getByRole('dialog',{name:'Delete profile?'});
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.activeElement?.textContent).toMatch(/Cancel|Отмена/);
    const escape=new Event('cancel',{cancelable:true});fireEvent(dialog,escape);
    expect(escape.defaultPrevented).toBe(true);expect(cancelled).toHaveBeenCalledTimes(1);
    rerender(<ConfirmDialog {...props} open={false}/>);
    expect(document.activeElement).toBe(opener);opener.remove();
  });

  it('blocks every dismissal path while an operation is busy',async()=>{
    const cancelled=vi.fn(),confirmed=vi.fn(),user=userEvent.setup();
    render(<ConfirmDialog {...props} busy onCancel={cancelled} onConfirm={confirmed}/>);
    const dialog=screen.getByRole('dialog');
    for(const button of screen.getAllByRole('button')){expect(button.hasAttribute('disabled')).toBe(true);await user.click(button);}
    fireEvent.mouseDown(dialog);fireEvent(dialog,new Event('cancel',{cancelable:true}));
    expect(cancelled).not.toHaveBeenCalled();expect(confirmed).not.toHaveBeenCalled();
  });

  it('guards repeated confirmation and dismissal until an asynchronous handler settles',async()=>{
    let finish!:()=>void;
    const cancelled=vi.fn(),confirmed=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;})),user=userEvent.setup();
    render(<ConfirmDialog {...props} onCancel={cancelled} onConfirm={confirmed}/>);
    await user.dblClick(screen.getByRole('button',{name:'Delete'}));
    expect(confirmed).toHaveBeenCalledTimes(1);
    for(const button of screen.getAllByRole('button')){expect(button.hasAttribute('disabled')).toBe(true);await user.click(button);}
    fireEvent.mouseDown(screen.getByRole('dialog'));fireEvent(screen.getByRole('dialog'),new Event('cancel',{cancelable:true}));
    expect(cancelled).not.toHaveBeenCalled();
    await act(async()=>finish());
    await waitFor(()=>expect(screen.getByRole('button',{name:'Delete'}).hasAttribute('disabled')).toBe(false));
  });

  it('shows a rejected confirmation as an accessible error and allows a retry',async()=>{
    const confirmed=vi.fn().mockRejectedValueOnce(new Error('Disk is full')).mockResolvedValueOnce(undefined),user=userEvent.setup();
    render(<ConfirmDialog {...props} onConfirm={confirmed}/>);
    await user.click(screen.getByRole('button',{name:'Delete'}));
    expect((await screen.findByRole('alert')).textContent).toContain('Disk is full');
    await user.click(screen.getByRole('button',{name:'Delete'}));
    expect(confirmed).toHaveBeenCalledTimes(2);expect(screen.queryByRole('alert')).toBeNull();
  });

  it('allows backdrop dismissal and never submits a surrounding form',async()=>{
    const cancelled=vi.fn(),confirmed=vi.fn(),submitted=vi.fn(),user=userEvent.setup();
    render(<form onSubmit={e=>{e.preventDefault();submitted();}}><ConfirmDialog {...props} onCancel={cancelled} onConfirm={confirmed}/></form>);
    await user.click(screen.getByRole('button',{name:'Delete'}));
    expect(confirmed).toHaveBeenCalledTimes(1);expect(submitted).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('dialog'));expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
