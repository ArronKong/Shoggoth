import { useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { useTranslation } from "react-i18next";
import { OPENCLAW_EMOJI_GROUPS, type OpenClawEmojiGroupId } from "../../lib/openclaw-emojis";
import styles from "./EmojiField.module.css";

export default function EmojiField({
  value,
  onChange,
  className = "field-input",
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [groupId, setGroupId] = useState<OpenClawEmojiGroupId>("smileys");
  const group = useMemo(
    () => OPENCLAW_EMOJI_GROUPS.find((item) => item.id === groupId) ?? OPENCLAW_EMOJI_GROUPS[0],
    [groupId],
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger
        nativeButton={false}
        render={
          <input
            className={className}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
          />
        }
      />
      <Popover.Portal>
        <Popover.Positioner className={styles.positioner} sideOffset={6} align="start">
          <Popover.Popup className={styles.popup} aria-label={t("agents.pickEmoji")}>
            <div className={styles.cats} role="tablist" aria-label={t("agents.pickEmoji")}>
              {OPENCLAW_EMOJI_GROUPS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  className={styles.cat}
                  aria-selected={item.id === groupId}
                  aria-label={t(`agents.emojiCat.${item.id}`)}
                  title={t(`agents.emojiCat.${item.id}`)}
                  data-on={item.id === groupId ? "" : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setGroupId(item.id)}
                >
                  {item.icon}
                </button>
              ))}
            </div>
            <div className={styles.scroller}>
              <div className={styles.grid}>
                {group.emojis.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className={styles.cell}
                    data-selected={value === emoji ? "" : undefined}
                    aria-label={emoji}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      onChange(emoji);
                      setOpen(false);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
