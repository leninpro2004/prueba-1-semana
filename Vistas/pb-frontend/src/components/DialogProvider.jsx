import { createContext, useCallback, useMemo, useState } from 'react';
import ConfirmDialog from './ConfirmDialog';
import PromptDialog from './PromptDialog';

export const DialogContext = createContext(null);

/**
 * Provee confirm()/prompt() como Promises, reemplazando pbConfirm/pbPrompt de api.js.
 * Solo puede haber un diálogo abierto a la vez (igual que el overlay único original).
 */
export function DialogProvider({ children }) {
  const [dialog, setDialog] = useState(null);

  const confirm = useCallback((message, title) => new Promise(resolve => {
    setDialog({ kind: 'confirm', message, title, resolve });
  }), []);

  const prompt = useCallback((message, title, placeholder) => new Promise(resolve => {
    setDialog({ kind: 'prompt', message, title, placeholder, resolve });
  }), []);

  const close = (result) => {
    dialog?.resolve(result);
    setDialog(null);
  };

  const value = useMemo(() => ({ confirm, prompt }), [confirm, prompt]);

  return (
    <DialogContext.Provider value={value}>
      {children}
      {dialog?.kind === 'confirm' && (
        <ConfirmDialog
          message={dialog.message}
          title={dialog.title}
          onConfirm={() => close(true)}
          onCancel={() => close(false)}
        />
      )}
      {dialog?.kind === 'prompt' && (
        <PromptDialog
          message={dialog.message}
          title={dialog.title}
          placeholder={dialog.placeholder}
          onAccept={(v) => close(v)}
          onCancel={() => close(null)}
        />
      )}
    </DialogContext.Provider>
  );
}
