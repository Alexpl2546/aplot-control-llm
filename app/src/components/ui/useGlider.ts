import { useLayoutEffect, useRef } from "react";

/**
 * A highlight that slides between options, like the sidebar's active-item glider.
 * The host gets `kGlideHost`, its options `data-glide`, and a `<span className="kGlide"/>` child;
 * this hook keeps the span over the option at `index`.
 */
export function useGlider<T extends HTMLElement>(index: number) {
  const host = useRef<T>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const place = () => {
      const item = element.querySelectorAll<HTMLElement>(":scope > [data-glide]")[index];
      element.style.setProperty("--glide-o", item ? "1" : "0");
      if (!item) return;
      element.style.setProperty("--glide-x", `${item.offsetLeft}px`);
      element.style.setProperty("--glide-y", `${item.offsetTop}px`);
      element.style.setProperty("--glide-w", `${item.offsetWidth}px`);
      element.style.setProperty("--glide-h", `${item.offsetHeight}px`);
    };
    place();
    // The first placement is instant; only later moves animate.
    const frame = requestAnimationFrame(() => { element.dataset.glideReady = ""; });
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    resize?.observe(element);
    return () => { cancelAnimationFrame(frame); resize?.disconnect(); };
  }, [index]);
  return host;
}
