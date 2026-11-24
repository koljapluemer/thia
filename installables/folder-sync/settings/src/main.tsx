import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LangProvider } from '@gestalts/i18n';
import { App } from './App';
import './app.css';

createRoot(document.getElementById('app')!).render(<StrictMode><LangProvider><App /></LangProvider></StrictMode>);
