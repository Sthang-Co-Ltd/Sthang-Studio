import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './workspace-tool-strip.css';
import { ContributionPromptHost } from './components/ContributionPromptHost';
import { PrivacyUpgradeHost } from './components/PrivacyUpgradeHost';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App/><PrivacyUpgradeHost/><ContributionPromptHost/></StrictMode>,
);
