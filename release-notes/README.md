# Release notes used for signed candidates

A release PR that changes Studio's version must add one bounded plain-text file:

```text
release-notes/v<version>.txt
```

The manual signing workflow reads that committed file after checking out the
exact accepted `main` commit. It does not accept release notes copied from an
issue comment or shell input.

Keep the file within Studio's updater limits: 1–4,000 characters, no more than
40 lines, and no line longer than 240 characters. Do not include credentials,
private endpoints, private media/project data, or claims that have not been
verified by the matching release evidence.

The current published version does not need a retroactive file. Add the first
file in the release PR for the next version.
