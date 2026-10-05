import type { ReactNode } from "react";

export function SettingRow({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return <div className="settingRow"><div><b>{label}</b>{help && <p>{help}</p>}</div><div>{children}</div></div>;
}
