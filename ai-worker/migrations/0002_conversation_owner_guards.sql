PRAGMA foreign_keys = ON;

-- Composite ownership triggers supplement the individual foreign keys. They
-- prevent any future code path from attaching another Identity/character's
-- message, memory, usage, or idempotency claim to a conversation.
CREATE TRIGGER ai_messages_owner_insert
BEFORE INSERT ON ai_messages
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM ai_conversations c
  WHERE c.id = NEW.conversation_id AND c.identity_id = NEW.identity_id AND c.character_id = NEW.character_id
)
BEGIN
  SELECT RAISE(ABORT, 'conversation ownership mismatch');
END;

CREATE TRIGGER ai_messages_owner_update
BEFORE UPDATE OF conversation_id, identity_id, character_id ON ai_messages
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM ai_conversations c
  WHERE c.id = NEW.conversation_id AND c.identity_id = NEW.identity_id AND c.character_id = NEW.character_id
)
BEGIN
  SELECT RAISE(ABORT, 'conversation ownership mismatch');
END;

CREATE TRIGGER ai_memories_owner_insert
BEFORE INSERT ON ai_memories
FOR EACH ROW WHEN NEW.source_conversation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ai_conversations c
  WHERE c.id = NEW.source_conversation_id AND c.identity_id = NEW.identity_id AND c.character_id = NEW.character_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory ownership mismatch');
END;

CREATE TRIGGER ai_usage_owner_insert
BEFORE INSERT ON ai_usage_events
FOR EACH ROW WHEN NEW.conversation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ai_conversations c
  WHERE c.id = NEW.conversation_id AND c.identity_id = NEW.identity_id AND c.character_id = NEW.character_id
)
BEGIN
  SELECT RAISE(ABORT, 'usage ownership mismatch');
END;

CREATE TRIGGER ai_claims_owner_insert
BEFORE INSERT ON ai_request_claims
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM ai_conversations c
  WHERE c.id = NEW.conversation_id AND c.identity_id = NEW.identity_id AND c.character_id = NEW.character_id
)
BEGIN
  SELECT RAISE(ABORT, 'request ownership mismatch');
END;
