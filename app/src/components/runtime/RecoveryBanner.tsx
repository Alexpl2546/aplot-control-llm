import { RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { Button } from "../ui/Primitives";

export function RecoveryBanner(){
  const {t}=useTranslation(); const {runtime,rollback,busy,knownGoodProfile,knownGoodRouter,settings,runningEngine}=useControlStore(); const [hidden,setHidden]=useState(false);
  if(runtime.state!=="crashed"||hidden||(runningEngine??settings.serverEngine)!=="llama_cpp")return null;
  const recoveryAvailable = settings.serverMode === "router" ? Boolean(knownGoodRouter) : Boolean(knownGoodProfile);
  const recoveryName = settings.serverMode === "router"
    ? knownGoodRouter ? t("router.recoveryAvailable", { count: knownGoodRouter.profiles.length }) : undefined
    : knownGoodProfile?.name;
  return <div className="recoveryBanner"><div><b>{t("recovery.title")}</b><span>{runtime.lastError||t("recovery.text")}</span>{recoveryName&&<small>{t("recovery.available")}: {recoveryName}</small>}</div><div>{recoveryAvailable&&<Button className="primary" disabled={busy} onClick={()=>void rollback()}><RotateCcw size={14}/>{t("recovery.restore")}</Button>}<Button onClick={()=>setHidden(true)}><X size={14}/></Button></div></div>;
}
