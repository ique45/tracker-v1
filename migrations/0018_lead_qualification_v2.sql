-- Rebuild lead_qualification with the new 5-question flow.
-- Replaces: idade, trafego, desafio  →  instagram, especialidade, foco, disposto
DROP TABLE IF EXISTS lead_qualification;

CREATE TABLE lead_qualification (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  instagram     TEXT,
  especialidade TEXT,
  faturamento   TEXT,
  foco          TEXT,
  disposto      TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_lq_session ON lead_qualification(session_id);
