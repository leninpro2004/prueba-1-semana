import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './assets/css/global.css';
import App from './App.jsx';
import { leerPaleta, aplicarPaleta, leerVista, aplicarVista } from './utils/paleta';

// F-25a: antes del primer render, para que no parpadee el color ni la composición.
aplicarPaleta(leerPaleta());
aplicarVista(leerVista());

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
