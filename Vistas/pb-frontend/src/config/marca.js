/**
 * F-07 (#24): imágenes de la marca del cliente, servidas desde `public/`.
 * Para cambiar el logo se reemplazan esos archivos (o se cambian estas rutas); el favicon se
 * enlaza en `index.html`.
 *  - LOGO: logo completo, para fondos claros (Login).
 *  - LOGO_SIMBOLO: solo el símbolo, cuadrado y con fondo blanco (ícono del Sidebar).
 * Generados a partir de `public/Logo puertas blindadas.png` (el original del cliente).
 */
export const LOGO = import.meta.env.BASE_URL + 'logo.png';
export const LOGO_SIMBOLO = import.meta.env.BASE_URL + 'logo-simbolo.png';
