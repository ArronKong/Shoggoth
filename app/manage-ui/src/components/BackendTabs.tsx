// Reusable icon tabs for the per-backend management pages.
// 视觉与交互统一走 PillTabs 组件——
// 本组件只保留后端清单逻辑；受控。只剩一个已连接后端时整组隐藏
// （设置页可「断开连接」某个后端）。
import { useTranslation } from "react-i18next";
import {
  useBackendCatalog,
  useEnabledBackends,
  type BackendId,
  type BackendSurface,
} from "../lib/backends";
import PillTabs from "./PillTabs";
import BackendTabIcon, { sortBackendTabs } from "./BackendTabIcon";

export { BACKENDS, type BackendId } from "../lib/backends";

export default function BackendTabs({
  value,
  onChange,
  surface,
}: {
  value: string;
  onChange: (id: BackendId) => void;
  surface?: BackendSurface;
}) {
  const { t } = useTranslation();
  const descriptors = useBackendCatalog(surface);
  const enabled = useEnabledBackends(surface);
  const tabs = sortBackendTabs(descriptors)
    .filter((descriptor) => enabled.includes(descriptor.id))
    .map((descriptor) => ({ id: descriptor.id, label: descriptor.name }));
  if (tabs.length < 2) return null;
  return (
    <PillTabs
      value={value}
      onChange={(v) => onChange(v as BackendId)}
      items={tabs.map((b) => ({
        value: b.id,
        label: b.label,
        icon: <BackendTabIcon backend={b.id} label={b.label} />,
      }))}
      ariaLabel={t("a11y.switchBackend")}
    />
  );
}
