CREATE TABLE calendar_accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO calendar_accounts(id,display_name) VALUES ('main','カレンダー1'),('second','カレンダー2');

CREATE TABLE calendar_clock (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL DEFAULT 0);
INSERT INTO calendar_clock(id,value) VALUES (1,0);
CREATE TABLE calendar_entities (
  account_id TEXT NOT NULL REFERENCES calendar_accounts(id),
  owner_identity TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK(kind IN ('event','track','tag','settings')),
  id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=1048576),
  version INTEGER NOT NULL CHECK(version>=1),
  purged INTEGER NOT NULL DEFAULT 0 CHECK(purged IN (0,1)),
  updated_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(account_id,owner_identity,kind,id),
  CHECK((kind='settings' AND owner_identity!='') OR (kind!='settings' AND owner_identity=''))
);
CREATE INDEX calendar_entities_sync ON calendar_entities(account_id,updated_seq);
CREATE UNIQUE INDEX calendar_named_unique ON calendar_entities(account_id,kind,json_extract(payload,'$.name'))
  WHERE kind IN ('track','tag') AND purged=0 AND COALESCE(json_extract(payload,'$.mergedInto'),'')='';
CREATE TRIGGER calendar_update_version BEFORE UPDATE OF payload,version,purged ON calendar_entities
WHEN NEW.version!=OLD.version+1
BEGIN SELECT RAISE(ABORT,'calendar_conflict'); END;
CREATE TRIGGER calendar_insert_sequence AFTER INSERT ON calendar_entities
WHEN NEW.updated_seq=0
BEGIN
  UPDATE calendar_clock SET value=value+1 WHERE id=1;
  UPDATE calendar_entities SET updated_seq=(SELECT value FROM calendar_clock WHERE id=1) WHERE account_id=NEW.account_id AND owner_identity=NEW.owner_identity AND kind=NEW.kind AND id=NEW.id;
END;
CREATE TRIGGER calendar_update_sequence AFTER UPDATE OF payload,version,purged ON calendar_entities
BEGIN
  UPDATE calendar_clock SET value=value+1 WHERE id=1;
  UPDATE calendar_entities SET updated_seq=(SELECT value FROM calendar_clock WHERE id=1) WHERE account_id=NEW.account_id AND owner_identity=NEW.owner_identity AND kind=NEW.kind AND id=NEW.id;
END;
CREATE TABLE calendar_requests (
  account_id TEXT NOT NULL REFERENCES calendar_accounts(id),
  owner_identity TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(account_id,owner_identity,request_id)
);
CREATE INDEX calendar_requests_expiry ON calendar_requests(created_at);
