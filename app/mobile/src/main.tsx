import React from 'react';
import { createRoot } from 'react-dom/client';
import { MobileApp } from './App';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Mobile app root is missing');

createRoot(rootElement).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>,
);

if (isSecureContext && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/mobile/sw.js', { scope: '/mobile/' }).catch(() => undefined);
}
