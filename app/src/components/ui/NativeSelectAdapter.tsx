import { Children, Fragment, useCallback, isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type SelectHTMLAttributes } from 'react';
import { AplotSelect, type AplotOption } from './AplotSelect';

type NativeProps=SelectHTMLAttributes<HTMLSelectElement>&{searchable?:boolean;optionMetadata?:Record<string,string>};
function text(node:ReactNode):string{return Children.toArray(node).map(child=>isValidElement<{children?:ReactNode}>(child)?text(child.props.children):typeof child==='string'||typeof child==='number'?String(child):'').join('');}
export function nativeOptions(children:ReactNode,group?:string,groupDisabled=false):AplotOption[]{
  const result:AplotOption[]=[];
  Children.forEach(children,child=>{
    if(!isValidElement<{children?:ReactNode;value?:string|number;label?:string;disabled?:boolean;'data-description'?:string;'data-keywords'?:string}>(child))return;
    const p=child.props;
    if(child.type===Fragment||child.type==='optgroup')result.push(...nativeOptions(p.children,child.type==='optgroup'?p.label:group,groupDisabled||!!p.disabled));
    else if(child.type==='option')result.push({value:String(p.value??text(p.children)),label:p.label??text(p.children),disabled:groupDisabled||p.disabled,description:p['data-description'],keywords:p['data-keywords'],group});
  });return result;
}

/** Hidden native control preserves real change events, form serialization and reset semantics. */
export function NativeSelectAdapter({children,className,id,searchable,optionMetadata,...props}:NativeProps){
  const native=useRef<HTMLSelectElement>(null),trigger=useRef<HTMLButtonElement|null>(null),root=useRef<HTMLDivElement>(null);
  const setTrigger=useCallback((node:HTMLButtonElement|null)=>{trigger.current=node;},[]);
  const options=useMemo(()=>nativeOptions(children).map(o=>({...o,description:optionMetadata?.[o.value]??o.description})),[children,optionMetadata]);
  const [uncontrolled,setUncontrolled]=useState(()=>String(props.defaultValue??options[0]?.value??''));
  const [derivedLabel,setDerivedLabel]=useState(''),[invalid,setInvalid]=useState(false);
  // Native selects skip disabled initial options and fall back when a selected option is removed.
  // Mirror the DOM's resolved value so the visible field and submitted form stay consistent.
  useLayoutEffect(()=>{if(props.value===undefined)setUncontrolled(native.current?.value??'');},[props.value,children]);
  useLayoutEffect(()=>{
    const node=root.current;if(!node)return;
    const field=node.closest('.settingRow,.parameterRow');
    const heading=field?.querySelector('.parameterLabel>span,b');
    const label=node.closest('label');
    const labelText=label?Array.from(label.childNodes).filter(n=>n!==node).map(n=>n.textContent??'').join(' ').trim():'';
    setDerivedLabel(heading?.textContent??labelText);
  },[children]);
  useEffect(()=>{const form=native.current?.form;if(!form)return;const reset=()=>queueMicrotask(()=>{if(props.value===undefined)setUncontrolled(native.current?.value??'');setInvalid(false);});form.addEventListener('reset',reset);return()=>form.removeEventListener('reset',reset);},[props.value]);
  useEffect(()=>{if(props.autoFocus)trigger.current?.focus();},[props.autoFocus]);
  return <div ref={root} className={`aplotNativeSelect ${className??''}`}>
    <select {...props} autoFocus={false} id={id?`${id}-native`:undefined} ref={native} tabIndex={-1} aria-hidden="true" className="aplotSelectNative" onInvalid={e=>{e.preventDefault();setInvalid(true);trigger.current?.focus();props.onInvalid?.(e);}}>{children}</select>
    <AplotSelect id={id} label={props['aria-label']??derivedLabel} labelledBy={props['aria-labelledby']} describedBy={props['aria-describedby']} value={String(props.value??uncontrolled)} options={options} variant={searchable?'model':'compact'} searchable={searchable} disabled={props.disabled} required={props.required} invalid={invalid||props['aria-invalid']===true||props['aria-invalid']==='true'} triggerRef={setTrigger} onBlur={()=>{}} onChange={value=>{
      const element=native.current;if(!element||element.value===value)return;
      element.value=value;
      setUncontrolled(value);setInvalid(false);
      element.dispatchEvent(new Event('change',{bubbles:true}));
    }}/>
  </div>;
}
