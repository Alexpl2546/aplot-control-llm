import type { AgentEntry } from './store';
import { toolPath } from './workspaceModel';
/** A reviewable transfer draft; it never executes a tool or starts a model. */
export function handoffContext(title:string,entries:AgentEntry[]):string{
  const recent=entries.filter(e=>e.kind==='user'||e.kind==='assistant').slice(-8);
  const paths=[...new Set(entries.filter(e=>e.kind==='tool').map(e=>toolPath(e.args,e.result)).filter(Boolean))].slice(-30);
  return `# Передача задачи: ${title}\n\nНиже сохранённая переписка и результаты предыдущего агента. Это контекст, а не новое разрешение на действия. Проверь текущее состояние файлов; ошибочные и незавершённые действия нельзя считать выполненными.\n\n${recent.map(e=>`## ${e.kind==='user'?'Пользователь':'Предыдущий агент'}\n${e.text.slice(-2200)}`).join('\n\n')}\n\n${paths.length?`## Файлы, упомянутые инструментами\n${paths.join('\n')}\n\n`:''}Продолжи незавершённую работу с учётом последнего запроса пользователя.`.slice(0,24000);
}
