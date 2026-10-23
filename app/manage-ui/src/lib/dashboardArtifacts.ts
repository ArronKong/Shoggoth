import type { DashboardSummary } from "../types";

/** Merge local files and published group attachments before the shared 20-row limit. */
export function recentDashboardArtifacts(data: DashboardSummary | undefined) {
  const files = (data?.artifacts || []).flatMap(section => section.supported ? section.items.map(item => ({
    ...item, backend: section.backend, key: `path:${item.path}`, groupName: null, attachment: null,
  })) : []);
  const groups = data?.groupArtifacts?.supported ? data.groupArtifacts.items.map(item => ({
    key: `attachment:${item.attachment.id}`, path: null, name: item.attachment.name, size: item.attachment.size,
    area: "group-chat", backend: item.backendId, agentId: item.agentId, agentName: item.agentName,
    groupName: item.groupName, attachment: item.attachment, mtimeMs: item.createdAt,
  })) : [];
  const seen = new Set<string>();
  return [...files, ...groups].sort((a, b) => b.mtimeMs - a.mtimeMs).filter(item => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  }).slice(0, 20);
}
