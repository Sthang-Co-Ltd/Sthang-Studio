import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ContributionPromptHost } from './components/ContributionPromptHost';

createRoot(document.getElementById('root')!).render(<StrictMode><App/><ContributionPromptHost/></StrictMode>);
