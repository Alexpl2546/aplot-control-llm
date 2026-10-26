import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Children, isValidElement, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { copyChatText } from './clipboard';

function textContent(node: ReactNode): string {
  return Children.toArray(node).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : isValidElement<{children?:ReactNode}>(child) ? textContent(child.props.children) : '').join('');
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useTranslation(), [copy,setCopy] = useState<{code:string;ok:boolean}>();
  const code = textContent(children);
  const status = copy?.code === code ? copy.ok ? 'copied' : 'failed' : 'idle';
  const language = Children.toArray(children).find(isValidElement);
  const className = isValidElement<{className?:string}>(language) ? language.props.className ?? '' : '';
  return <div className="chatCode"><header><span>{className.replace('language-','')}</span><button type="button" onClick={()=>{void copyChatText(code).then(ok=>setCopy({code,ok}));}}>{t(status==='copied'?'chat.copied':status==='failed'?'chat.copyFailed':'chat.copy')}</button></header><pre>{children}</pre></div>;
}
const components: Components = {
  pre: ({children}) => <CodeBlock>{children}</CodeBlock>,
  table: ({children}) => <div className="chatTable"><table>{children}</table></div>,
  a: ({href,children}) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
  // Model output never triggers remote image requests or executes embedded HTML.
  img: ({alt}) => <span>{alt}</span>,
};
const plugins = [remarkGfm];
export function MessageText({ text }: { text: string }) {
  return <div className="chatMessageText chatMarkdown"><Markdown remarkPlugins={plugins} components={components} skipHtml>{text}</Markdown></div>;
}
