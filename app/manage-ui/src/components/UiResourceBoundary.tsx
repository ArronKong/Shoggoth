import { Component, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { publishSystemIssue } from "../lib/system-issues";

function ResourceFailure() {
  const { t } = useTranslation();
  return (
    <div className="page" role="status">
      <p>{t("common.uiResourceUnavailable")}</p>
      <button className="btn" onClick={() => window.location.reload()}>{t("common.reloadPage")}</button>
    </div>
  );
}

// A failed lazy page must leave the application shell and its toast provider
// mounted. Navigation can recover other pages without discarding healthy Chat.
export default class UiResourceBoundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { publishSystemIssue("UI_RESOURCE_UNAVAILABLE"); }
  componentDidUpdate(previous: Readonly<{ children: ReactNode; resetKey: string }>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }
  render() { return this.state.failed ? <ResourceFailure /> : this.props.children; }
}
