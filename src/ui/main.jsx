import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// Injected by src/server/dashboard.ts at request time, not at build time. The
// defaults exist so `vite dev` works standalone against the proxy config.
const config = window.__TELEMETRY__ ?? {
  apiBase: '/telemetry/api',
  mountPath: '/telemetry',
  title: 'Telemetry',
};

createRoot(document.getElementById('telemetry-root')).render(
  <React.StrictMode>
    <App config={config} />
  </React.StrictMode>,
);
