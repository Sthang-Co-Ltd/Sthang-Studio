export const settingsMessages = {
  glossary: {
    truncated: "Some glossary terms were not saved. Shorten the list or long terms, then try again.",
    newerChoices: "Earlier glossary saved. Newer global glossary choices are shown.",
    saved: "Glossary saved.",
    newerDraft: "Earlier glossary saved. Your newer glossary edits are still unsaved.",
    failed: "Could not save the glossary. Your text is kept; try again.",
    saving: "Saving glossary…",
    save: "Save key terms",
    label: "Key terms for all projects",
  },
  profileImport: {
    invalid: "This file is not a readable Studio profile. Choose a JSON file created by Export profile. Your settings and drafts are unchanged.",
    confirmTitle: "Replace your saved profile?",
    confirm: "Replace profile",
    cancel: "Keep current",
    savedWithDraft: "Profile imported. Your unsaved glossary text is still in the form.",
    saved: "Profile imported.",
    failed: "Could not confirm the profile import. Your form drafts are kept. Retry this file or choose another.",
    importing: "Importing…",
    open: "Import profile",
    retry: "Retry import",
    chooseAnother: "Choose another profile",
    confirmMessage: "“{file}” will replace your saved vocabulary, correction history and rules, topic packs, presets, and preferences. You’ll need to opt in again to share usage data or contribute Khmer captions.",
  },
  loadFailed: "Could not load settings",
  loading: "Loading settings…",
  packs: {
    saving: "Saving topic pack…",
    save: "Save context as pack",
    noDescription: "No description",
    title: "Topic packs",
    description: "Reuse the current context and vocabulary in other projects.",
    name: "Topic pack name",
    openProject: "Open a project to apply a topic pack.",
    empty: "No topic packs yet.",
    apply: "Apply",
    example: "Example: AI / Coding",
    saved: "Saved topic pack “{name}”.",
    failed: "Could not save topic pack “{name}”. Your name and current context are kept; try again.",
    deleting: "Deleting topic pack “{name}”…",
    deleted: "Deleted topic pack “{name}”.",
    deleteFailed: "Could not confirm deletion of topic pack “{name}”. Try deleting it again.",
    applyLabel: "Apply {name}",
    deleteLabel: "Delete topic pack {name}",
    summary: {
      one: "{count} term · {description}",
      other: "{count} terms · {description}",
    },
  },
  title: "Settings",
  tabs: {
    ai: "AI connection",
    profile: "Profile",
    privacy: "Privacy",
    doctor: "System check",
  },
  retry: "Retry settings",
  profile: {
    keyTerms: "key terms",
    rules: "approved rules",
    events: "correction events",
    packs: "topic packs",
  },
  profileExport: "Export profile",
  close: "Close settings",
  sections: "Settings sections",
  secureStorage: {
    win32: "Windows user-protected storage (DPAPI)",
    darwin: "macOS Keychain",
    other: "Environment variable only on this platform",
  },
} as const;

export function secureStorageLabelKey(label: string) {
  if (label === settingsMessages.secureStorage.win32) return 'settings.secureStorage.win32';
  if (label === settingsMessages.secureStorage.darwin) return 'settings.secureStorage.darwin';
  if (label === settingsMessages.secureStorage.other) return 'settings.secureStorage.other';
}
