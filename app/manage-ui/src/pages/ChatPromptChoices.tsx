import { useId } from "react";

/** Native controls provide keyboard navigation; the whole row is the hit target. */
export default function ChatPromptChoices({ label, options, selected, multiple = false, disabled, onChoose }: {
  label: string;
  options: Array<{ value: string; label: string; description?: string }>;
  selected: string[];
  multiple?: boolean;
  disabled: boolean;
  onChoose: (value: string) => void;
}) {
  const name = useId();
  return <div className="chat-prompt__options" role={multiple ? "group" : "radiogroup"} aria-label={label}>
    {options.map((option, index) => <label key={option.value} className="chat-prompt__option"
      data-selected={selected.includes(option.value)} data-disabled={disabled}>
      <input type={multiple ? "checkbox" : "radio"} name={name} value={option.value}
        checked={selected.includes(option.value)} disabled={disabled}
        aria-label={option.label} aria-describedby={option.description ? `${name}-${index}` : undefined}
        onChange={() => onChoose(option.value)} />
      <span className="chat-prompt__option-copy">
        <span className="chat-prompt__option-title">{option.label}</span>
        {option.description ? <span id={`${name}-${index}`} className="chat-prompt__option-description">{option.description}</span> : null}
      </span>
    </label>)}
  </div>;
}
