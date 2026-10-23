import { useTranslation } from "react-i18next";
import type { ChatResponseMetadata as Metadata } from "../types";

/** Only the model is projected into the footer; usage/context facts stay in storage. */
export default function ChatResponseMetadata({ metadata, fallbackModel }: {
  metadata?: Metadata | null;
  fallbackModel?: string;
}) {
  const { t } = useTranslation();
  const models = metadata?.models?.length ? metadata.models
    : fallbackModel && fallbackModel !== "gateway-injected" ? [fallbackModel] : [];
  if (!models.length) return null;
  const title = [metadata?.modelSource === "selected" ? t("chat.responseSelectedModel") : "", ...models]
    .filter(Boolean).join("\n");
  return <span className="chat-response-model" title={title}>
    <span className="dot" aria-hidden="true">·</span>
    <span>{models.length === 1 ? models[0] : t("chat.responseMultipleModels")}</span>
  </span>;
}
