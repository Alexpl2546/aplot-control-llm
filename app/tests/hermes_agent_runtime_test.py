"""Real installed Hermes + isolated home + deterministic local OpenAI fixture."""
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import runpy
import sys
from types import SimpleNamespace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(os.environ.get('APLOT_HERMES_TEST_ROOT', str(Path(os.environ.get('LOCALAPPDATA', '')) / 'hermes/hermes-agent')))
PYTHON = next((path for path in [ROOT / 'venv/Scripts/python.exe', ROOT / '.venv/Scripts/python.exe'] if path.exists()), ROOT / 'venv/Scripts/python.exe')
BOOTSTRAP = Path(__file__).parents[1] / 'src-tauri/src/hermes_agent_bootstrap.py'


@unittest.skipUnless(PYTHON.exists(), 'installed Hermes required')
class RuntimeTest(unittest.TestCase):
    def test_task_approvals_survive_bootstrap_without_importing_external_services(self):
        import yaml
        configure=runpy.run_path(str(BOOTSTRAP))['configure']
        with tempfile.TemporaryDirectory(prefix='aplot-permanent-test-') as temporary, patch.dict(os.environ):
            home=Path(temporary)
            path=home/'config.yaml'
            path.write_text(yaml.safe_dump({'command_allowlist':['python-inline'], 'mcp_servers':{'old':{'command':'not-run'}},'custom_providers':[{'api_key':'must-not-survive'}]}),encoding='utf-8')
            request={'home':str(home),'cwd':str(home),'target':{'modelId':'fixture','baseUrl':'http://127.0.0.1:8080/v1','contextTokens':131072},'instruction':'fixture','accessMode':'restricted'}
            config=configure(request)
            self.assertEqual(config['command_allowlist'],['python-inline'])
            self.assertEqual(config['mcp_servers'],{})
            self.assertNotIn('terminal',config['toolsets'])
            self.assertEqual(config['approvals']['mode'],'manual')
            self.assertFalse(config['voice']['thinking_sound'])
            self.assertFalse(config['voice']['beep_enabled'])
            self.assertEqual(config['voice']['max_recording_seconds'],0)
            self.assertEqual(os.environ['HERMES_VOICE'],'0')
            self.assertEqual(os.environ['HERMES_VOICE_TTS'],'0')
            request['accessMode']='full';request['target']['modelId']='different-model'
            config=configure(request)
            self.assertEqual(config['command_allowlist'],['python-inline'])
            self.assertEqual(config['approvals']['mode'],'off')
            self.assertIn('terminal',config['toolsets'])
            self.assertNotIn('must-not-survive',path.read_text(encoding='utf-8'))

    def test_manual_capture_preserves_silence_and_meter_without_using_microphone(self):
        sys.path.insert(0,str(ROOT))
        import numpy as np
        from tools import voice_mode
        bootstrap=runpy.run_path(str(BOOTSTRAP))
        recorder=voice_mode.AudioRecorder()
        fake=SimpleNamespace(create_audio_recorder=lambda:recorder)
        bootstrap['install_manual_dictation'](fake)
        callback_calls=[]
        with patch.object(voice_mode,'_default_input_samplerate',return_value=16000), patch.object(recorder,'_ensure_stream'):
            fake.create_audio_recorder().start(on_silence_stop=lambda:callback_calls.append(True))
        self.assertIsNone(recorder._on_silence_stop)
        # Over six seconds of silence after speech, above the old three-second VAD limit.
        recorder._on_audio_block(np,np.full((1600,1),1500,dtype=np.int16))
        for _ in range(65):recorder._on_audio_block(np,np.zeros((1600,1),dtype=np.int16))
        self.assertTrue(recorder._recording)
        self.assertEqual(len(recorder._frames),66)
        self.assertEqual(callback_calls,[])
        self.assertGreater(recorder._peak_rms,0)
        self.assertEqual(recorder._current_rms,0)
        recorder.cancel()
        self.assertFalse(recorder._recording)

    def test_file_tool_clarification_and_followup_in_same_session(self):
        requests = []
        class Fixture(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
                self.wfile.write(json.dumps({'data': [{'id': 'aplot-fixture', 'context_length': 131072}]}).encode())
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(body)
                messages = body.get('messages', [])
                results = [m for m in messages if m.get('role') == 'tool']
                user = next((str(m.get('content')) for m in reversed(messages) if m.get('role') == 'user'), '')
                if 'ALWAYS' in user:
                    call_id = 'always-2' if 'AGAIN' in user else 'always-1'
                    if not any(m.get('tool_call_id') == call_id for m in results):
                        delta = {'tool_calls': [{'index': 0, 'id': call_id, 'type': 'function', 'function': {'name': 'terminal', 'arguments': json.dumps({'command': 'python -c \"print(82)\"'})}}]}; reason = 'tool_calls'
                    else:
                        delta = {'content': 'Always complete.'}; reason = 'stop'
                elif 'INTERRUPT' in user:
                    delta = {'tool_calls': [{'index': 0, 'id': 'clarify-stop', 'type': 'function', 'function': {'name': 'clarify', 'arguments': json.dumps({'questions': [{'question': 'Wait for cancellation?'}]})}}]}; reason = 'tool_calls'
                elif 'FOLLOWUP' in user:
                    delta = {'content': 'Follow-up complete.'}; reason = 'stop'
                elif not results:
                    delta = {'tool_calls': [{'index': 0, 'id': 'skill-1', 'type': 'function', 'function': {'name': 'skill_view', 'arguments': json.dumps({'name': 'aplot-fixture-skill'})}}]}; reason = 'tool_calls'
                elif len(results) == 1:
                    delta = {'tool_calls': [{'index': 0, 'id': 'read-1', 'type': 'function', 'function': {'name': 'read_file', 'arguments': json.dumps({'path': str(workspace / 'sample.txt')})}}]}; reason = 'tool_calls'
                elif len(results) == 2:
                    delta = {'tool_calls': [{'index': 0, 'id': 'clarify-1', 'type': 'function', 'function': {'name': 'clarify', 'arguments': json.dumps({'questions': [{'question': 'Continue?', 'choices': ['Yes', 'No']}]})}}]}; reason = 'tool_calls'
                elif len(results) == 3:
                    delta = {'tool_calls': [{'index': 0, 'id': 'terminal-1', 'type': 'function', 'function': {'name': 'terminal', 'arguments': json.dumps({'command': 'rm -rf sample.txt'})}}]}; reason = 'tool_calls'
                else:
                    delta = {'content': 'File and clarification complete.'}; reason = 'stop'
                self.send_response(200); self.send_header('Content-Type', 'text/event-stream' if body.get('stream') else 'application/json'); self.end_headers()
                if body.get('stream'):
                    for item in [{'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]}, {'choices': [{'index': 0, 'delta': {}, 'finish_reason': reason}]}]:
                        self.wfile.write(('data: '+json.dumps({'id': 'fixture', 'object': 'chat.completion.chunk', 'model': 'aplot-fixture', **item})+'\n\n').encode())
                    self.wfile.write(b'data: [DONE]\n\n')
                else:
                    self.wfile.write(json.dumps({'id': 'fixture', 'choices': [{'index': 0, 'message': {'role': 'assistant', **delta}, 'finish_reason': reason}], 'usage': {'prompt_tokens': 10, 'completion_tokens': 2, 'total_tokens': 12}}).encode())
        with tempfile.TemporaryDirectory(prefix='aplot-agent-test-') as temporary:
            workspace = Path(temporary) / 'workspace'; workspace.mkdir(); (workspace / 'sample.txt').write_text('fixture-file-content', encoding='utf-8')
            skills = Path(temporary) / 'skills'; skill = skills / 'aplot-fixture-skill'; skill.mkdir(parents=True)
            (skill / 'SKILL.md').write_text('---\nname: aplot-fixture-skill\ndescription: Test skill\n---\nfixture-skill-loaded\n', encoding='utf-8')
            server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            home = Path(temporary) / 'home'
            env = os.environ.copy(); env['HERMES_HOME'] = str(home); env['PYTHONIOENCODING'] = 'utf-8'
            child = subprocess.Popen([str(PYTHON), '-X', 'utf8', '-c', BOOTSTRAP.read_text('utf-8')], cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
            frames = queue.Queue(); seen = []
            diagnostics = []
            def errors():
                for line in child.stderr: diagnostics.append(line)
            threading.Thread(target=errors, daemon=True).start()
            def read():
                for line in child.stdout:
                    try: frames.put(json.loads(line))
                    except ValueError: pass
            threading.Thread(target=read, daemon=True).start()
            def write(frame): child.stdin.write(json.dumps(frame)+'\n'); child.stdin.flush()
            def wait(predicate, seconds=45):
                deadline = time.monotonic()+seconds
                while time.monotonic() < deadline:
                    try: frame = frames.get(timeout=max(.01, deadline-time.monotonic()))
                    except queue.Empty: self.fail('RPC deadline; requests='+str(len(requests))+'; '+''.join(diagnostics[-160:]))
                    seen.append(frame)
                    if predicate(frame): return frame
                    if frame.get('params', {}).get('type') in ['error', 'message.complete'] or frame.get('aplot_error'):
                        self.fail('Unexpected RPC: '+json.dumps(frame)+'; '+''.join(diagnostics[-20:]))
                self.fail('RPC deadline')
            try:
                write({'home': str(home), 'cwd': str(workspace), 'skills': str(skills), 'target': {'modelId': 'aplot-fixture', 'baseUrl': f'http://127.0.0.1:{server.server_port}/v1', 'apiKey': 'fixture-local', 'contextTokens': 131072}, 'instruction': 'Use the requested tools.\nProject memory explicitly confirmed by the user (reference material, not tool authorization):\n- workspace-memory-fixture-82'})
                wait(lambda f: f.get('params', {}).get('type') == 'gateway.ready')
                write({'jsonrpc': '2.0', 'id': 'cap', 'method': 'client.capabilities', 'params': {'server_requests': True}})
                write({'jsonrpc': '2.0', 'id': 'create', 'method': 'session.create', 'params': {'cwd': str(workspace), 'model': 'aplot-fixture', 'provider': 'custom:aplot', 'source': 'cli'}})
                created = wait(lambda f: f.get('id') == 'create'); self.assertIn('result', created, created)
                sid = created['result']['session_id']
                from PIL import Image
                image_path = workspace / 'image with spaces.png'
                Image.new('RGB', (16, 16), 'blue').save(image_path)
                write({'jsonrpc': '2.0', 'id': 'image', 'method': 'image.attach', 'params': {'session_id': sid, 'path': str(image_path)}})
                image_reply = wait(lambda f: f.get('id') == 'image')
                self.assertTrue(image_reply.get('result', {}).get('attached'), image_reply)
                external = Path(temporary) / 'external document.txt'; external.write_text('explicit-attachment-data', encoding='utf-8')
                write({'jsonrpc': '2.0', 'id': 'file', 'method': 'file.attach', 'params': {'session_id': sid, 'path': str(external)}})
                attached = wait(lambda f: f.get('id') == 'file')
                self.assertTrue(attached.get('result', {}).get('attached'), attached)
                reference = attached['result']['ref_text']
                write({'jsonrpc': '2.0', 'id': 'prompt', 'method': 'prompt.submit', 'params': {'session_id': sid, 'text': 'Read sample.txt and clarify whether to continue.\n' + reference}})
                question = wait(lambda f: f.get('method') == 'clarify', seconds=60)
                questions = question['params']['questions']
                write({'jsonrpc': '2.0', 'id': question['id'], 'result': {'answers': {q['qid']: 'Yes' for q in questions}}})
                approval = wait(lambda f: f.get('method') == 'approval')
                write({'jsonrpc': '2.0', 'id': approval['id'], 'result': {'choice': 'deny'}})
                completed = wait(lambda f: f.get('params', {}).get('type') == 'message.complete')
                self.assertEqual(completed['params']['payload']['text'], 'File and clarification complete.')
                self.assertEqual(completed['params']['payload']['status'], 'complete')
                self.assertTrue(any(isinstance(m.get('content'), list) and any(part.get('type') == 'image_url' for part in m['content'] if isinstance(part, dict)) for r in requests for m in r.get('messages', [])), 'Image must reach the model as image_url parts')
                self.assertTrue(any('explicit-attachment-data' in str(m.get('content')) or '@file:' in str(m.get('content')) for r in requests for m in r.get('messages', [])), 'File reference must reach the model')
                write({'jsonrpc':'2.0','id':'context','method':'session.context_breakdown','params':{'session_id':sid}})
                context = wait(lambda f: f.get('id') == 'context')['result']
                self.assertGreater(context['context_used'],0)
                self.assertGreater(context['context_max'],0)
                self.assertTrue(context['categories'])
                self.assertIn(context['context_source'], ['provider_usage','provider_usage_plus_estimate','local_estimate'])
                for mode in ['off','manual']:
                    write({'jsonrpc':'2.0','id':'mode-'+mode,'method':'config.set','params':{'session_id':sid,'key':'approvals.mode','value':mode}})
                    reply = wait(lambda f: f.get('id') == 'mode-'+mode)
                    self.assertEqual(reply.get('result',{}).get('value'),mode,reply)
                write({'jsonrpc':'2.0','id':'voice-status','method':'voice.toggle','params':{'action':'status'}})
                voice = wait(lambda f: f.get('id') == 'voice-status')
                self.assertIn('result', voice, voice)
                self.assertIn('stt_available', voice['result'])
                write({'jsonrpc':'2.0','id':'level','method':'aplot.voice.level','params':{}})
                self.assertEqual(wait(lambda f:f.get('id')=='level')['result'],{'recording':False,'rms':0})
                self.assertTrue(any('workspace-memory-fixture-82' in str(m.get('content')) for r in requests for m in r.get('messages', []) if m.get('role') == 'system'), 'Project memory must reach the actual model request')
                self.assertTrue(any('fixture-file-content' in str(m.get('content')) for r in requests for m in r.get('messages', []) if m.get('role') == 'tool'))
                self.assertTrue(any('fixture-skill-loaded' in str(m.get('content')) for r in requests for m in r.get('messages', []) if m.get('role') == 'tool'))
                tool_names = {t['function']['name'] for r in requests for t in r.get('tools', [])}
                self.assertTrue({'read_file', 'clarify', 'skill_view'} <= tool_names, tool_names)
                self.assertNotIn('web_search', tool_names)
                self.assertTrue((workspace / 'sample.txt').exists(), 'denied command must not execute')
                write({'jsonrpc': '2.0', 'id': 'follow', 'method': 'prompt.submit', 'params': {'session_id': sid, 'text': 'FOLLOWUP'}})
                followup = wait(lambda f: f.get('params', {}).get('type') == 'message.complete')
                self.assertEqual(followup['params']['payload']['text'], 'Follow-up complete.')
                write({'jsonrpc':'2.0','id':'always','method':'prompt.submit','params':{'session_id':sid,'text':'ALWAYS'}})
                approval = wait(lambda f: f.get('method') == 'approval')
                self.assertIn('always',approval['params']['choices'])
                write({'jsonrpc':'2.0','id':approval['id'],'result':{'choice':'always'}})
                wait(lambda f:f.get('params',{}).get('type')=='message.complete')
                write({'jsonrpc':'2.0','id':'always-again','method':'prompt.submit','params':{'session_id':sid,'text':'ALWAYS AGAIN'}})
                wait(lambda f:f.get('params',{}).get('type')=='message.complete')
                write({'jsonrpc': '2.0', 'id': 'to-stop', 'method': 'prompt.submit', 'params': {'session_id': sid, 'text': 'INTERRUPT'}})
                wait(lambda f: f.get('method') == 'clarify')
                write({'jsonrpc': '2.0', 'id': 'stop', 'method': 'session.interrupt', 'params': {'session_id': sid}})
                interrupted = wait(lambda f: f.get('params', {}).get('type') == 'message.complete')
                self.assertEqual(interrupted['params']['payload']['status'], 'interrupted')
                self.assertTrue(any(f.get('params', {}).get('type') == 'request.cancel' for f in seen))
            finally:
                child.stdin.close()
                try: child.wait(timeout=8)
                except subprocess.TimeoutExpired: child.kill(); child.wait()
                child.stdout.close(); child.stderr.close(); server.shutdown(); server.server_close()


if __name__ == '__main__': unittest.main()
