CREATE TABLE IF NOT EXISTS contributors (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  withdrawn_at TEXT
);

CREATE TABLE IF NOT EXISTS samples (
  candidate_id TEXT PRIMARY KEY,
  contributor_id TEXT NOT NULL REFERENCES contributors(id),
  receipt_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('submitted', 'verified', 'rejected', 'withdrawn')),
  original_text TEXT NOT NULL,
  corrected_text TEXT NOT NULL,
  caption_start_ms INTEGER NOT NULL,
  caption_end_ms INTEGER NOT NULL,
  clip_start_ms INTEGER NOT NULL,
  clip_end_ms INTEGER NOT NULL,
  source_timing_source TEXT NOT NULL,
  source_text_model TEXT,
  source_engine_version TEXT,
  app_version TEXT NOT NULL,
  audio_sha256 TEXT NOT NULL,
  audio_duration_ms INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT,
  rejected_at TEXT,
  rejection_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_samples_contributor_created ON samples(contributor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_samples_status_updated ON samples(status, updated_at DESC);
