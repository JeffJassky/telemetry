import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// Injected by src/server/ui.js at request time, not at build time. The defaults
// exist so `vite dev` works standalone against the proxy in vite.config.js.
const config = window.__TELEMETRY__ ?? {
  apiBase: '/api/telemetry',
  adminApiBase: '/api/telemetry/admin',
  admin: false,
  title: 'Telemetry',
  loginUrl: null,
  returnParam: 'next',
};

createRoot(document.getElementById('telemetry-root')).render(
  <React.StrictMode>
    <App config={config} />
  </React.StrictMode>,
);
