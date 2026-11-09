import { createContext, useContext } from "react";
import AgentAvatar from "../components/AgentAvatar";
import type { GroupChatMember } from "../types";

export const GroupMemberConnectionContext = createContext<(member: GroupChatMember) => boolean | undefined>(() => undefined);

export default function GroupMemberAvatar({ member, className }: { member?: GroupChatMember; className?: string }) {
  const connection = useContext(GroupMemberConnectionContext);
  const connected = member && (connection(member) ?? (member.card?.availability !== "offline"));
  return <AgentAvatar agentId={member?.agentId} name={member?.displayName} className={className}
    grayscale={member?.state === "removed" || member?.agentMissing === true || connected === false} />;
}
