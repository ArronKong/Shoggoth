import type { ComponentProps } from "react";
import Modal from "../components/Modal";
import styles from "./GroupChatFormModal.module.css";

export default function GroupChatFormModal(props: Omit<ComponentProps<typeof Modal>, "width" | "className">) {
  return <Modal {...props} width={600} className={styles.dialog} />;
}
