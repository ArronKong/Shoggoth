import type { ButtonHTMLAttributes } from "react";
import ChatFileIcon from "./ChatFileIcon";
import "./ChatFileButton.css";

type FileLabelProps = { name: string };

export function ChatFileLabel({ name }: FileLabelProps) {
  return <span className="chat-file-label">
    <ChatFileIcon />
    <span className="chat-file-name">{name}</span>
  </span>;
}

export default function ChatFileButton({ name, className, title = name, type = "button", ...props }:
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "name"> & FileLabelProps) {
  return <button {...props} type={type} title={title} className={`chat-file-button${className ? ` ${className}` : ""}`}>
    <ChatFileLabel name={name} />
  </button>;
}
