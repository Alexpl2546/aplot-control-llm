import { useEffect, useState } from "react";

function read<K extends string>(names: Record<K, string>) {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(Object.entries(names).map(([key, variable]) => [key, style.getPropertyValue(variable as string).trim() || "currentColor"])) as Record<K, string>;
}

/** Resolve chart colors again after theme changes. Callers supply a stable token mapping. */
export function useCssVars<K extends string>(names: Record<K, string>): Record<K, string> {
  const [values, setValues] = useState(() => read(names));
  useEffect(() => {
    const observer = new MutationObserver(() => setValues(read(names)));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    setValues(read(names));
    return () => observer.disconnect();
  }, [names]);
  return values;
}
