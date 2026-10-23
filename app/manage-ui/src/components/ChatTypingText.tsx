import styles from "./ChatTypingText.module.css";

/** CSS-only typing loop: keep the complete label available without shifting the row. */
export default function ChatTypingText({ text, className }: { text: string; className?: string }) {
  const characters = Array.from(text);
  const cycleMs = Math.max(0, characters.length - 1) * 160 + 1000;
  const resetAt = (cycleMs - 200) / cycleMs * 100;

  return (
    <span className={[styles.root, className].filter(Boolean).join(" ")}>
      <span className={styles.accessible}>{text}</span>
      <span aria-hidden="true">
        {characters.map((character, index) => {
          const revealAt = index * 160 / cycleMs * 100;
          return (
            <span key={`${text}-${index}`} className={styles.character} style={{
              animationDuration: `${cycleMs}ms`,
              // Reset only the suffix; CSS keeps the first character visible throughout.
              animationTimingFunction: `linear(0, 0 ${revealAt}%, 1 ${revealAt}%, 1 ${resetAt}%, 0 ${resetAt}%, 0)`,
            }}>{character}</span>
          );
        })}
      </span>
    </span>
  );
}
