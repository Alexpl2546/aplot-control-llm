import { useTranslation } from "react-i18next";

const copyKeys = ["workspace","overview","overviewHint","navigation","tools","local","search","searchHint","noResults","navigate","open","close","section","theme","light","dark","monitoring","live","demo","skip","backTop","engine","localHint"] as const;

export function useStudioCopy() {
  const { t } = useTranslation();
  return Object.fromEntries(copyKeys.map(key => [key, t(`studio.${key}`)])) as Record<typeof copyKeys[number], string>;
}
