CREATE TABLE IF NOT EXISTS lead_qualification (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  idade       TEXT,
  faturamento TEXT,
  trafego     TEXT,
  desafio     TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_lq_session ON lead_qualification(session_id);
