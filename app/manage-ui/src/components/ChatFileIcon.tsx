import chatFileIcon from "../assets/chat-file.svg";

/** Fixed 16px asset from Figma node 383:1191, shared by every file format. */
export default function ChatFileIcon() {
  return <img className="chat-file-icon" src={chatFileIcon} width="16" height="16" alt="" aria-hidden="true" />;
}
