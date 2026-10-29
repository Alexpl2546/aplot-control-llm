import { Mic, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityOrb } from '../../components/ui/ActivityOrb';
import { cancelDictation, dictationLevel, startDictation, stopDictation } from '../../services/dictation';
import { isTauri } from '../../services/tauri';

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing';

/** Voice input for the chat, the same flow as the agent composer: record, then transcribe locally. */
export function useChatDictation(onText: (text: string) => void) {
  const { i18n } = useTranslation();
  const [phase, setPhase] = useState<Phase>('idle'), [levels, setLevels] = useState<number[]>([]), [elapsed, setElapsed] = useState(0), [error, setError] = useState('');
  const started = useRef(0), live = useRef(true);
  useEffect(() => () => { live.current = false; void cancelDictation().catch(() => undefined); }, []);
  useEffect(() => {
    if (phase !== 'recording') { setLevels([]); return; }
    let active = true, inflight = false;
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started.current) / 1000));
      if (inflight) return;
      inflight = true;
      dictationLevel().then(result => { if (active) setLevels(values => [...values.slice(-39), Math.min(1, Math.log10(1 + Math.max(0, result.rms ?? 0)) / 4)]); })
        .catch(() => undefined).finally(() => { inflight = false; });
    }, 150);
    return () => { active = false; clearInterval(timer); };
  }, [phase]);
  const start = async () => {
    if (phase !== 'idle') return;
    setError(''); setPhase('starting');
    try { await startDictation(i18n.language); started.current = Date.now(); setElapsed(0); if (live.current) setPhase('recording'); }
    catch (failure) { setError(String(failure)); setPhase('idle'); }
  };
  const stop = async () => {
    if (phase !== 'recording') return;
    setPhase('transcribing');
    try { const text = (await stopDictation()).trim(); if (!text) setError('no-speech'); else onText(text); }
    catch (failure) { setError(String(failure)); }
    finally { if (live.current) setPhase('idle'); }
  };
  const cancel = async () => { await cancelDictation().catch(() => undefined); setPhase('idle'); };
  return { phase, levels, elapsed, error, clearError: () => setError(''), start, stop, cancel, available: isTauri() };
}

type Dictation = ReturnType<typeof useChatDictation>;

export function ChatMicButton({ dictation, disabled }: { dictation: Dictation; disabled?: boolean }) {
  const { t } = useTranslation();
  if (dictation.phase !== 'idle') return null;
  return <button type="button" className="awComposerMic chatMic" aria-label={t('aw.io.voice')} title={t(dictation.available ? 'aw.io.voiceHint' : 'chat.voiceDesktopOnly')} disabled={disabled || !dictation.available} onClick={() => void dictation.start()}><Mic size={18}/></button>;
}

export function ChatDictationBar({ dictation }: { dictation: Dictation }) {
  const { t } = useTranslation();
  const { phase, levels, elapsed, error } = dictation;
  return <>
    {phase !== 'idle' && <div className="awDictation chatDictation">
      <div className="awDictationLabel" role="status"><ActivityOrb state={phase === 'recording' ? 'listening' : 'working'}/>{t(phase === 'recording' ? 'aw.io.recording' : phase === 'starting' ? 'aw.io.startingVoice' : 'aw.io.transcribing')}{phase === 'recording' && <time>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</time>}</div>
      <div className="awDictationWave" aria-hidden="true">{levels.map((level, index) => <i key={index} style={{ height: `${2 + level * 26}px` }}/>)}</div>
      {phase !== 'transcribing' && <button type="button" onClick={() => void dictation.cancel()} title={t('aw.io.cancelVoice')} aria-label={t('aw.io.cancelVoice')}><X size={17}/></button>}
      {phase === 'recording' && <button type="button" onClick={() => void dictation.stop()} title={t('aw.io.stopVoice')} aria-label={t('aw.io.stopVoice')}><Square size={16}/></button>}
    </div>}
    {error && <div className="awIoError" role="alert"><details><summary>{t(error.includes('no-speech') ? 'aw.io.noSpeech' : error.includes('voice-not-installed') ? 'chat.voiceNeedsHermes' : 'aw.io.failed')}</summary><pre>{error}</pre></details><button type="button" aria-label={t('aw.close')} onClick={dictation.clearError}><X size={14}/></button></div>}
  </>;
}
