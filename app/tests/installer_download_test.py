"""Exercise the real PowerShell downloader against a local interrupted HTTP server."""
import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'src-tauri/installer/Install-Components.ps1'
DATA = bytes(range(256)) * 2048


def ps_quote(value):
    return "'" + str(value).replace("'", "''") + "'"


class DownloaderTest(unittest.TestCase):
    def test_interruption_resume_range_fallback_and_readable_failure(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                offset = int(self.headers.get('Range', 'bytes=0-').split('=')[1].split('-')[0])
                requests.append((self.path, offset))
                if self.path == '/failure':
                    self.send_error(503, 'Fixture unavailable')
                    return
                if self.path == '/resume' and offset == 0:
                    self.send_response(200)
                    self.send_header('Content-Length', str(len(DATA)))
                    self.end_headers()
                    self.wfile.write(DATA[:131072])
                    self.wfile.flush()
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                if self.path == '/ignore-range':
                    offset = 0
                self.send_response(206 if offset else 200)
                self.send_header('Content-Length', str(len(DATA) - offset))
                if offset:
                    self.send_header('Content-Range', f'bytes {offset}-{len(DATA)-1}/{len(DATA)}')
                self.end_headers()
                self.wfile.write(DATA[offset:])

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        results = {}
        try:
            with tempfile.TemporaryDirectory(prefix='aplot-download-test-') as temp:
                root = Path(temp)

                def run(route, target, failure=False):
                    url = f'http://127.0.0.1:{server.server_port}/{route}'
                    code = f". {ps_quote(SCRIPT)}; try {{ Receive-InstallerFile {ps_quote(url)} {ps_quote(target)} -MaxAttempts 2 -RetryDelaySeconds 0 }} catch {{ [Console]::WriteLine($_.Exception.Message); exit 7 }}"
                    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', code], capture_output=True, timeout=30)
                    output = result.stdout.decode('utf-8') + result.stderr.decode('utf-8')
                    self.assertEqual(result.returncode, 7 if failure else 0, output)
                    self.assertNotIn('\ufffd', output)
                    results[route] = output
                    return output

                target = root / 'resume.partial'
                output = run('resume', target)
                self.assertEqual(hashlib.sha256(target.read_bytes()).digest(), hashlib.sha256(DATA).digest())
                self.assertIn(('/resume', 131072), requests)
                self.assertIn('Resuming download at 131072 bytes', output)
                events = [json.loads(line[15:]) for line in output.splitlines() if line.startswith('APLOT_PROGRESS ')]
                self.assertTrue(any(event['downloaded'] == 131072 for event in events))
                self.assertEqual(events[-1]['percent'], 100)
                target = root / 'ignored.partial'
                target.write_bytes(DATA[:3000])
                run('ignore-range', target)
                self.assertEqual(target.read_bytes(), DATA)
                target = root / 'failure.partial'
                target.write_bytes(DATA[:1000])
                output = run('failure', target, failure=True)
                self.assertIn('Не удалось загрузить архив после 2 попыток', output)
                self.assertEqual(target.read_bytes(), DATA[:1000])
                self.assertEqual(sum(route == '/failure' for route, _ in requests), 2)
                out = SCRIPT.parents[2] / 'artifacts/agent-io/installer-download-test.json'
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_text(json.dumps({'passed': True, 'requests': requests, 'logs': results}, ensure_ascii=False, indent=2), encoding='utf-8')
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
