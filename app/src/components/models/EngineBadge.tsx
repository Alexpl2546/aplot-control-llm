import type { ReactNode } from "react";
import type { ServerEngine } from "../../types/app";
import { ENGINE_NAMES } from "../../lib/engineModels";

export function EngineBadge({ engine, children }: { engine: ServerEngine; children?: ReactNode }) {
  return <span className="badge engineBadge" data-engine={engine}>
    <i className="engineBadgeDot" aria-hidden="true" />
    {ENGINE_NAMES[engine]}{children}
  </span>;
}
