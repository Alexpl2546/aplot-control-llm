import { useTranslation } from 'react-i18next';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { cloudSelection,connectionOptions,useOpenAi } from './store';

export function CloudProfileSelect({provider,profileId,connectionId,disabled,onChange,purpose='agent'}:{provider:'openai'|'claude';profileId?:string;connectionId?:string;disabled?:boolean;onChange:(id:string)=>void;purpose?:'agent'|'chat'}){
  const s=useOpenAi(),{t}=useTranslation(),selected=cloudSelection(s,provider,connectionId,profileId,purpose).profile;
  return <ChoiceSelect variant="model" label={t('profiles.selection')} value={selected?.id??''} disabled={disabled} options={connectionOptions(s,provider,purpose)} onChange={onChange}/>;
}
