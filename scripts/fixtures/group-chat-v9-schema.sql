CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE groups(id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX groups_page ON groups(status, updated_at DESC, id);
CREATE TABLE members(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), position INTEGER NOT NULL,
  state TEXT NOT NULL, handle TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(group_id, position), UNIQUE(group_id, handle));
CREATE TABLE messages(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), seq INTEGER NOT NULL,
  origin_key TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(group_id, seq), UNIQUE(group_id, origin_key));
CREATE TABLE discussions(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), status TEXT NOT NULL,
  created_at INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX discussions_group ON discussions(group_id, created_at DESC, id);
CREATE TABLE opportunities(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
  discussion_id TEXT NOT NULL REFERENCES discussions(id), member_id TEXT NOT NULL REFERENCES members(id),
  state TEXT NOT NULL, ordinal INTEGER NOT NULL, run_id TEXT UNIQUE, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX opportunities_queue ON opportunities(group_id, state, ordinal);
CREATE INDEX opportunities_discussion ON opportunities(discussion_id, state, ordinal);
CREATE TABLE invitations(cause_message_id TEXT NOT NULL REFERENCES messages(id), member_id TEXT NOT NULL,
  kind TEXT NOT NULL, discussion_id TEXT NOT NULL, state TEXT NOT NULL, opportunity_id TEXT,
  data TEXT CHECK(data IS NULL OR json_valid(data)),
  PRIMARY KEY(cause_message_id, member_id, kind));
CREATE TABLE session_bindings(group_id TEXT NOT NULL REFERENCES groups(id), member_id TEXT NOT NULL REFERENCES members(id),
  thread_id TEXT NOT NULL, purpose TEXT NOT NULL, profile_id TEXT NOT NULL, session_key TEXT UNIQUE,
  watermark INTEGER NOT NULL, external TEXT CHECK(external IS NULL OR json_valid(external)),
  delivery_scan_seq INTEGER NOT NULL DEFAULT 0, coverage_start_seq INTEGER NOT NULL DEFAULT 0,
  coverage_unknown_before INTEGER,
  PRIMARY KEY(group_id, member_id, thread_id, purpose));
CREATE TABLE operations(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, fingerprint TEXT NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result)));
CREATE TABLE member_cards(member_id TEXT PRIMARY KEY REFERENCES members(id),
  group_id TEXT NOT NULL REFERENCES groups(id), data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX member_cards_group ON member_cards(group_id);
CREATE TABLE tasks(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
  status TEXT NOT NULL, target_member_id TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX tasks_group ON tasks(group_id, created_at);
CREATE INDEX tasks_status ON tasks(status, created_at);
CREATE TABLE message_results(message_id TEXT PRIMARY KEY REFERENCES messages(id),
  body TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL);
CREATE TABLE role_snapshots(id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id),
  group_id TEXT NOT NULL REFERENCES groups(id), created_at INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), body TEXT NOT NULL);
CREATE INDEX role_snapshots_member ON role_snapshots(group_id,member_id,created_at);
CREATE TABLE role_summaries(id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE message_deliveries(group_id TEXT NOT NULL, member_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id), seq INTEGER NOT NULL, complete INTEGER NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(group_id,member_id,message_id));
CREATE INDEX message_deliveries_coverage ON message_deliveries(group_id,member_id,seq,complete);

CREATE TABLE collaboration_items(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
  discussion_id TEXT NOT NULL REFERENCES discussions(id), scope_key TEXT NOT NULL, state TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(discussion_id,scope_key));
CREATE INDEX collaboration_items_request ON collaboration_items(discussion_id,state);
CREATE TABLE collaboration_actions(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
  discussion_id TEXT NOT NULL REFERENCES discussions(id), origin_key TEXT NOT NULL, opportunity_id TEXT,
  state TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(group_id,origin_key));
CREATE INDEX collaboration_actions_turn ON collaboration_actions(opportunity_id,state);
CREATE TABLE collaboration_wakeups(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
  discussion_id TEXT NOT NULL REFERENCES discussions(id), member_id TEXT NOT NULL, state TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX collaboration_wakeups_pending ON collaboration_wakeups(group_id,state);

PRAGMA user_version=9;
