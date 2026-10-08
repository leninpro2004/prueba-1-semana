/** Reemplaza pbConfirm de api.js. Estilos inline copiados del original. */

export const overlayStyle = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  background: 'rgba(0,0,0,.45)', zIndex: 10000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
export const boxStyle = {
  background: 'var(--white,#fff)', borderRadius: 12, padding: 24,
  maxWidth: 420, width: '90%', boxShadow: '0 12px 40px rgba(0,0,0,.2)',
};
export const titleStyle = { fontWeight: 700, fontSize: 16, marginBottom: 8 };
export const cancelBtnStyle = {
  padding: '8px 20px', borderRadius: 8, border: '1px solid #ddd', background: '#fff',
  cursor: 'pointer', fontSize: 13, fontWeight: 500,
};
export const okBtnStyle = {
  padding: '8px 20px', borderRadius: 8, border: 'none', background: '#E8740C',
  color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600,
};

export default function ConfirmDialog({ message, title, onConfirm, onCancel }) {
  return (
    <div id="pb-dialog-overlay" style={overlayStyle}>
      <div style={boxStyle}>
        <div style={titleStyle}>{title || 'Confirmar acción'}</div>
        <div style={{ fontSize: 14, color: '#555', lineHeight: 1.5, marginBottom: 20 }}>{message}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button id="pb-dlg-cancel" style={cancelBtnStyle} onClick={onCancel}>Cancelar</button>
          <button id="pb-dlg-ok" style={okBtnStyle} onClick={onConfirm}>Confirmar</button>
        </div>
      </div>
    </div>
  );
}
