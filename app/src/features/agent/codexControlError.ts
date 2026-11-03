import type { TFunction } from 'i18next';

const messages: Record<string, string> = {
  busy: 'Codex is already working on this task.',
  stale: 'This turn changed. Try again on the current turn.',
  closed: 'The Codex session has ended. Start a new task.',
  changed: 'The Codex connection changed. Reopen the task to continue.',
  timeout: 'Codex did not confirm the request. Check the task before retrying.',
  'message-limit': 'Shorten the direction and try again.',
  'command-conflict': 'This request ID was already used for different input.',
  generic: 'Codex could not complete that control. Try again.',
};

export function codexControlError(cause: unknown, t: TFunction) {
  const raw = String(cause).replace(/^Error:\s*/, '').trim();
  const name = raw.split(/[\s:]/, 1)[0]?.toLowerCase() ?? '';
  const code = Object.hasOwn(messages, name) ? name : 'generic';
  return t(`codex.controls.errors.${code}`, {
    defaultValue: messages[code],
  }).slice(0, 180);
}
