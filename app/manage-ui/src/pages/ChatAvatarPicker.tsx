import { useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import AgentAvatar from "../components/AgentAvatar";
import { avatarPresetPng, avatarPresetUrl, listAvatarPresets, resizeToSquarePng, uploadAvatar } from "../lib/avatar";
import profileStyles from "./ChatAgentPanel.module.css";
import styles from "./ChatAvatarPicker.module.css";

const BATCH_SIZE = 20;

function randomBatch(ids: string[], previous: string[] = []): string[] {
  const candidates = ids.filter(id => !previous.includes(id));
  const count = Math.min(BATCH_SIZE, candidates.length);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (candidates.length - i));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, count);
}

type Draft = { kind: "preset"; id: string } | { kind: "upload"; png: Blob };

export default function ChatAvatarPicker({ agentId, name, version, onSaved, onSavingChange }: {
  agentId: string; name: string; version: number;
  onSaved: (returnToProfile: boolean) => void; onSavingChange: (saving: boolean) => void;
}) {
  const { t } = useTranslation();
  const libraryId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [library, setLibrary] = useState<{ ids: string[]; batch: string[] } | "unavailable" | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [uploadPreview, setUploadPreview] = useState("");
  const [busy, setBusy] = useState<"preparing" | "saving" | null>(null);
  const [error, setError] = useState<"imageFailed" | "saveFailed" | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const saving = busy === "saving";
  useLayoutEffect(() => {
    if (!saving) return;
    onSavingChange(true);
    return () => onSavingChange(false);
  }, [saving, onSavingChange]);

  useEffect(() => {
    const controller = new AbortController();
    void listAvatarPresets(controller.signal).then(ids => {
      if (!controller.signal.aborted) setLibrary({ ids, batch: randomBatch(ids) });
    }).catch(() => {
      if (!controller.signal.aborted) setLibrary("unavailable");
    });
    return () => controller.abort();
  }, [attempt]);

  const upload = draft?.kind === "upload" ? draft.png : null;
  useLayoutEffect(() => {
    if (!upload) return;
    const url = URL.createObjectURL(upload);
    setUploadPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [upload]);

  const pickUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || busy) return;
    setBusy("preparing");
    setError(null);
    try {
      const png = await resizeToSquarePng(file);
      if (mounted.current) setDraft({ kind: "upload", png });
    } catch {
      if (mounted.current) setError("imageFailed");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const save = async () => {
    if (!draft || busy) return;
    setBusy("saving");
    setError(null);
    try {
      await uploadAvatar(agentId, draft.kind === "upload" ? draft.png : await avatarPresetPng(draft.id));
    } catch {
      if (mounted.current) {
        setError("saveFailed");
        setBusy(null);
      }
      return;
    }
    onSaved(mounted.current);
  };

  const preview = draft?.kind === "preset" ? avatarPresetUrl(draft.id) : upload ? uploadPreview : "";
  const gallery = library === "unavailable" ? null : library;
  return <section aria-labelledby="chat-avatar-picker-title">
    <div className={`${profileStyles.profileRow} ${styles.identity}`}>
      {preview ? <span className={styles.preview}><img src={preview} alt="" /></span>
        : <AgentAvatar agentId={agentId} name={name} className={styles.preview} version={version} />}
      <div className={`${profileStyles.identity} ${styles.agent}`}>
        <div className={profileStyles.name}>{name}</div>
        <div className={profileStyles.profileMeta} role="status">{t(draft ? "chat.avatarPicker.preview" : "chat.avatarPicker.current")}</div>
      </div>
      <button type="button" className={`btn-subtle btn-md ${styles.upload}`} disabled={Boolean(busy)}
        onClick={() => inputRef.current?.click()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m-4 4 4-4 4 4M5 15v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" /></svg>
        {t(busy === "preparing" ? "chat.avatarPicker.preparing" : "chat.avatarPicker.upload")}
      </button>
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={pickUpload} />
    </div>

    <div className={styles.libraryHead}>
      <h3 id={libraryId}>{t("chat.avatarPicker.library")}</h3>
      <div className={styles.libraryActions}>
        {gallery && gallery.ids.length > BATCH_SIZE && <button type="button" className={styles.quiet} disabled={Boolean(busy)}
          onClick={() => {
            setLibrary({ ids: gallery.ids, batch: randomBatch(gallery.ids, gallery.batch) });
          }}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4v5h-5M4 20v-5h5m11-6A8 8 0 0 0 6 6m-2 9a8 8 0 0 0 14 3" /></svg>
          {t("chat.avatarPicker.shuffle")}
        </button>}
        <button type="button" className="btn-dark btn-md" disabled={!draft || Boolean(busy)} onClick={() => { void save(); }}>
          {t(busy === "saving" ? "common.saving" : "chat.avatarPicker.save")}
        </button>
      </div>
    </div>
    {error && <p className={styles.error} role="alert">{t(`chat.avatarPicker.${error}`)}</p>}
    {library === null ? <div className={styles.grid} aria-label={t("common.loading")} role="status">
      {Array.from({ length: BATCH_SIZE }, (_, index) => <span className={styles.tile} key={index} />)}
    </div> : library === "unavailable" ? <div className={styles.libraryNote}>
      <p role="alert">{t("chat.avatarPicker.libraryFailed")}</p>
      <button type="button" className="btn-subtle btn-sm" onClick={() => { setLibrary(null); setAttempt(n => n + 1); }}>
        {t("common.retry")}
      </button>
    </div> : library.batch.length > 0 ? <div className={styles.grid} role="radiogroup" aria-labelledby={libraryId}>
      {library.batch.map((id, index) => <label className={styles.option} key={id}>
        <input type="radio" name={libraryId} className={styles.radio} value={id}
          aria-label={t("chat.avatarPicker.option", { number: index + 1 })} disabled={Boolean(busy)}
          checked={draft?.kind === "preset" && draft.id === id}
          onChange={() => { setError(null); setDraft({ kind: "preset", id }); }} />
        <span className={styles.tile}><img src={avatarPresetUrl(id)} alt="" draggable={false} /></span>
      </label>)}
    </div> : <p className={styles.libraryNote}>{t("chat.avatarPicker.libraryEmpty")}</p>}

  </section>;
}
