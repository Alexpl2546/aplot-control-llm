import { Copy, Play, RotateCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { renderCommand, type ShellKind } from "../../lib/cli";
import { renderRouterCommand } from "../../lib/router";
import { commandRunAction } from "../../lib/commandAction";
import { qwfnCommand } from "../../lib/qwfnfer";
import { useControlStore } from "../../store/control";
import { getRouterPresetPath, writeRouterPreset } from "../../services/tauri";
import { Button, Select } from "../ui/Primitives";
export function CliPreview() {
  const { t } = useTranslation();
  const { config, capabilities, runtime, busy, start, restart, profiles, settings } = useControlStore();
  const [shell, setShell] = useState<ShellKind>("powershell");
  const [presetPath, setPresetPath] = useState("");
  useEffect(() => {
    if (settings.serverEngine !== "llama_cpp" || settings.serverMode !== "router") return;
    let active = true;
    void getRouterPresetPath().then(path => { if (active) setPresetPath(path); }).catch(() => setPresetPath(""));
    return () => { active = false; };
  }, [settings.serverEngine, settings.serverMode]);
  const routerProfiles = useMemo(() => {
    const saved = profiles.map(profile => profile.id === config.profileId
      ? { name: config.profileName, config }
      : { name: profile.name, config: profile.config });
    return saved.some(profile => profile.config.profileId === config.profileId)
      ? saved
      : [...saved, { name: config.profileName, config }];
  }, [profiles, config]);
  const command = useMemo(() => {
    try {
      if (settings.serverEngine === "qwfnfer") return qwfnCommand(settings.qwfn, shell);
      if (settings.serverEngine === "strata") {
        if (!settings.strataRootPath || !settings.strataConfigPath) return `# ${t("config.strataText")}`;
        const python = `${settings.strataRootPath.replace(/[\\/]+$/, "")}\\.venv\\Scripts\\python.exe`;
        const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
        return `Push-Location ${quote(settings.strataRootPath)}; try { & ${quote(python)} -m serve.server --engine strata --config ${quote(settings.strataConfigPath)} --host ${quote(settings.strataHost)} --port ${settings.strataPort} } finally { Pop-Location }\n# ${t("settings.strataKeyHelp")}`;
      }
      return settings.serverMode === "router"
        ? renderRouterCommand(config, routerProfiles, settings, presetPath || "<app-data>\\router-presets.ini", shell, capabilities)
        : renderCommand(config, shell, capabilities);
    } catch (error) {
      return `# ${t("router.commandUnavailable")}: ${String(error)}`;
    }
  }, [config, capabilities, routerProfiles, settings, presetPath, shell, t]);
  const preview = useMemo(() => settings.serverEngine === "llama_cpp" && settings.serverMode === "single" && config.apiKey
    ? renderCommand({ ...config, apiKey: "<redacted>" }, shell, capabilities)
    : command, [config, command, shell, capabilities, settings.serverEngine, settings.serverMode]);
  const runAction = commandRunAction(runtime.state);

  const copyCommand = async () => {
    try {
      let commandToCopy = command;
      if (settings.serverEngine === "llama_cpp" && settings.serverMode === "router") {
        const generated = await writeRouterPreset(routerProfiles, capabilities);
        setPresetPath(generated.path);
        commandToCopy = renderRouterCommand(config, routerProfiles, settings, generated.path, shell, capabilities);
      }
      await navigator.clipboard.writeText(commandToCopy);
      useControlStore.getState().notify("success", t("notification.commandCopied"));
    } catch (error) {
      useControlStore.getState().notify("error", t("notification.commandCopyFailed"));
      useControlStore.setState({ error: String(error) });
    }
  };

  const runCommand = () => {
    if (runAction === "start") void start();
    else void restart();
  };

  return (
    <section className="commandCard">
      <div className="commandHead">
        <h3>{t("config.generated")}</h3>
        {settings.serverEngine === "llama_cpp" && <Select value={shell} onChange={event => setShell(event.target.value as ShellKind)}>
          <option value="powershell">PowerShell</option>
          <option value="cmd">CMD</option>
          <option value="bash">Bash</option>
        </Select>}
        <Button onClick={() => void copyCommand()}>
          <Copy size={14} />{t("actions.copy")}
        </Button>
        <Button className="primary" disabled={busy} onClick={runCommand}>
          {runAction === "start" ? <Play size={14} /> : <RotateCw size={14} />}
          {t(runAction === "start" ? "actions.runCommand" : "actions.restartCommand")}
        </Button>
      </div>
      <pre>{preview}</pre>
      {settings.serverEngine === "llama_cpp" && settings.serverMode === "router" && <p className="subtle">{t("router.commandHelp")}</p>}
    </section>
  );
}
