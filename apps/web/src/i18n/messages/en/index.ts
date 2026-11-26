import { accuracyMessages } from './accuracy';
import { activityMessages } from './activity';
import { appearanceMessages } from './appearance';
import { common } from './common';
import { compareMessages } from './compare';
import { detailsMessages } from './details';
import { editor } from './editor';
import { exportMessages } from './export';
import { findMessages } from './find';
import { groupingMessages } from './grouping';
import { guideMessages } from './guide';
import { historyMessages } from './history';
import { home } from './home';
import { inboxMessages } from './inbox';
import { libraryMessages } from './library';
import { review } from './review';
import { setup } from './setup';
import { timingMessages } from './timing';
import { updatesMessages } from './updates';

export const en = {
  common,
  home,
  setup,
  editor,
  review,
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
} as const;
