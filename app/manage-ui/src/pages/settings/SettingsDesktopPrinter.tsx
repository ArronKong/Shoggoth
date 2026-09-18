import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { desktopInspirationBridge, type DesktopShortcutState } from '../../lib/desktop-inspiration';

export function shortcutFromKeyboard(event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | null {
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5)
    : /^F([1-9]|1[0-9]|2[0-4])$/.test(event.code) || event.code === 'Space' ? event.code : null;
  if (!key || (!event.metaKey && !event.ctrlKey && !event.altKey)) return null;
  return [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Command', key].filter(Boolean).join('+');
}
export const displayShortcut = (value: string) => value.replace('Control+', '⌃').replace('Alt+', '⌥').replace('Shift+', '⇧').replace('Command+', '⌘');

export default function SettingsDesktopPrinter({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const host = desktopInspirationBridge();
  const [state, setState] = useState<DesktopShortcutState>({ accelerator: 'Alt+S', registered: false });
  const [capturing, setCapturing] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const mounted = useRef(true), capture = useRef(false), operation = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void host?.getPreferences?.().then(value => { if (mounted.current) setState(value); }).catch(() => {
      if (mounted.current) setMessage('saveFailed');
    });
    return () => { mounted.current = false; if (capture.current) void host?.captureShortcut?.(false); };
  }, [host]);
  const endCapture = () => {
    capture.current = false; setCapturing(false);
    void host?.captureShortcut?.(false).catch(() => {});
  };
  useEffect(() => {
    if (!capturing) return;
    const timer = window.setTimeout(endCapture, 30_000);
    window.addEventListener('blur', endCapture);
    return () => { window.clearTimeout(timer); window.removeEventListener('blur', endCapture); };
  }, [capturing, host]);
  const begin = async () => {
    if (disabled || operation.current || !host?.captureShortcut) return;
    setMessage(''); operation.current = true; setBusy(true);
    try {
      await host.captureShortcut(true);
      if (!mounted.current) { await host.captureShortcut(false); return; }
      capture.current = true; setCapturing(true);
    } catch { if (mounted.current) setMessage('saveFailed'); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };
  const apply = async (accelerator: string) => {
    if (operation.current || !host?.setShortcut) return;
    operation.current = true; capture.current = false; setCapturing(false); setBusy(true); setMessage('');
    try {
      const next = await host.setShortcut(accelerator);
      if (mounted.current) { setState(next); setMessage(next.ok ? 'saved' : next.error || 'saveFailed'); }
    } catch { if (mounted.current) setMessage('saveFailed'); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };
  return <section className="settings-section" id="settings-desktop-printer">
    <header className="settings-section-head"><h3 className="settings-h">{t('settings.desktopPrinter.title')}</h3>
      <p className="settings-sech">{t('settings.desktopPrinter.description')}</p></header>
    <div className="settings-card">
      <div className="settings-shortcut-row">
        <span>{t('settings.desktopPrinter.shortcut')}</span>
        <button type="button" className="ui-cbtn settings-shortcut" disabled={disabled || !host?.setShortcut} aria-busy={busy || undefined}
          aria-label={t(capturing ? 'settings.desktopPrinter.recording' : 'settings.desktopPrinter.change')}
          data-shortcut-capturing={capturing || undefined} onClick={() => { void begin(); }} onBlur={() => { if (capture.current) endCapture(); }}
          onKeyDown={event => {
            if (!capture.current) return;
            event.preventDefault(); event.stopPropagation();
            if (event.key === 'Escape') { endCapture(); return; }
            if (event.repeat || event.nativeEvent.isComposing) return;
            const accelerator = shortcutFromKeyboard(event);
            if (accelerator) void apply(accelerator);
          }}>
          {capturing ? t('settings.desktopPrinter.recording') : <kbd>{displayShortcut(state.accelerator)}</kbd>}
        </button>
        <button type="button" className="btn-subtle" disabled={disabled || busy || !host?.setShortcut || state.accelerator === 'Alt+S'}
          onClick={() => { void apply('Alt+S'); }}>{t('settings.desktopPrinter.reset')}</button>
      </div>
      <p className="ui-hint" role="status">{!host?.setShortcut ? t('settings.desktopPrinter.appOnly')
        : message ? t(`settings.desktopPrinter.${message}`) : !state.registered && !capturing ? t('settings.desktopPrinter.unavailable')
          : t('settings.desktopPrinter.hint')}</p>
    </div>
  </section>;
}
