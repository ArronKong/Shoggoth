import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EnvVar } from "../../types";
import { TextInput } from "../../components/Field";
import styles from "./KeysPanel.module.css";

// Hide tool-key management across backends while retaining existing configuration and UI.
export const SHOW_TOOL_KEYS = false;

export type ToolKeyItem = EnvVar & {
  canReveal: boolean;
  canValidate: boolean;
  canClear: boolean;
};

type MutationResult = boolean | void;

type ToolKeyRowProps = {
  item: ToolKeyItem;
  compact?: boolean;
  onSave: (key: string, value: string) => Promise<MutationResult>;
  onReveal: (key: string) => Promise<string | null>;
  onValidate: (key: string, value: string) => Promise<void>;
  onClear: (key: string) => Promise<MutationResult>;
};

export type ToolKeysCardProps = {
  id?: string;
  title: string;
  description: string;
  emptyText?: string;
  errorText?: string;
  setEntries: ToolKeyItem[];
  unsetEntries: ToolKeyItem[];
  showUnsetDirectory: boolean;
  canAdd: boolean;
  loading: boolean;
  onAdd?: (key: string, value: string) => Promise<MutationResult>;
  onSave: ToolKeyRowProps["onSave"];
  onReveal: ToolKeyRowProps["onReveal"];
  onValidate: ToolKeyRowProps["onValidate"];
  onClear: ToolKeyRowProps["onClear"];
};

export function ToolKeyRow({
  item,
  compact = false,
  onSave,
  onReveal,
  onValidate,
  onClear,
}: ToolKeyRowProps) {
  const { t } = useTranslation();
  const [editValue, setEditValue] = useState<string | null>(null);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revealGeneration = useRef(0);

  useEffect(() => {
    revealGeneration.current += 1;
    setEditValue(null);
    setRevealedValue(null);
    setBusy(false);
    return () => {
      revealGeneration.current += 1;
    };
  }, [item.key, item.redactedValue, item.isSet]);

  const save = async () => {
    if (!editValue) return;
    setBusy(true);
    try {
      const result = await onSave(item.key, editValue);
      if (result !== false) {
        setEditValue(null);
        setRevealedValue(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleReveal = async () => {
    if (revealedValue !== null) {
      revealGeneration.current += 1;
      setRevealedValue(null);
      return;
    }
    const generation = ++revealGeneration.current;
    setBusy(true);
    try {
      const value = await onReveal(item.key);
      if (generation === revealGeneration.current && value !== null) setRevealedValue(value);
    } finally {
      if (generation === revealGeneration.current) setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      const result = await onClear(item.key);
      if (result !== false) {
        setEditValue(null);
        setRevealedValue(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const validate = async () => {
    if (!editValue) return;
    setBusy(true);
    try {
      await onValidate(item.key, editValue);
    } finally {
      setBusy(false);
    }
  };

  const getKeyLink = item.url ? (
    <a className={styles.getKey} href={item.url} target="_blank" rel="noreferrer">
      {t("keys.getKey")} ↗
    </a>
  ) : null;

  if (compact && !item.isSet && editValue === null) {
    return (
      <div className={styles.rowCompact} data-tool-key-row>
        <div className={styles.rowCompactMeta}>
          <span className="mono">{item.key}</span>
          {item.description && <span className={styles.rowCompactDesc}>{item.description}</span>}
        </div>
        <div className={styles.rowActions}>
          {getKeyLink}
          <button className={styles.smallBtn} onClick={() => setEditValue("")}>
            {t("keys.set")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.row} data-tool-key-row>
      <div className={styles.rowHead}>
        <div className={styles.rowKey}>
          <span className="mono">{item.key}</span>
          <span className={`${styles.badge} ${item.isSet ? styles.badgeOk : ""}`}>
            {item.isSet ? t("keys.set") : t("keys.notSet")}
          </span>
        </div>
        {getKeyLink}
      </div>

      {item.description && <p className={styles.rowDesc}>{item.description}</p>}

      {!!item.tools?.length && (
        <div className={styles.tools}>
          {item.tools.map((tool) => (
            <span key={tool} className={styles.tool}>
              {tool}
            </span>
          ))}
        </div>
      )}

      {editValue === null ? (
        <div className={styles.rowActions}>
          <div className={`${styles.value} mono ${revealedValue !== null ? styles.valueShown : ""}`}>
            {item.isSet ? (revealedValue ?? item.redactedValue ?? "—") : "—"}
          </div>
          {item.isSet && item.canReveal && (
            <button
              className={styles.smallBtn}
              disabled={busy}
              aria-label={revealedValue !== null ? t("keys.hide") : t("keys.reveal")}
              onClick={() => void toggleReveal()}
            >
              {revealedValue !== null ? t("keys.hide") : t("keys.reveal")}
            </button>
          )}
          <button
            className={styles.smallBtn}
            aria-label={item.isSet ? t("keys.replace") : t("keys.set")}
            onClick={() => setEditValue("")}
          >
            {item.isSet ? t("keys.replace") : t("keys.set")}
          </button>
          {item.isSet && item.canClear && (
            <button
              className={`${styles.smallBtn} btn-danger`}
              disabled={busy}
              aria-label={t("keys.clear")}
              onClick={() => void clear()}
            >
              {busy ? "…" : t("keys.clear")}
            </button>
          )}
        </div>
      ) : (
        <div className={styles.rowActions}>
          <TextInput
            autoFocus
            type={item.isPassword ? "password" : "text"}
            className="field-input field-mono"
            value={editValue}
            autoComplete="off"
            aria-label={item.key}
            onChange={(event) => setEditValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && editValue) void save();
              if (event.key === "Escape") setEditValue(null);
            }}
            placeholder={
              item.isSet
                ? t("keys.replaceCurrent", { preview: item.redactedValue ?? "—" })
                : t("keys.enterValue")
            }
          />
          <button
            className={styles.smallBtn}
            disabled={busy || !editValue}
            aria-label={t("common.save")}
            onClick={() => void save()}
          >
            {busy ? "…" : t("common.save")}
          </button>
          {item.canValidate && (
            <button
              className={styles.smallBtn}
              disabled={busy || !editValue}
              aria-label={t("keys.validate")}
              onClick={() => void validate()}
            >
              {t("keys.validate")}
            </button>
          )}
          <button
            className={styles.smallBtn}
            disabled={busy}
            aria-label={t("common.cancel")}
            onClick={() => setEditValue(null)}
          >
            {t("common.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}

export function ToolKeysCard({
  id,
  title,
  description,
  emptyText,
  errorText,
  setEntries,
  unsetEntries,
  showUnsetDirectory,
  canAdd,
  loading,
  onAdd,
  onSave,
  onReveal,
  onValidate,
  onClear,
}: ToolKeysCardProps) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(setEntries.length === 0);
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [addingBusy, setAddingBusy] = useState(false);
  const addGeneration = useRef(0);
  const visibleUnsetEntries = showUnsetDirectory && showAll ? unsetEntries : [];

  useEffect(() => () => {
    addGeneration.current += 1;
  }, []);

  const clearAdd = () => {
    addGeneration.current += 1;
    setAdding(false);
    setNewKey("");
    setNewValue("");
    setAddingBusy(false);
  };

  const add = async () => {
    if (!onAdd || !newKey.trim() || !newValue.trim()) return;
    const generation = ++addGeneration.current;
    setAddingBusy(true);
    try {
      const result = await onAdd(newKey, newValue);
      if (generation === addGeneration.current && result !== false) clearAdd();
    } finally {
      if (generation === addGeneration.current) setAddingBusy(false);
    }
  };

  return (
    <section className={styles.card} id={id}>
      <div className={styles.cardHead}>
        <div className={styles.cardHeadRow}>
          <h4 className={styles.cardTitle}>{title}</h4>
          {canAdd ? (
            <button
              className={styles.smallBtn}
              disabled={addingBusy}
              onClick={() => {
                if (adding) clearAdd();
                else setAdding(true);
              }}
            >
              {adding ? t("common.cancel") : t("models.envAdd")}
            </button>
          ) : showUnsetDirectory && unsetEntries.length > 0 ? (
            <button
              className={styles.linkBtn}
              aria-expanded={showAll}
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? t("keys.showLess") : t("keys.showMore")}
            </button>
          ) : null}
        </div>
        <p className={styles.cardDesc}>{description}</p>
      </div>
      {(loading || adding || setEntries.length > 0 || visibleUnsetEntries.length > 0 || emptyText || errorText) && (
        <div className={styles.cardBody}>
          {errorText && <div className="error">{errorText}</div>}
          {adding && (
            <div className={styles.addForm}>
              <div className={styles.addRow}>
                <TextInput
                  autoFocus
                  className="field-input field-mono"
                  value={newKey}
                  disabled={addingBusy}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t("models.envKeyLabel")}
                  placeholder="EXA_API_KEY"
                  onChange={(event) => setNewKey(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && !addingBusy) clearAdd();
                  }}
                />
                <TextInput
                  type="password"
                  className="field-input field-mono"
                  value={newValue}
                  disabled={addingBusy}
                  autoComplete="off"
                  aria-label={t("models.envValueLabel")}
                  placeholder={t("keys.enterValue")}
                  onChange={(event) => setNewValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void add();
                    if (event.key === "Escape" && !addingBusy) clearAdd();
                  }}
                />
                <button
                  className={styles.smallBtn}
                  disabled={addingBusy || !newKey.trim() || !newValue.trim()}
                  aria-label={t("common.save")}
                  onClick={() => void add()}
                >
                  {addingBusy ? "…" : t("common.save")}
                </button>
              </div>
            </div>
          )}
          {loading && <p className="muted">{t("common.loading")}</p>}
          {!loading && setEntries.length === 0 && visibleUnsetEntries.length === 0 && !adding && emptyText && (
            <p className="muted">{emptyText}</p>
          )}
          {setEntries.map((item) => (
            <ToolKeyRow
              key={item.key}
              item={item}
              onSave={onSave}
              onReveal={onReveal}
              onValidate={onValidate}
              onClear={onClear}
            />
          ))}
          {visibleUnsetEntries.map((item) => (
            <ToolKeyRow
              key={item.key}
              item={item}
              compact
              onSave={onSave}
              onReveal={onReveal}
              onValidate={onValidate}
              onClear={onClear}
            />
          ))}
        </div>
      )}
    </section>
  );
}
