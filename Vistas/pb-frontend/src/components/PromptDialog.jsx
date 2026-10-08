import { useEffect, useRef, useState } from 'react';
import { overlayStyle, boxStyle, titleStyle, cancelBtnStyle, okBtnStyle } from './ConfirmDialog';

/** Reemplaza pbPrompt de api.js. */
export default function PromptDialog({ message, title, placeholder, onAccept, onCancel }) {
  const [value, setValue] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div id="pb-dialog-overlay" style={overlayStyle}>
      <div style={boxStyle}>
        <div style={titleStyle}>{title || 'Ingrese información'}</div>
        <div style={{ fontSize: 14, color: '#555', lineHeight: 1.5, marginBottom: 12 }}>{message}</div>
        <input
          id="pb-dlg-input"
          ref={inputRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onAccept(value); }}
          placeholder={placeholder || ''}
          style={{
            width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8,
            fontSize: 14, boxSizing: 'border-box', marginBottom: 16,
          }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button id="pb-dlg-cancel" style={cancelBtnStyle} onClick={onCancel}>Cancelar</button>
          <button id="pb-dlg-ok" style={okBtnStyle} onClick={() => onAccept(value)}>Aceptar</button>
        </div>
      </div>
    </div>
  );
}
