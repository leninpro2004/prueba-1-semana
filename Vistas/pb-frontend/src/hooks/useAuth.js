import { useContext } from 'react';
import { AuthContext } from '../contexts/AuthContext';

/** Reemplaza getCurrentUser() de layout.js. */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return ctx;
}
