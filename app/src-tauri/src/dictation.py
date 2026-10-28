"""Standalone dictation for the chat: Hermes' recorder and local Whisper, no agent session.

Protocol: the first stdin line is {"home": ..., "language": ...}. Then each line is a
command — "level", "stop" or "cancel" — and each reply is one JSON line on stdout.
"""
import json
import os
import sys


# Replies own the real stdout; library chatter (download warnings, prints) goes to stderr.
REPLIES = sys.stdout
sys.stdout = sys.stderr


def reply(**payload):
    REPLIES.write(json.dumps(payload, ensure_ascii=False) + '\n')
    REPLIES.flush()


def main():
    request = json.loads(sys.stdin.readline())
    home = request['home']
    os.makedirs(home, exist_ok=True)
    os.environ['HERMES_HOME'] = home
    os.environ['HERMES_VOICE'] = '0'
    os.environ['HERMES_VOICE_TTS'] = '0'
    # JSON is valid YAML, so Hermes reads this as its config without PyYAML here.
    config = {
        'voice': {'thinking_sound': False, 'beep_enabled': False, 'beep_volume': 0,
                  'max_recording_seconds': 0, 'stop_phrases': []},
        'stt': {'enabled': True, 'provider': 'local',
                'local': {'model': 'base', 'device': 'cpu', 'compute_type': 'int8'},
                'language': request.get('language') or 'ru'},
    }
    with open(os.path.join(home, 'config.yaml'), 'w', encoding='utf-8') as file:
        json.dump(config, file, ensure_ascii=False)
    if os.name == 'nt':
        # NumPy's DLL initialisation can deadlock when first imported on an audio thread.
        import importlib
        for optional_audio in ('numpy', 'sounddevice'):
            try:
                importlib.import_module(optional_audio)
            except (ImportError, OSError):
                pass
    from hermes_cli import voice

    factory = voice.create_audio_recorder

    def manual_recorder():
        recorder = factory()
        start = recorder.start
        # Without a silence callback Hermes records until stop(), pauses included.
        recorder.start = lambda on_silence_stop=None: start(on_silence_stop=None)
        return recorder

    voice.create_audio_recorder = manual_recorder
    try:
        voice.start_recording()
    except Exception as error:
        reply(status='unavailable', error=str(error))
        return
    reply(status='recording')
    for line in sys.stdin:
        command = line.strip()
        recorder = getattr(voice, '_recorder', None)
        if command == 'level':
            recording = bool(recorder and getattr(recorder, '_recording', False))
            reply(rms=max(0, int(getattr(recorder, '_current_rms', 0))) if recording else 0)
        elif command == 'stop':
            reply(status='done', text=voice.stop_and_transcribe() or '')
            return
        elif command == 'cancel':
            if recorder is not None:
                try:
                    recorder.cancel()
                except Exception:
                    pass
            reply(status='cancelled')
            return


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        reply(status='failed', error=str(error))
