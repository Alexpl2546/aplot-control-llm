"""Real app MCP stdio proxy against a deterministic loopback workspace fixture."""
import json
import os
from pathlib import Path
import subprocess
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

EXE = Path(__file__).parents[1] / 'src-tauri/target/debug/aplot-control-llm.exe'


@unittest.skipUnless(EXE.is_file(), 'build the native app first')
class AgentToolsRuntimeTest(unittest.TestCase):
    def test_stdio_discovery_and_task_scoped_round_trip(self):
        received = []

        class Workspace(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                received.append(request)
                body = json.dumps({'agents': [{'id': 'reviewer'}]}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Workspace)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        env = {**os.environ, 'APLOT_AGENT_TOOLS_URL': f'http://127.0.0.1:{server.server_port}/tools', 'APLOT_AGENT_TOOLS_TOKEN': 'test-private-capability'}
        frames = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-03-26'}},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'aplot_list_agents', 'arguments': {}}},
            {'jsonrpc': '2.0', 'id': 4, 'method': 'unknown'},
        ]
        try:
            process = subprocess.run([str(EXE), '--agent-tools'], input=''.join(json.dumps(frame) + '\n' for frame in frames), capture_output=True, text=True, encoding='utf-8', env=env, timeout=15, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.assertEqual(process.returncode, 0, process.stderr)
            replies = [json.loads(line) for line in process.stdout.splitlines()]
            self.assertEqual([reply['id'] for reply in replies], [1, 2, 3, 4])
            self.assertEqual(replies[0]['result']['protocolVersion'], '2025-03-26')
            tools = {tool['name']: tool for tool in replies[1]['result']['tools']}
            self.assertEqual(set(tools), {'aplot_list_agents', 'aplot_list_projects', 'aplot_delegate', 'aplot_task_result', 'aplot_propose_agent'})
            self.assertNotIn('approved', tools['aplot_propose_agent']['inputSchema']['properties'])
            self.assertFalse(replies[2]['result']['isError'])
            self.assertEqual(json.loads(replies[2]['result']['content'][0]['text']), {'agents': [{'id': 'reviewer'}]})
            self.assertEqual(received, [{'token': 'test-private-capability', 'name': 'aplot_list_agents', 'arguments': {}}])
            self.assertEqual(replies[3]['error']['code'], -32601)
        finally:
            server.shutdown()
            server.server_close()

    def test_rejects_a_non_loopback_broker(self):
        env = {**os.environ, 'APLOT_AGENT_TOOLS_URL': 'http://example.invalid/tools', 'APLOT_AGENT_TOOLS_TOKEN': 'test'}
        process = subprocess.run([str(EXE), '--agent-tools'], capture_output=True, env=env, timeout=5, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertNotEqual(process.returncode, 0)
        self.assertFalse(process.stdout)


if __name__ == '__main__':
    unittest.main()
