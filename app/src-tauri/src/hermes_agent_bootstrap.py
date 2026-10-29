"""Private Hermes home for one Aplot conversation; RPC owns stdin after bootstrap."""
import json
import os
from pathlib import Path
import sys


def configure(request):
    import yaml
    home = Path(request['home'])
    home.mkdir(parents=True, exist_ok=True)
    path = home / 'config.yaml'
    # Hermes stores explicit "always" approvals in this task's private config.
    # Preserve that one field when refreshing model/runtime configuration;
    # never import providers, credentials or MCP from another Hermes home.
    allowlist = []
    if path.is_file():
        previous = yaml.safe_load(path.read_text(encoding='utf-8'))
        raw = previous.get('command_allowlist', []) if isinstance(previous, dict) else []
        if isinstance(raw, list) and all(isinstance(item, str) for item in raw):
            allowlist = raw
    os.environ['HERMES_HOME'] = str(home)
    os.environ['HERMES_TUI_TOOLSETS'] = 'file,terminal,skills,memory,todo,clarify'
    os.environ['TERMINAL_CWD'] = request['cwd']
    # Dictation is explicitly started by the UI; never inherit a voice/TTS mode
    # from the shell that launched Aplot.
    os.environ['HERMES_VOICE'] = '0'
    os.environ['HERMES_VOICE_TTS'] = '0'
    target = request['target']
    access = request.get('accessMode', 'manual')
    toolsets = ['file', 'skills', 'memory', 'todo', 'clarify']
    if access != 'restricted':
        toolsets.insert(1, 'terminal')
    os.environ['HERMES_TUI_TOOLSETS'] = ','.join(toolsets)
    # This directory belongs exclusively to this embedded conversation. Never import Desktop credentials/MCP.
    config = {
        'model': {'default': target['modelId'], 'provider': 'custom:aplot'},
        'custom_providers': [{'name': 'aplot', 'model': target['modelId'],
            'base_url': target['baseUrl'], 'api_key': target.get('apiKey') or 'aplot-local',
            'api_mode': 'chat_completions', 'context_length': target['contextTokens']}],
        'fallback_model': [], 'fallback_providers': [], 'mcp_servers': {},
        'toolsets': toolsets,
        'agent': {'max_turns': 20, 'run_budget_seconds': 600, 'system_prompt': request['instruction'], 'image_input_mode': 'native',
                  **({'reasoning_effort': request['reasoning']} if request.get('reasoning') else {})},
        'terminal': {'backend': 'local', 'cwd': request['cwd'], 'timeout': 120},
        'approvals': {'mode': 'off' if access == 'full' else 'manual', 'timeout': 300},
        'command_allowlist': allowlist,
        # The embedded UI reports progress visually. Hermes' gateway otherwise
        # plays ambient bubbles during ordinary text turns by default.
        'voice': {'thinking_sound': False, 'beep_enabled': False, 'beep_volume': 0,
                  'max_recording_seconds': 0, 'stop_phrases': []},
        'display': {'bell_on_complete': False, 'bell_on_prompt': False},
        'stt': {'enabled': True, 'provider': 'local', 'local': {'model': 'base', 'device': 'cpu', 'compute_type': 'int8'}, 'language': 'ru'},
        'skills': {'external_dirs': [request['skills']] if request.get('skills') else []},
    }
    path.write_text(yaml.safe_dump(config, allow_unicode=True), encoding='utf-8')
    return config


def install_manual_dictation(voice=None):
    """Adapt this private worker only: keep Hermes STT, remove VAD auto-stop."""
    if voice is None:
        from hermes_cli import voice
    factory = voice.create_audio_recorder
    if getattr(factory, '_aplot_manual', False):
        return

    def create_manual_recorder():
        recorder = factory()
        start = recorder.start

        def manual_start(on_silence_stop=None):
            # Without a callback Hermes captures every block, including pauses,
            # until stop()/cancel(). Peak RMS is still tracked for speech checks.
            return start(on_silence_stop=None)

        recorder.start = manual_start
        return recorder

    create_manual_recorder._aplot_manual = True
    voice.create_audio_recorder = create_manual_recorder


def install_voice_level_rpc():
    from tui_gateway import server
    from hermes_cli import voice

    def level(request_id, _params):
        recorder = getattr(voice, '_continuous_recorder', None)
        recording = bool(recorder and getattr(recorder, '_recording', False))
        return server._ok(request_id, {
            'recording': recording,
            'rms': max(0, int(getattr(recorder, '_current_rms', 0))) if recording else 0,
        })

    server.register_method('aplot.voice.level', level)


if __name__ == '__main__':
    try:
        configure(json.loads(sys.stdin.readline()))
        # On Windows NumPy's native DLL initialization can deadlock when its first
        # import happens in the gateway's voice worker. Importing optional audio
        # modules here does not open the microphone or load a Whisper model.
        if os.name == 'nt':
            import importlib
            for optional_audio in ('numpy', 'sounddevice'):
                try:
                    importlib.import_module(optional_audio)
                except (ImportError, OSError):
                    pass
        install_manual_dictation()
        install_voice_level_rpc()
        from tui_gateway.entry import main
        main()
    except Exception:
        print(json.dumps({'aplot_error': 'runtime-failed'}), flush=True)
        sys.exit(1)
