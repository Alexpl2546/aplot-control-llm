import type { AgentPreset } from './workspaceModel';

export const AGENT_AVATARS = [
  { id: 'requirements_analyst', file: '01_requirements_analyst', template: 'analyst' },
  { id: 'architect', file: '02_architect', template: 'architect' },
  { id: 'security_auditor', file: '03_security_auditor', template: 'security' },
  { id: 'backend_developer', file: '04_backend_developer', template: 'backend' },
  { id: 'ui_designer', file: '05_ui_designer', template: 'designer' },
  { id: 'code_reviewer', file: '06_code_reviewer', template: 'reviewer' },
  { id: 'qa_tester', file: '07_qa_tester', template: 'tester' },
  { id: 'technical_writer', file: '08_technical_writer', template: 'writer' },
  { id: 'frontend_developer', file: '09_frontend_developer', template: 'frontend' },
  { id: 'devops_engineer', file: '10_devops_engineer', template: 'devops' },
  { id: 'neutral_graphite', file: '11_neutral_graphite', template: 'orchestrator' },
  { id: 'neutral_white', file: '12_neutral_white' },
  { id: 'neutral_sand', file: '13_neutral_sand' },
  { id: 'neutral_navy', file: '14_neutral_navy' },
  { id: 'neutral_olive', file: '15_neutral_olive' },
  { id: 'neutral_terracotta', file: '16_neutral_terracotta' },
] as const;

export function bundledAvatar(value?: string) {
  return AGENT_AVATARS.find(avatar => value === `builtin:${avatar.id}` || value === avatar.id);
}

export function avatarSource(value?: string, animated = false): string | undefined {
  const avatar = bundledAvatar(value);
  if (avatar) return `${import.meta.env.BASE_URL}agent-avatars/${animated ? 'webp' : 'png'}/${avatar.file}.${animated ? 'webp' : 'png'}`;
  return value?.startsWith('data:image/') ? value : undefined;
}

export function presetAvatar(preset?: Pick<AgentPreset, 'avatar' | 'templateId'>) {
  if (preset?.avatar !== undefined) return preset.avatar || undefined;
  const avatar = AGENT_AVATARS.find(item => 'template' in item && item.template === preset?.templateId);
  return avatar ? `builtin:${avatar.id}` : undefined;
}
