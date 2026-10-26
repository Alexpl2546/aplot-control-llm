import { Check, ChevronDown, LoaderCircle, Search, X } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { autoUpdate, flip, FloatingFocusManager, FloatingPortal, hide, offset, platform, shift, size, useClick, useDismiss, useFloating, useInteractions, useListNavigation, useRole, useTransitionStyles, useTypeahead } from '@floating-ui/react';
import { useTranslation } from 'react-i18next';
import './AplotSelect.css';

export interface AplotOption {
  value: string;
  label: string;
  description?: string;
  keywords?: string;
  icon?: ReactNode;
  disabled?: boolean;
  group?: string;
}
export interface AplotSelectProps {
  id?: string;
  label: string;
  value: string;
  options: AplotOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  loading?: boolean;
  placeholder?: string;
  emptyText?: string;
  searchable?: boolean;
  variant?: 'compact' | 'model' | 'task';
  className?: string;
  describedBy?: string;
  labelledBy?: string;
  required?: boolean;
  triggerRef?: (element: HTMLButtonElement | null) => void;
  onBlur?: () => void;
}

export function filterSelectOptions(options: AplotOption[], query: string) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? options.filter(option => {
    const text = [option.label, option.description, option.keywords, option.group].filter(Boolean).join(' ').toLocaleLowerCase();
    return words.every(word => text.includes(word));
  }) : options;
}

/** Floating UI owns dismissal, focus, typeahead, navigation and collision handling. */
export function AplotSelect({id,label,value,options,onChange,disabled=false,invalid=false,loading=false,placeholder,emptyText,searchable,variant='compact',className='',describedBy,labelledBy,required,triggerRef,onBlur}:AplotSelectProps) {
  const {t}=useTranslation();
  const uid=useId(),listId=`${uid}-list`;
  const canSearch=searchable??(variant==='model'||options.length>7);
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[active,setActive]=useState<number|null>(null);
  const [portalRoot,setPortalRoot]=useState<HTMLElement|null>(null);
  const [reduced,setReduced]=useState(()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const search=useRef<HTMLInputElement>(null),list=useRef<HTMLDivElement>(null),items=useRef<(HTMLElement|null)[]>([]);
  const savedScroll=useRef(0),lastValue=useRef(value);
  const visible=useMemo(()=>filterSelectOptions(options,query),[options,query]);
  const labels=useRef<(string|null)[]>([]);
  labels.current=visible.map(option=>option.disabled?null:option.label);
  const zoom=Number.parseFloat(getComputedStyle(document.documentElement).zoom)||1;
  const selected=options.find(option=>option.value===value);
  const selectedIndex=visible.findIndex(option=>option.value===value);
  const enabled=!disabled&&!loading;
  const {refs,floatingStyles,context,placement,middlewareData,update,elements,x,y}=useFloating<HTMLButtonElement>({
    open:open&&enabled,onOpenChange(next){setOpen(next);if(next){setQuery('');setActive(null);}},
    placement:'bottom-start',strategy:'fixed',whileElementsMounted:autoUpdate,
    platform:{...platform,async getDimensions(element){
      // Top-layer popovers inherit CSS zoom, while the platform reports unscaled CSS sizes.
      if(element instanceof HTMLElement&&element.classList.contains('aplotSelectPositioner')&&zoom!==1){const rect=element.getBoundingClientRect();return {width:rect.width,height:rect.height};}
      return platform.getDimensions(element);
    }},
    middleware:[offset(6),flip({padding:8}),shift({padding:8}),size({padding:8,apply({availableHeight,availableWidth,rects,elements}){
      const scale=Number.parseFloat(getComputedStyle(document.documentElement).zoom)||1;
      // Floating coordinates are CSS pixels; CSS zoom changes the popup's rendered dimensions.
      Object.assign(elements.floating.style,{width:`${Math.min(Math.max(rects.reference.width,canSearch?280:200),availableWidth)/scale}px`,maxWidth:`${Math.max(0,availableWidth)/scale}px`});
      elements.floating.style.setProperty('--aplot-popup-height',`${Math.max(0,Math.min(320,availableHeight))/scale}px`);
    }}),hide({strategy:'referenceHidden'})],
  });
  useLayoutEffect(()=>setPortalRoot(elements.domReference?.closest('dialog')??null),[elements.domReference]);
  const setTrigger=useCallback((node:HTMLButtonElement|null)=>{refs.setReference(node);triggerRef?.(node);},[refs.setReference,triggerRef]);
  const navigation=useListNavigation(context,{listRef:items,activeIndex:active,selectedIndex,onNavigate:setActive,virtual:true,loop:false,focusItemOnOpen:!canSearch,scrollItemIntoView:false,disabledIndices:visible.flatMap((o,i)=>o.disabled?[i]:[])});
  const click=useClick(context,{enabled,ignoreMouse:false});
  const dismiss=useDismiss(context,{escapeKey:true,outsidePress:true,bubbles:{escapeKey:false}});
  const role=useRole(context,{role:canSearch?'combobox':'select'});
  const typeahead=useTypeahead(context,{listRef:labels,activeIndex:active,selectedIndex,onMatch:setActive,enabled:!canSearch});
  const {getReferenceProps,getFloatingProps,getItemProps}=useInteractions([click,dismiss,role,navigation,typeahead]);
  const {isMounted,styles:transition}=useTransitionStyles(context,{duration:reduced?0:{open:190,close:130},initial:({side})=>({opacity:0,transform:`translateY(${side==='top'?6:-6}px) scale(.985)`}),close:({side})=>({opacity:0,transform:`translateY(${side==='top'?3:-3}px) scale(.99)`})});

  useEffect(()=>{const media=window.matchMedia('(prefers-reduced-motion: reduce)');const change=()=>setReduced(media.matches);media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
  useEffect(()=>{if(disabled||loading)setOpen(false);},[disabled,loading]);
  useEffect(()=>{if(lastValue.current!==value){savedScroll.current=0;lastValue.current=value;setOpen(false);}},[value]);
  useEffect(()=>{if(middlewareData.hide?.referenceHidden)setOpen(false);},[middlewareData.hide?.referenceHidden]);
  useLayoutEffect(()=>{
    if(!isMounted||!refs.floating.current)return;
    const popup=refs.floating.current;
    if(typeof popup.showPopover==='function'&&!popup.matches(':popover-open'))popup.showPopover();
    void update();
    const scroller=list.current;
    if(scroller&&query==='')scroller.scrollTop=savedScroll.current;
  },[isMounted,elements.floating,update]);
  useLayoutEffect(()=>{
    if(!open||active===null)return;
    const scroller=list.current,item=items.current[active];if(!scroller||!item)return;
    const top=item.offsetTop,bottom=top+item.offsetHeight;
    if(top<scroller.scrollTop)scroller.scrollTop=top;
    else if(bottom>scroller.scrollTop+scroller.clientHeight)scroller.scrollTop=bottom-scroller.clientHeight;
  },[open,active]);
  useEffect(()=>{items.current.length=visible.length;setActive(index=>index!==null&&(index>=visible.length||visible[index]?.disabled)?null:index);},[visible]);
  const choose=(index:number)=>{const option=visible[index];if(!option||option.disabled)return;setOpen(false);onChange(option.value);};
  const keydown=(event:React.KeyboardEvent)=>{
    if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();setOpen(false);}
    else if(open&&(event.key==='Enter'||event.key===' '&&event.target===refs.domReference.current)){
      event.preventDefault();event.stopPropagation();if(active!==null)choose(active);else if(selectedIndex>=0)choose(selectedIndex);
    }else if(event.key==='Tab')setOpen(false);
    else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key))event.stopPropagation();
  };
  return <div className={`aplotSelect choiceSelect is-${variant} ${className}`} data-invalid={invalid||undefined}>
    <button {...getReferenceProps({onKeyDown:keydown,onBlur})} ref={setTrigger} type="button" id={id}
      className="aplotSelectTrigger" aria-label={labelledBy?undefined:label} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-invalid={invalid||undefined} aria-required={required||undefined} aria-controls={isMounted?listId:undefined} aria-expanded={open&&enabled} disabled={!enabled}>
      <span className="aplotSelectValue">{selected?.icon}<span>{selected?.label??placeholder??t('select.placeholder')}</span></span>{loading?<LoaderCircle className="aplotSelectLoading" size={15}/>:<ChevronDown className="aplotSelectChevron" size={15}/>}
    </button>
    {isMounted&&<FloatingPortal root={portalRoot??undefined}><FloatingFocusManager context={context} modal={false} initialFocus={canSearch?search:-1} returnFocus={refs.domReference} disabled={!open}>
      <div ref={refs.setFloating} popover={typeof HTMLElement.prototype.showPopover==='function'?'manual':undefined} className="aplotSelectPositioner" data-placement={placement} style={{...floatingStyles,transform:'none',left:(x??0)/zoom,top:(y??0)/zoom,visibility:middlewareData.hide?.referenceHidden?'hidden':undefined}} {...getFloatingProps({onKeyDown:keydown,role:undefined})}>
        <div className={`aplotSelectPopup is-${variant}`} style={{...transition,transformOrigin:placement.startsWith('top')?'bottom':'top'} as CSSProperties} data-state={open?'open':'closing'}>
          {canSearch&&<div className="aplotSelectSearch"><Search size={16}/><input ref={search} role="combobox" aria-label={t('select.searchLabel',{label})} aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={active!==null?`${uid}-option-${active}`:undefined} placeholder={t('select.search')} value={query} onChange={e=>{setQuery(e.target.value);setActive(null);if(list.current)list.current.scrollTop=0;}}/>{query&&<button type="button" aria-label={t('select.clear')} onClick={()=>{setQuery('');setActive(null);search.current?.focus();}}><X size={14}/></button>}</div>}
          <div ref={list} id={listId} role="listbox" aria-label={label} className="aplotSelectList" onScroll={e=>{if(!query)savedScroll.current=e.currentTarget.scrollTop;}}>
            {visible.length?visible.map((option,index)=><div {...getItemProps({onClick:()=>choose(index)})} ref={node=>{items.current[index]=node;}} key={option.value} id={`${uid}-option-${index}`} role="option" aria-selected={option.value===value} aria-disabled={option.disabled||undefined} data-active={index===active||undefined} className="aplotSelectOption">
              {option.icon&&<span className="aplotSelectOptionIcon">{option.icon}</span>}<span className="aplotSelectOptionText"><span>{option.label}</span>{(option.description||option.group)&&<small>{[option.description,option.group].filter(Boolean).join(' · ')}</small>}</span><Check className="aplotSelectCheck" size={15} aria-hidden="true" style={{visibility:option.value===value?'visible':'hidden'}}/>
            </div>):<p role="status" className="aplotSelectEmpty">{emptyText??t(options.length?'select.noResults':'select.empty')}</p>}
          </div>
          {canSearch&&<footer className="aplotSelectFooter"><span>{t('select.count',{count:visible.length})}</span><span aria-hidden="true">↑↓ · Enter</span></footer>}
        </div>
      </div>
    </FloatingFocusManager></FloatingPortal>}
  </div>;
}
export function AplotCombobox(props:AplotSelectProps){return <AplotSelect {...props} variant="model" searchable/>;}
export function AplotTaskSelect(props:AplotSelectProps){return <AplotSelect {...props} variant="task"/>;}
