import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";
export { NativeSelectAdapter as Select } from "./NativeSelectAdapter";
import { Inbox } from "lucide-react";

export function Panel({ children, className }: { children: ReactNode; className?: string }) { return <section className={clsx("panel", className)}>{children}</section>; }
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral"|"green"|"blue"|"orange"|"red"|"violet" }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
export function Button({ className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) { return <button className={clsx("uiButton", className)} {...props}>{children}</button>; }
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) { return <input className={clsx("uiInput", className)} {...props}/>; }
export function Switch({ checked, onChange, disabled, "aria-label": label }: { checked: boolean; onChange: (v:boolean)=>void; disabled?: boolean; "aria-label"?: string }) { return <button type="button" role="switch" disabled={disabled} aria-label={label} aria-checked={checked} className={clsx("switch", checked && "on")} onClick={()=>onChange(!checked)}><span/></button>; }
export function Progress({ value, tone = "blue" }: { value: number; tone?: string }) { return <div className={`uiProgress ${tone}`}><span style={{ width: `${Math.max(0,Math.min(100,value))}%` }}/></div>; }
export function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) { return <div className="emptyState"><div className="emptyIcon" aria-hidden="true"><Inbox size={22}/></div><h3>{title}</h3><p>{text}</p>{action}</div>; }
export function SectionTitle({ title, description, action }: { title:string; description?:string; action?:ReactNode }) { return <header className="sectionTitle"><div><h2>{title}</h2>{description && <p className="sectionDescription">{description}</p>}</div>{action}</header>; }
