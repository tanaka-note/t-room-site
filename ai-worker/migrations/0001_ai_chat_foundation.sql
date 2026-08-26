PRAGMA foreign_keys = ON;

CREATE TABLE ai_accounts (
  identity_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ai_characters (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  persona_instructions TEXT NOT NULL,
  speaking_style TEXT NOT NULL DEFAULT '',
  first_person TEXT NOT NULL DEFAULT '',
  user_address TEXT NOT NULL DEFAULT '',
  voice_engine TEXT NOT NULL DEFAULT 'openai_realtime',
  voice_id TEXT,
  live2d_model_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO ai_characters
  (id, display_name, persona_instructions, speaking_style, first_person, user_address, voice_engine, voice_id)
VALUES
  ('zundamon', 'ずんだもん',
   'あなたはT-ROOMのAIキャラクター「ずんだもん」です。事実と推測を区別し、安全で役に立つ回答を日本語で行ってください。知らないことは断定しません。',
   '親しみやすく簡潔。ただし重要な説明は省略しない。', 'ボク', '宏知さん', 'openai_realtime', 'marin')
ON CONFLICT(id) DO NOTHING;

CREATE TABLE ai_character_settings (
  identity_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  memory_namespace TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (identity_id, character_id),
  UNIQUE (memory_namespace),
  FOREIGN KEY (identity_id) REFERENCES ai_accounts(identity_id) ON DELETE CASCADE,
  FOREIGN KEY (character_id) REFERENCES ai_characters(id)
);

CREATE TABLE ai_conversations (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '新しい会話',
  current_mode TEXT NOT NULL DEFAULT 'chat' CHECK (current_mode IN ('chat', 'voice')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_id) REFERENCES ai_accounts(identity_id) ON DELETE CASCADE,
  FOREIGN KEY (character_id) REFERENCES ai_characters(id)
);

CREATE INDEX idx_ai_conversations_owner
ON ai_conversations(identity_id, character_id, updated_at DESC);

CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  content_format TEXT NOT NULL DEFAULT 'text',
  source_mode TEXT NOT NULL DEFAULT 'chat' CHECK (source_mode IN ('chat', 'voice')),
  client_message_id TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  audio_input_tokens INTEGER NOT NULL DEFAULT 0,
  audio_output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (identity_id) REFERENCES ai_accounts(identity_id) ON DELETE CASCADE,
  FOREIGN KEY (character_id) REFERENCES ai_characters(id),
  UNIQUE (identity_id, client_message_id)
);

CREATE INDEX idx_ai_messages_conversation
ON ai_messages(identity_id, conversation_id, created_at, id);

CREATE TABLE ai_memories (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'summary', 'relationship')),
  content TEXT NOT NULL,
  source_conversation_id TEXT,
  importance INTEGER NOT NULL DEFAULT 50 CHECK (importance BETWEEN 0 AND 100),
  retrieval_key TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_id) REFERENCES ai_accounts(identity_id) ON DELETE CASCADE,
  FOREIGN KEY (character_id) REFERENCES ai_characters(id),
  FOREIGN KEY (source_conversation_id) REFERENCES ai_conversations(id) ON DELETE SET NULL
);

CREATE INDEX idx_ai_memories_namespace
ON ai_memories(identity_id, character_id, active, importance DESC, updated_at DESC);

CREATE TABLE ai_usage_events (
  request_id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  conversation_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  audio_input_tokens INTEGER NOT NULL DEFAULT 0,
  audio_output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_micros_jpy INTEGER NOT NULL DEFAULT 0,
  usage_period TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (identity_id) REFERENCES ai_accounts(identity_id) ON DELETE CASCADE,
  FOREIGN KEY (character_id) REFERENCES ai_characters(id),
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE SET NULL
);

CREATE INDEX idx_ai_usage_owner_period
ON ai_usage_events(identity_id, usage_period, occurred_at DESC);

CREATE TABLE ai_budget_guards (
  identity_id TEXT PRIMARY KEY,
  usage_period TEXT NOT NULL,
  spent_micros_jpy INTEGER NOT NULL DEFAULT 0,
  reserved_micros_jpy INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_id) REFERENCES ai_accounts(identity_id) ON DELETE CASCADE
);

CREATE TABLE ai_request_claims (
  client_request_id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  model TEXT NOT NULL,
  reserved_micros_jpy INTEGER NOT NULL DEFAULT 0,
  user_message_id TEXT,
  assistant_message_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_id) REFERENCES ai_accounts(identity_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (character_id) REFERENCES ai_characters(id)
);
