"""Reproducible local tuning at a 131072-token profile; never edits user settings.

Short prompts measure prose/code decode, not full-context speed. --long adds
one shared near-full synthetic ledger per candidate. Quality is checked separately
with run-campaign.py and Aplot's Rust context suites before adopting a preset.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
MODEL_ROOT = ROOT / "models/infernix/Qwen3.8-Flash-Next-NVIDIA-NVFP4-Dense8-Infernix"
BASE = [str(ROOT / "engines/infernix/bin/infernix-serve.exe"),
        str(MODEL_ROOT / "Qwen3.8-Flash-Next-NVIDIA-NVFP4-Dense8-Infernix-00001-of-00003.infernix"),
        "--host", "127.0.0.1", "--port", "8097", "--max-context", "131072",
        "--kv-dtype", "int8", "--kv-capacity", "auto", "--max-concurrency", "1",
        "--prefill-chunk", "1024", "--host-context-mib", "4096", "--ram-headroom-mib", "4096",
        "--vram-headroom-mib", "1536", "--expert-ram-mib", "auto", "--model-id", "aplot-infernix-test",
        "--api-key", "aplot-infernix-integration-test", "--ngram-volume",
        str(MODEL_ROOT / "Qwen3.8-Flash-Next-NVIDIA-NVFP4-Infernix.ngram")]
CASES = {
    "baseline": {"kv": "int8", "spec": "off", "chunk": 1024, "host": 4096, "vram": 1536},
    "mtp-only": {"kv": "int8", "spec": "mtp", "chunk": 1024, "host": 4096, "vram": 1536},
    "mtp-memory": {"kv": "int8", "spec": "mtp", "chunk": 1024, "host": 1024, "vram": 768},
    "mtp-int8-2048": {"kv": "int8", "spec": "mtp", "chunk": 2048, "host": 1024, "vram": 768},
    "mtp-nvfp4-2048": {"kv": "nvfp4", "spec": "mtp", "chunk": 2048, "host": 1024, "vram": 768},
    "mtp-nvfp4-4096": {"kv": "nvfp4", "spec": "mtp", "chunk": 4096, "host": 1024, "vram": 768},
    "plain-int8-4096": {"kv": "int8", "spec": "off", "chunk": 4096, "host": 1024, "vram": 1024},
    "plain-nvfp4-4096": {"kv": "nvfp4", "spec": "off", "chunk": 4096, "host": 1024, "vram": 1024},
    "mtp-balanced": {"kv": "int8", "spec": "mtp", "chunk": 2048, "host": 2048, "vram": 1536},
    "plain-balanced": {"kv": "int8", "spec": "off", "chunk": 4096, "host": 2048, "vram": 1536},
    "plain-safe": {"kv": "int8", "spec": "off", "chunk": 4096, "host": 2048, "vram": 1536, "ram": 8192},
    "mtp-safe": {"kv": "int8", "spec": "mtp", "chunk": 4096, "host": 2048, "vram": 1536, "ram": 8192},
    "plain-8192": {"kv": "int8", "spec": "off", "chunk": 8192, "host": 2048, "vram": 1536, "ram": 8192},
    "mtp-8192": {"kv": "int8", "spec": "mtp", "chunk": 8192, "host": 2048, "vram": 1536, "ram": 8192},
    "mtp-8192-v1280": {"kv": "int8", "spec": "mtp", "chunk": 8192, "host": 2048, "vram": 1280, "ram": 8192},
    "mtp-nvfp4-8192": {"kv": "nvfp4", "spec": "mtp", "chunk": 8192, "host": 2048, "vram": 1280, "ram": 8192},
}
PROMPTS = [
    ("english", "Write a detailed explanation of how caching works in an application. Give a concrete example and continue for at least 400 words."),
    ("russian", "Напиши подробное объяснение того, как работает кеширование в приложении. Приведи конкретный пример и продолжай не менее 400 слов."),
    ("python", "Write a Python implementation of a bounded LRU cache with type hints, then explain its complexity in detail. Continue for at least 400 words."),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", nargs="+", choices=list(CASES), default=list(CASES))
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--long", action="store_true")
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--ngram", type=Path)
    parser.add_argument("--strata-config", type=Path,
                        help="Compare the same workloads using a temporary copy of a Strata config")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    endpoint = "http://127.0.0.1:8097"
    key = "aplot-infernix-integration-test"
    hidden = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    model_id = "aplot-infernix-test"

    def request(path, payload=None):
        req = urllib.request.Request(endpoint + path, headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
                                     data=json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None)
        return urllib.request.urlopen(req, timeout=900)

    def api(path, payload=None):
        with request(path, payload) as response:
            return json.load(response)

    def generate(messages):
        payload = {"model": model_id, "messages": messages, "max_tokens": 256, "temperature": 0,
                   "seed": 42, "chat_template_kwargs": {"enable_thinking": False}, "stream": True,
                   "stream_options": {"include_usage": True}}
        started = time.monotonic()
        ttft = None
        usage = {}
        text = ""
        with request("/v1/chat/completions", payload) as response:
            for raw in response:
                line = raw.decode().strip()
                if not line.startswith("data:") or line[5:].strip() == "[DONE]":
                    continue
                event = json.loads(line[5:])
                if event.get("error"):
                    raise RuntimeError(json.dumps(event["error"]))
                if event.get("usage"):
                    usage = event["usage"]
                choices = event.get("choices", [])
                delta = choices[0].get("delta", {}).get("content", "") if choices else ""
                if delta:
                    if ttft is None:
                        ttft = time.monotonic() - started
                    text += delta
        elapsed = time.monotonic() - started
        if not usage or ttft is None or not text:
            raise RuntimeError("missing usage or output in completed stream")
        return {"ttftSeconds": ttft, "elapsedSeconds": elapsed, "usage": usage, "text": text,
                "decodeTps": (usage["completion_tokens"] - 1) / max(elapsed - ttft, 0.001),
                "prefillTps": usage["prompt_tokens"] / ttft}

    def long_messages():
        corpus = args.output / "long-messages.json"
        if corpus.exists():
            return json.loads(corpus.read_text(encoding="utf-8"))
        rows = [f"R{i:05d}: project={hashlib.sha256(f'project:{i}'.encode()).hexdigest()[:12]} code={hashlib.sha256(f'code:{i}'.encode()).hexdigest()[:12]} status=verified.\n" for i in range(16000)]
        def messages(n):
            indices = [n // 5, n // 2, n * 4 // 5]
            keys = [f"R{i:05d}" for i in indices]
            return [{"role": "system", "content": "Audit a synthetic ledger. Return exact values from its rows."},
                    {"role": "user", "content": "Ledger:\n" + "".join(rows[:n]) + "\nReturn JSON mapping each of " + ", ".join(keys) + " to its code, then write a Python LRU cache implementation and explain it in detail."}]
        low, high = 1, len(rows)
        while low < high:
            mid = (low + high + 1) // 2
            count = api("/v1/chat/completions/input_tokens", {"model": model_id, "messages": messages(mid), "chat_template_kwargs": {"enable_thinking": False}})["input_tokens"]
            if count <= 129024:
                low = mid
            else:
                high = mid - 1
        value = messages(low)
        corpus.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        return value

    for name in args.cases:
        case = CASES[name]
        folder = args.output / name
        folder.mkdir(exist_ok=True)
        record = {"case": case, "samples": [], "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        def save():
            (folder / "run.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        command = list(BASE)
        if args.binary:
            command[0] = str(args.binary.resolve())
        if args.model:
            command[1] = str(args.model.resolve())
        if args.ngram:
            command[command.index("--ngram-volume") + 1] = str(args.ngram.resolve())
        for flag, value in [("--kv-dtype", case["kv"]), ("--prefill-chunk", case["chunk"]),
                            ("--host-context-mib", case["host"]), ("--vram-headroom-mib", case["vram"]),
                            ("--ram-headroom-mib", case.get("ram", 4096))]:
            command[command.index(flag) + 1] = str(value)
        command += ["--expert-state", "off", "--log-level", "debug"]
        if case["spec"] == "mtp":
            command += ["--spec", "mtp", "--draft-tokens", "4", "--lm-head-draft"]
        cwd = Path(command[0]).parent
        if args.strata_config:
            if args.cases != ["baseline"]:
                parser.error("--strata-config requires --cases baseline; Infernix flags do not apply")
            config = json.loads(args.strata_config.read_text(encoding="utf-8-sig"))
            record["engineExecutable"] = config["exe"]
            with Path(config["exe"]).open("rb") as executable:
                record["engineBinarySha256"] = hashlib.file_digest(executable, "sha256").hexdigest()
            config.update(host="127.0.0.1", port=8097, log=str((folder / "engine.log").resolve()))
            config["args"][config["args"].index("--max-context") + 1] = "131072"
            temp_config = folder / "strata.json"
            temp_config.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
            cwd = ROOT / "engines/strata"
            command = [str(cwd / ".venv/Scripts/python.exe"), "-m", "serve.server", "--engine", "strata",
                       "--config", str(temp_config.resolve()), "--host", "127.0.0.1", "--port", "8097"]
            record["case"] = {"engine": "Strata", "sourceConfig": str(args.strata_config.resolve()), "args": config["args"]}
        record["command"] = command
        with Path(command[0]).open("rb") as executable:
            record["binarySha256"] = hashlib.file_digest(executable, "sha256").hexdigest()
        save()
        print("START", name, flush=True)
        stop = threading.Event()
        proc = None
        monitor = None
        started = time.monotonic()
        try:
            with (folder / "server.log").open("wb") as log:
                proc = subprocess.Popen(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, creationflags=hidden)
                record["pid"] = proc.pid
                def gpu_monitor():
                    with (folder / "gpu.csv").open("w") as gpu:
                        gpu.write("elapsed_seconds,used_MiB,total_MiB,utilization_percent\n")
                        while not stop.is_set():
                            probe = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10, creationflags=hidden)
                            gpu.write(f"{time.monotonic()-started:.3f}," + probe.stdout.strip() + "\n")
                            gpu.flush()
                            stop.wait(5)
                monitor = threading.Thread(target=gpu_monitor, daemon=True)
                monitor.start()
                while True:
                    if proc.poll() is not None:
                        raise RuntimeError(f"startup exit {proc.returncode}; see server.log")
                    try:
                        if api("/health").get("status") == "ok":
                            break
                    except (OSError, urllib.error.HTTPError):
                        pass
                    if time.monotonic() - started > 900:
                        raise TimeoutError("startup exceeded 900 seconds")
                    time.sleep(2)
                record["startupSeconds"] = time.monotonic() - started
                model_id = api("/v1/models")["data"][0]["id"]
                for label, prompt in PROMPTS:
                    sample = generate([{"role": "user", "content": prompt}])
                    sample["workload"] = label
                    record["samples"].append(sample)
                    save()
                    print(name, label, "ttft", round(sample["ttftSeconds"], 2), "decode", round(sample["decodeTps"], 2), flush=True)
                if args.long:
                    sample = generate(long_messages())
                    sample["workload"] = "near-131k"
                    record["samples"].append(sample)
                    save()
                    print(name, "near-131k", "ttft", round(sample["ttftSeconds"], 2), "decode", round(sample["decodeTps"], 2), flush=True)
                record["status"] = "completed"
        except Exception as error:
            record["status"] = "failed"
            record["error"] = str(error)
        finally:
            if proc is not None and proc.poll() is None:
                children = []
                if args.strata_config:
                    import psutil
                    children = psutil.Process(proc.pid).children(recursive=True)
                    for child in reversed(children):
                        try:
                            child.terminate()
                        except psutil.NoSuchProcess:
                            pass
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                if children:
                    psutil.wait_procs(children, timeout=10)
            stop.set()
            if monitor is not None:
                monitor.join(timeout=12)
            record["elapsedSeconds"] = time.monotonic() - started
            save()
            print("END", name, record["status"], record.get("error", ""), flush=True)


if __name__ == "__main__":
    main()
