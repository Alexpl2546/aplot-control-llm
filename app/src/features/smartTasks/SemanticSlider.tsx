import { useId, type ComponentType, type ReactNode } from 'react';

interface Props {
  icon: ComponentType<{ size?: number }>;
  title: string;
  description: string;
  value: number;
  min?: number;
  max: number;
  display: string;
  marks: string[];
  onChange: (value: number) => void;
  extra?: ReactNode;
}
export function SemanticSlider({ icon: Icon, title, description, value, min = 0, max, display, marks, onChange, extra }: Props) {
  const id = useId();
  const percent = (value - min) / (max - min) * 100;
  return <div className="taskSliderRow">
    <div className="taskSliderLabel"><span className="taskSliderIcon"><Icon size={20}/></span><div><label htmlFor={id}>{title}</label><p id={`${id}-hint`}>{description}</p></div></div>
    <div className="taskSliderControl">
      <input id={id} type="range" min={min} max={max} step={1} value={value} aria-valuetext={display} aria-describedby={`${id}-hint`} onChange={e => onChange(Number(e.target.value))} style={{ '--task-fill': `${percent}%` } as React.CSSProperties}/>
      <div className="taskSliderMarks" aria-hidden="true">{marks.map(mark => <span key={mark}>{mark}</span>)}</div>
    </div>
    <div className="taskSliderValue"><output htmlFor={id}>{display}</output>{extra}</div>
  </div>;
}
