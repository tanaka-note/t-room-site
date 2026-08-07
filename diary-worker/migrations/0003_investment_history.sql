CREATE TABLE IF NOT EXISTS investment_history (
  recorded_at TEXT PRIMARY KEY,
  total INTEGER NOT NULL CHECK (total >= 0),
  cash INTEGER NOT NULL DEFAULT 0 CHECK (cash >= 0),
  stocks INTEGER NOT NULL DEFAULT 0 CHECK (stocks >= 0),
  funds INTEGER NOT NULL DEFAULT 0 CHECK (funds >= 0),
  bonds INTEGER NOT NULL DEFAULT 0 CHECK (bonds >= 0),
  crypto INTEGER NOT NULL DEFAULT 0 CHECK (crypto >= 0),
  futures INTEGER NOT NULL DEFAULT 0 CHECK (futures >= 0),
  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  other INTEGER NOT NULL DEFAULT 0 CHECK (other >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
