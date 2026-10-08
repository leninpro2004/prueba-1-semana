import { createContext, useContext, useEffect, useState } from 'react';

/**
 * En el HTML el título del topbar salía de document.title sin " — Puertas Blindadas".
 * Aquí cada página lo declara con usePageTitle('Dashboard').
 */
export const TitleContext = createContext({ title: '', setTitle: () => {} });

export function TitleProvider({ children }) {
  const [title, setTitle] = useState('');
  return <TitleContext.Provider value={{ title, setTitle }}>{children}</TitleContext.Provider>;
}

export function usePageTitle(title) {
  const { setTitle } = useContext(TitleContext);
  useEffect(() => {
    setTitle(title);
    document.title = title ? `${title} — Puertas Blindadas` : 'Puertas Blindadas';
  }, [title, setTitle]);
}
