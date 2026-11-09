import AgentAvatar from "../components/AgentAvatar";
import type { GroupChatMember } from "../types";

export default function GroupMemberAvatar({ member, className }: { member?: GroupChatMember; className?: string }) {
  return <AgentAvatar agentId={member?.agentId} name={member?.displayName} className={className}
    grayscale={member?.state === "removed" || member?.agentMissing === true} />;
}
