import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installCaptionMediaClock } from './media-clock';
import './workspace-tool-strip.css';
import { ContributionPromptHost } from './components/ContributionPromptHost';
import { PrivacyUpgradeHost } from './components/PrivacyUpgradeHost';

const root = document.getElementById('root')!;
installCaptionMediaClock(root);
createRoot(root).render(
  <StrictMode><App/><PrivacyUpgradeHost/><ContributionPromptHost/></StrictMode>,
);
