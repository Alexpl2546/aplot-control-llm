"""Run Aplot's real context suites against a separate, local Infernix process.

Python controls the process and collects evidence; inference and token counting
run through the C++ engine, and quality scoring uses Aplot's Rust benchmark code.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--ngram", type=Path)
    parser.add_argument("--benchmark-exe", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--contexts", nargs="+", type=int, default=[65536, 98304, 131072, 262144])
    parser.add_argument("--kv", default="int8")
    parser.add_argument("--spec", choices=["off", "mtp"], default="off")
    parser.add_argument("--draft-tokens", type=int, default=4)
    parser.add_argument("--lm-head-draft", action="store_true")
    parser.add_argument("--prefill-chunk", type=int, default=1024)
    parser.add_argument("--host-context-mib", type=int, default=4096)
    parser.add_argument("--ram-headroom-mib", type=int, default=4096)
    parser.add_argument("--vram-headroom-mib", type=int, default=1536)
    parser.add_argument("--startup-only", action="store_true")
    parser.add_argument("--port", type=int, default=8097)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    endpoint = f"http://127.0.0.1:{args.port}"
    # This is a disposable local test key, not a user credential.
    test_key = "aplot-infernix-integration-test"
    hidden = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

    def api(path, payload=None, authorize=True):
        headers = {"Content-Type": "application/json"}
        if authorize:
            headers["Authorization"] = f"Bearer {test_key}"
        request = urllib.request.Request(endpoint + path, headers=headers,
                                         data=json.dumps(payload).encode() if payload is not None else None)
        with urllib.request.urlopen(request, timeout=900) as response:
            return json.load(response)

    summary = []
    for context in args.contexts:
        folder = args.output / f"ctx-{context}-{args.kv}"
        folder.mkdir(exist_ok=True)
        command = [str(args.binary.resolve()), str(args.model.resolve()),
                   "--host", "127.0.0.1", "--port", str(args.port),
                   "--max-context", str(context), "--kv-dtype", args.kv,
                   "--kv-capacity", "auto", "--max-concurrency", "1",
                   "--prefill-chunk", str(args.prefill_chunk), "--host-context-mib", str(args.host_context_mib),
                   "--ram-headroom-mib", str(args.ram_headroom_mib), "--vram-headroom-mib", str(args.vram_headroom_mib),
                   "--expert-ram-mib", "auto", "--model-id", "aplot-infernix-test",
                   "--api-key", test_key]
        if args.ngram:
            command.extend(["--ngram-volume", str(args.ngram.resolve())])
        if args.spec != "off":
            command.extend(["--spec", args.spec, "--draft-tokens", str(args.draft_tokens)])
        if args.lm_head_draft:
            command.append("--lm-head-draft")
        record = {"context": context, "kv": args.kv, "model": str(args.model.resolve()),
                  "command": command, "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        print("START", context, args.model.name, flush=True)
        stop = threading.Event()
        process = None
        started = time.monotonic()
        try:
            with (folder / "server.log").open("wb") as log:
                process = subprocess.Popen(command, cwd=args.binary.resolve().parent,
                                           stdout=log, stderr=subprocess.STDOUT, creationflags=hidden)

                def monitor():
                    with (folder / "gpu.csv").open("w") as gpu_log:
                        gpu_log.write("elapsed_seconds,used_MiB,total_MiB,utilization_percent\n")
                        while not stop.is_set():
                            probe = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,memory.total,utilization.gpu",
                                                    "--format=csv,noheader,nounits"], capture_output=True,
                                                   text=True, creationflags=hidden, timeout=10)
                            gpu_log.write(f"{time.monotonic()-started:.3f}," + probe.stdout.strip() + "\n")
                            gpu_log.flush()
                            stop.wait(5)
                worker = threading.Thread(target=monitor, daemon=True)
                worker.start()
                while True:
                    if process.poll() is not None:
                        raise RuntimeError(f"engine exited during startup: {process.returncode}; see server.log")
                    try:
                        health = api("/health")
                        if health.get("status") == "ok":
                            break
                    except (OSError, urllib.error.HTTPError):
                        pass
                    if time.monotonic() - started > 900:
                        raise TimeoutError("engine startup exceeded 900 seconds")
                    time.sleep(2)
                record["startupSeconds"] = time.monotonic() - started
                record["models"] = api("/v1/models")
                if not args.startup_only:
                    payload = {"model": "aplot-infernix-test", "messages": [
                        {"role": "user", "content": "Return exactly the number 731."}],
                               "max_tokens": 32, "temperature": 0,
                               "chat_template_kwargs": {"enable_thinking": False}}
                    counted = api("/v1/chat/completions/input_tokens", payload)
                    generated = api("/v1/chat/completions", payload)
                    record["smoke"] = {"counted": counted, "generated": generated}
                    assert counted["input_tokens"] == generated["usage"]["prompt_tokens"], "count/usage mismatch"
                    try:
                        api("/v1/chat/completions/input_tokens", payload, authorize=False)
                        raise AssertionError("token-count endpoint bypassed authentication")
                    except urllib.error.HTTPError as error:
                        assert error.code == 401, f"unexpected auth status: {error.code}"
                    env = dict(os.environ, APLOT_BENCH_ENDPOINT=endpoint,
                               APLOT_BENCH_MODEL="aplot-infernix-test", APLOT_BENCH_API_KEY=test_key,
                               APLOT_BENCH_CONTEXT=str(context), APLOT_BENCH_RUNS="1",
                               APLOT_BENCH_OUTPUT=str((folder / "results.json").resolve()))
                    with (folder / "benchmark.log").open("wb") as bench_log:
                        benchmark = subprocess.run([str(args.benchmark_exe.resolve()),
                                                    "real_engine_context_campaign", "--ignored", "--nocapture"],
                                                   stdout=bench_log, stderr=subprocess.STDOUT,
                                                   env=env, creationflags=hidden)
                    record["benchmarkExitCode"] = benchmark.returncode
                    result_file = folder / "results.json"
                    if result_file.exists():
                        record["results"] = json.loads(result_file.read_text(encoding="utf-8"))
                record["status"] = "completed" if record.get("benchmarkExitCode", 0) == 0 else "benchmark_failed"
        except Exception as error:
            record["status"] = "failed"
            record["error"] = str(error)
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            stop.set()
            if "worker" in locals():
                worker.join(timeout=12)
            record["elapsedSeconds"] = time.monotonic() - started
            (folder / "run.json").write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
            summary.append(record)
            (args.output / "campaign.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
            print("END", context, record["status"], record.get("error", ""), flush=True)


if __name__ == "__main__":
    main()
