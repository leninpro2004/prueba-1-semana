import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './useAuth';

const TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const WARNING_MS = 25 * 60 * 1000; // warning a los 25 min
const EVENTS = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click'];

/**
 * CU-87 / CU-88: Timer de inactividad de sesión (30 min).
 * Devuelve { warning, extend }. Layout renderiza el banner cuando warning === true.
 */
export function useSessionTimer() {
  const { logout } = useAuth();
  const [warning, setWarning] = useState(false);
  const timer = useRef(null);
  const warningTimer = useRef(null);
  const warningShown = useRef(false);

  const resetTimer = useCallback(() => {
    clearTimeout(timer.current);
    clearTimeout(warningTimer.current);
    setWarning(false);
    warningShown.current = false;

    warningTimer.current = setTimeout(() => {
      setWarning(true);
      warningShown.current = true;
    }, WARNING_MS);

    timer.current = setTimeout(() => {
      logout('timeout');
    }, TIMEOUT_MS);
  }, [logout]);

  useEffect(() => {
    const handler = () => { if (!warningShown.current) resetTimer(); };
    EVENTS.forEach(evt => document.addEventListener(evt, handler, { passive: true }));
    resetTimer();
    return () => {
      EVENTS.forEach(evt => document.removeEventListener(evt, handler));
      clearTimeout(timer.current);
      clearTimeout(warningTimer.current);
    };
  }, [resetTimer]);

  return { warning, extend: resetTimer };
}
