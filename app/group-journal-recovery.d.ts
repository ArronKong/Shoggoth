export interface GroupJournalRecoveryItem {
  kind: 'send' | 'draft'; id: string; text: string; attachmentNames: string[]; truncated: boolean; unverified: true;
}
export interface GroupJournalRecoveryPage {
  ownerScope: string; groupId: string; snapshotDigest: string; readOnly: true; items: GroupJournalRecoveryItem[];
  skipped: number; collectionTruncated: boolean; hasMore: boolean; nextOffset: number | null;
}
export function projectJournalRecovery(state: unknown, input: { ownerScope: string; groupId: string; offset?: number; snapshotDigest: string }): GroupJournalRecoveryPage;
