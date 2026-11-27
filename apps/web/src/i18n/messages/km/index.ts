import type { KhmerCatalog } from '../../types';
import { accuracyMessages } from './accuracy';
import { activityMessages } from './activity';
import { appearanceMessages } from './appearance';
import { common } from './common';
import { compareMessages } from './compare';
import { detailsMessages } from './details';
import { dialogsMessages } from './dialogs';
import { editor } from './editor';
import { exportMessages } from './export';
import { findMessages } from './find';
import { groupingMessages } from './grouping';
import { guideMessages } from './guide';
import { historyMessages } from './history';
import { home } from './home';
import { inboxMessages } from './inbox';
import { libraryMessages } from './library';
import { looksMessages } from './looks';
import { mediaMessages } from './media';
import { noticesMessages } from './notices';
import { privacyMessages } from './privacy';
import { review } from './review';
import { serverMessages } from './server';
import { settingsMessages } from './settings';
import { setup } from './setup';
import { systemMessages } from './system';
import { timingMessages } from './timing';
import { updatesMessages } from './updates';
import { workspaceMessages } from './workspace';

export const km: KhmerCatalog = {
  common, home, setup, editor, review,
  export: exportMessages,
  compare: compareMessages,
  appearance: appearanceMessages,
  timing: timingMessages,
  accuracy: accuracyMessages,
  grouping: groupingMessages,
  details: detailsMessages,
  activity: activityMessages,
  history: historyMessages,
  find: findMessages,
  inbox: inboxMessages,
  updates: updatesMessages,
  guide: guideMessages,
  library: libraryMessages,
  workspace: workspaceMessages,
  settings: settingsMessages,
  privacy: privacyMessages,
  system: systemMessages,
  dialogs: dialogsMessages,
  notices: noticesMessages,
  server: serverMessages,
  looks: looksMessages,
  media: mediaMessages,
};
