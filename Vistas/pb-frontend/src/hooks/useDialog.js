import { useContext } from 'react';
import { DialogContext } from '../components/DialogProvider';

/** Reemplazo de pbConfirm(message, title) → Promise<boolean> */
export function useConfirm() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useConfirm debe usarse dentro de <DialogProvider>');
  return ctx.confirm;
}

/** Reemplazo de pbPrompt(message, title, placeholder) → Promise<string|null> */
export function usePrompt() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('usePrompt debe usarse dentro de <DialogProvider>');
  return ctx.prompt;
}
