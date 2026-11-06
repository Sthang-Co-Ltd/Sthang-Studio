import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installCaptionMediaClock } from './media-clock';
import './workspace-tool-strip.css';
import { ContributionPromptHost } from './components/ContributionPromptHost';
import { PrivacyUpgradeHost } from './components/PrivacyUpgradeHost';
import { TooltipHost } from './components/TooltipHost';
import './interface-finishing.css';
import './components/find-preview-diff.css';
import './components/form-recovery.css';
import './components/guide-shortcuts.css';
import './components/export-graphite.css';

const root = document.getElementById('root')!;
installCaptionMediaClock(root);
createRoot(root).render(
  <StrictMode><App/><PrivacyUpgradeHost/><ContributionPromptHost/><TooltipHost/></StrictMode>,
);
