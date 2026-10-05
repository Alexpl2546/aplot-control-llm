import type { QwfnSettings } from "../types/app";

export function qwfnArgs(s: QwfnSettings): string[] {
  const args = [s.modelPath, "--host", s.host, "--port", String(s.port), "--ctx", String(s.context),
    "--ram", String(s.ramGb), "--vram", String(s.vramGb), "--reserve", String(s.reserveMb),
    "--threads", String(s.threads), "--kv", s.kv, "--alias", "qwen3.8-flash-next"];
  if (s.asyncIo) args.push("--io-uring");
  if (s.mtpPath) args.push("--mtp", s.mtpPath);
  if (s.prefixCacheGb > 0) args.push("--prefix-cache", String(s.prefixCacheGb));
  return args;
}
export function qwfnCommand(s: QwfnSettings, shell: "powershell" | "bash" | "cmd"): string {
  const quote = (value: string) => shell === "powershell" ? `'${value.replaceAll("'", "''")}'`
    : shell === "bash" ? `'${value.replaceAll("'", "'\\''")}'` : `"${value.replaceAll('"', '""')}"`;
  const environment = shell === "powershell" ? s.mtpGpu ? "$env:QWFN_MTP_EXPERTS_VRAM = '1'; " : "Remove-Item Env:QWFN_MTP_EXPERTS_VRAM -ErrorAction SilentlyContinue; "
    : shell === "bash" ? s.mtpGpu ? "QWFN_MTP_EXPERTS_VRAM=1 " : "env -u QWFN_MTP_EXPERTS_VRAM "
    : `set "QWFN_MTP_EXPERTS_VRAM=${s.mtpGpu ? "1" : ""}" && `;
  return `${environment}${shell === "powershell" ? "& " : ""}${[s.binaryPath, ...qwfnArgs(s)].map(quote).join(" ")}`;
}
