import { useBackendCatalog } from "../lib/backends";

export default function BackendBadge({ backendId }: { backendId: string }) {
  const descriptors = useBackendCatalog();
  const label = descriptors.find((descriptor) => descriptor.id === backendId)?.name || backendId;
  return <span className={`badge badge-${backendId}`}>{label}</span>;
}
