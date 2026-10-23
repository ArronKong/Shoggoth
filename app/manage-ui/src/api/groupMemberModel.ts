// Member settings load with their dialog; reuse the shared REST/error contract.
import { jsonFetch } from './client';
import type { GroupChatMemberModels, GroupChatModelSelection, GroupChatView } from '../types';

export function getGroupChatMemberModels(id: string, memberId: string) {
  return jsonFetch<GroupChatMemberModels>(`/__api/group-chats/members/models?${new URLSearchParams({ id, memberId })}`);
}
export function setGroupChatMemberModel(id: string, input: { expectedRosterRevision: number; memberId: string;
  modelSelection: GroupChatModelSelection | null }) {
  return jsonFetch<GroupChatView>(`/__api/group-chats/members/model?${new URLSearchParams({ id })}`,
    { method: 'PATCH', body: JSON.stringify(input) });
}
