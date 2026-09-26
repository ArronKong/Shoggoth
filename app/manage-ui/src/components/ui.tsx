// App-wide UI services: imperative toasts + a promise-based confirm dialog.
// Mounted once at the app root (see main.tsx). Pages call useToast()/useConfirm().
// Both are built on base-ui: Toast (a11y live region + hover-pause auto-dismiss)
// and AlertDialog (focus trap, Escape, ARIA). Styling is in ui.module.css.
// The toast functions are built from Toast.useToastManager() (the hook owns the
// reactive list), then handed to pages via UiContext.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Toast } from "@base-ui/react/toast";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useTranslation } from "react-i18next";
import styles from "./ui.module.css";

interface ConfirmOpts {
  title?: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

// 带输入框的确认框（= window.prompt 的应用内版本）。取消返回 null；
// required 时空值不放行（看板「完成摘要」是必填项）。
interface PromptOpts {
  title?: string;
  message?: ReactNode;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  required?: boolean;
  multiline?: boolean;
}

interface UiApi {
  toast: {
    success: (text: string) => void;
    error: (text: string) => void;
    info: (text: string) => void;
  };
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  prompt: (opts: PromptOpts) => Promise<string | null>;
}

type ConfirmRequest = ConfirmOpts & {
  requestId: number;
  resolve: (value: boolean) => void;
};

type PromptRequest = PromptOpts & {
  requestId: number;
  resolve: (value: string | null) => void;
};

const UiContext = createContext<UiApi | null>(null);

export function useUi(): UiApi {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error("useUi must be used inside <UiProvider>");
  return ctx;
}
export function useToast() {
  return useUi().toast;
}
export function useConfirm() {
  return useUi().confirm;
}
export function usePrompt() {
  return useUi().prompt;
}

const TOAST_KIND: Record<string, string> = {
  success: styles.success,
  error: styles.error,
  info: styles.info,
};

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return (
    <>
      {toasts.map((t) => (
        <Toast.Root
          key={t.id}
          toast={t}
          className={`${styles.toast} ${TOAST_KIND[t.type ?? "info"] ?? styles.info}`}
        >
          <Toast.Title className={styles.toastTitle} />
        </Toast.Root>
      ))}
    </>
  );
}

export function UiProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider>
      <UiInner>{children}</UiInner>
    </Toast.Provider>
  );
}

function UiInner({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const manager = Toast.useToastManager();

  const toast = useMemo(
    () => ({
      success: (text: string) => manager.add({ title: text, type: "success", timeout: 4200 }),
      error: (text: string) => manager.add({ title: text, type: "error", timeout: 4200 }),
      info: (text: string) => manager.add({ title: text, type: "info", timeout: 4200 }),
    }),
    [manager],
  );

  const [confirmState, setConfirmState] = useState<ConfirmRequest | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmStateRef = useRef<ConfirmRequest | null>(null);
  const confirmOpenRef = useRef(false);
  const confirmRequestId = useRef(0);
  const settledConfirmIds = useRef(new Set<number>());
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback(
    (opts: ConfirmOpts) =>
      new Promise<boolean>((resolve) => {
        const request = { ...opts, requestId: ++confirmRequestId.current, resolve };
        settledConfirmIds.current.clear();
        confirmStateRef.current = request;
        confirmOpenRef.current = true;
        setConfirmState(request);
        setConfirmOpen(true);
      }),
    [],
  );
  const closeConfirm = useCallback((requestId: number | undefined, value: boolean) => {
    const request = confirmStateRef.current;
    if (!request || request.requestId !== requestId || settledConfirmIds.current.has(requestId)) {
      return;
    }
    settledConfirmIds.current.add(requestId);
    request.resolve(value);
    confirmOpenRef.current = false;
    setConfirmOpen(false);
  }, []);
  const completeConfirmTransition = useCallback((requestId: number | undefined, open: boolean) => {
    if (open || confirmOpenRef.current) return;
    const request = confirmStateRef.current;
    // Base UI 可能在快速关闭再打开后送达上一轮的完成事件；旧事件不能清掉新请求。
    if (!request || request.requestId !== requestId) return;
    confirmStateRef.current = null;
    settledConfirmIds.current.delete(requestId);
    setConfirmState((current) => current?.requestId === requestId ? null : current);
  }, []);

  const [promptState, setPromptState] = useState<PromptRequest | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const promptStateRef = useRef<PromptRequest | null>(null);
  const promptOpenRef = useRef(false);
  const promptRequestId = useRef(0);
  const settledPromptIds = useRef(new Set<number>());
  const [promptValue, setPromptValue] = useState("");
  const promptInputRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);

  const prompt = useCallback(
    (opts: PromptOpts) =>
      new Promise<string | null>((resolve) => {
        setPromptValue(opts.defaultValue || "");
        const request = { ...opts, requestId: ++promptRequestId.current, resolve };
        settledPromptIds.current.clear();
        promptStateRef.current = request;
        promptOpenRef.current = true;
        setPromptState(request);
        setPromptOpen(true);
      }),
    [],
  );
  const closePrompt = useCallback((requestId: number | undefined, value: string | null) => {
    const request = promptStateRef.current;
    if (!request || request.requestId !== requestId || settledPromptIds.current.has(requestId)) {
      return;
    }
    settledPromptIds.current.add(requestId);
    request.resolve(value);
    promptOpenRef.current = false;
    setPromptOpen(false);
  }, []);
  const completePromptTransition = useCallback((requestId: number | undefined, open: boolean) => {
    if (open || promptOpenRef.current) return;
    const request = promptStateRef.current;
    if (!request || request.requestId !== requestId) return;
    promptStateRef.current = null;
    settledPromptIds.current.delete(requestId);
    setPromptState((current) => current?.requestId === requestId ? null : current);
  }, []);
  const promptTrimmed = promptValue.trim();
  const promptBlocked = !!promptState?.required && !promptTrimmed;
  // React 18 只有字符串空属性会稳定输出 inert=""；打开态必须完全省略该属性。
  const confirmInertProps: Record<string, string> = confirmOpen ? {} : { inert: "" };
  const promptInertProps: Record<string, string> = promptOpen ? {} : { inert: "" };

  const api = useMemo(() => ({ toast, confirm, prompt }), [toast, confirm, prompt]);

  return (
    <UiContext.Provider value={api}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className={styles.toastStack}>
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
      <AlertDialog.Root
        key={confirmState?.requestId ?? "confirm-idle"}
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) closeConfirm(confirmState?.requestId, false);
        }}
        onOpenChangeComplete={(open) => completeConfirmTransition(confirmState?.requestId, open)}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className={styles.modalOverlay} />
          <AlertDialog.Popup
            className={styles.modalPanel}
            initialFocus={confirmBtnRef}
            {...confirmInertProps}
          >
            <AlertDialog.Title className={styles.modalTitle}>
              {confirmState?.title || t("common.confirm")}
            </AlertDialog.Title>
            <div className={styles.modalBody}>{confirmState?.message}</div>
            <div className={styles.modalFoot}>
              {/* 文字小弹窗的动作是 Medium 40 档（设计稿 7111:428/430），比内容弹窗矮一档。 */}
              <button
                className="btn-secondary btn-md"
                onClick={() => closeConfirm(confirmState?.requestId, false)}
              >
                {confirmState?.cancelLabel || t("common.cancel")}
              </button>
              <button
                ref={confirmBtnRef}
                className={`${confirmState?.danger ? "btn-danger" : "btn-primary"} btn-md`}
                onClick={() => closeConfirm(confirmState?.requestId, true)}
              >
                {confirmState?.confirmLabel || t("common.ok")}
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      <AlertDialog.Root
        key={promptState?.requestId ?? "prompt-idle"}
        open={promptOpen}
        onOpenChange={(open) => {
          if (!open) closePrompt(promptState?.requestId, null);
        }}
        onOpenChangeComplete={(open) => completePromptTransition(promptState?.requestId, open)}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className={styles.modalOverlay} />
          <AlertDialog.Popup
            className={styles.modalPanel}
            initialFocus={promptInputRef}
            {...promptInertProps}
          >
            <AlertDialog.Title className={styles.modalTitle}>
              {promptState?.title || t("common.confirm")}
            </AlertDialog.Title>
            <div className={styles.modalBody}>
              {promptState?.message && <p className="muted">{promptState.message}</p>}
              {promptState?.multiline ? (
                <textarea
                  ref={promptInputRef as RefObject<HTMLTextAreaElement>}
                  className="field-textarea"
                  rows={4}
                  value={promptValue}
                  placeholder={promptState?.placeholder}
                  onChange={(e) => setPromptValue(e.target.value)}
                />
              ) : (
                <input
                  ref={promptInputRef as RefObject<HTMLInputElement>}
                  className="field-input"
                  value={promptValue}
                  placeholder={promptState?.placeholder}
                  onChange={(e) => setPromptValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !promptBlocked) {
                      closePrompt(promptState?.requestId, promptTrimmed);
                    }
                  }}
                />
              )}
            </div>
            <div className={styles.modalFoot}>
              <button
                className="btn-secondary btn-md"
                onClick={() => closePrompt(promptState?.requestId, null)}
              >
                {promptState?.cancelLabel || t("common.cancel")}
              </button>
              <button
                className="btn-primary btn-md"
                disabled={promptBlocked}
                onClick={() => closePrompt(promptState?.requestId, promptTrimmed)}
              >
                {promptState?.confirmLabel || t("common.ok")}
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </UiContext.Provider>
  );
}
