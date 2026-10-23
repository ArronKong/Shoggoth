import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui";
import { parseSystemIssue, publishSystemIssue, subscribeSystemIssues, SYSTEM_ISSUE_KEYS } from "../lib/system-issues";

export default function SystemIssueToasts() {
  const { t } = useTranslation();
  const toast = useToast();
  useEffect(() => {
    const stop = subscribeSystemIssues(code => toast.error(t(SYSTEM_ISSUE_KEYS[code])));
    const desktop = (window as unknown as {
      openclawDesktop?: { onSystemIssue?: (callback: (value: unknown) => void) => () => void };
    }).openclawDesktop;
    const stopDesktop = desktop?.onSystemIssue?.(value => {
      const code = parseSystemIssue(value);
      if (code) publishSystemIssue(code);
    });
    return () => { stopDesktop?.(); stop(); };
  }, [t, toast]);
  return null;
}
