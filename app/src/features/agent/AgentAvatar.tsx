import { useState } from 'react';
import { avatarSource, bundledAvatar } from './agentAvatars';
import './agentAvatars.css';

/** Portraits retain their transparency and aspect ratio. Activity and hover enable motion. */
export function AgentAvatar({ avatar, color, size = 28, animate = false, animationEnabled = true }: {
  avatar?: string; color?: string; size?: number; animate?: boolean; animationEnabled?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [failedSource, setFailedSource] = useState<string>();
  const still = avatarSource(avatar);
  const source = avatarSource(avatar, animationEnabled && (animate || hovered));
  const visible = source && failedSource !== source;
  return <span className={`agentAvatar${visible ? ' hasPortrait' : ''}`} style={{ width: size, height: size, ['--c' as string]: color ?? 'var(--series-1)' }}
    aria-hidden="true" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
    {visible && <picture>
      {bundledAvatar(avatar) && <source media="(prefers-reduced-motion: reduce)" srcSet={still}/>}
      <img src={source} alt="" loading="lazy" decoding="async" onError={() => setFailedSource(source)}/>
    </picture>}
  </span>;
}
