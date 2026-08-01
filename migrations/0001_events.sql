PRAGMA foreign_keys = ON;

CREATE TABLE gatherings (
  id TEXT PRIMARY KEY CHECK(length(id) = 32),
  organizer_token_hash TEXT NOT NULL CHECK(length(organizer_token_hash) = 64),
  creator_session_id TEXT NOT NULL CHECK(length(creator_session_id) = 36),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
  venue TEXT NOT NULL CHECK(length(venue) BETWEEN 1 AND 100),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 600),
  notice TEXT NOT NULL DEFAULT '' CHECK(length(notice) <= 300),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  capacity INTEGER NOT NULL CHECK(capacity BETWEEN 2 AND 100),
  show_names INTEGER NOT NULL DEFAULT 1 CHECK(show_names IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open', 'closed', 'cancelled', 'hidden')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX gatherings_expiry_idx ON gatherings(expires_at);
CREATE INDEX gatherings_creator_idx ON gatherings(creator_session_id, created_at);

CREATE TABLE responses (
  id TEXT PRIMARY KEY CHECK(length(id) = 32),
  gathering_id TEXT NOT NULL REFERENCES gatherings(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  token_hash TEXT NOT NULL CHECK(length(token_hash) = 64),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 32),
  display_name_key TEXT NOT NULL CHECK(length(display_name_key) BETWEEN 1 AND 64),
  party_size INTEGER NOT NULL CHECK(party_size BETWEEN 1 AND 4),
  choice TEXT NOT NULL CHECK(choice IN ('attending', 'interested', 'declined', 'waitlisted')),
  note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 120),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(gathering_id, session_id),
  UNIQUE(gathering_id, display_name_key)
);

CREATE INDEX responses_gathering_idx ON responses(gathering_id, choice, created_at);

CREATE TABLE content_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gathering_id TEXT NOT NULL REFERENCES gatherings(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  reason TEXT NOT NULL CHECK(reason IN ('spam', 'unsafe', 'other')),
  created_at INTEGER NOT NULL,
  UNIQUE(gathering_id, session_id)
);

CREATE TABLE product_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK(name IN ('visited', 'gathering_created', 'response_added', 'response_updated', 'waitlist_joined', 'waitlist_promoted', 'roster_exported', 'calendar_saved', 'public_gathering_viewed', 'returned')),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  gathering_id TEXT NOT NULL DEFAULT '' CHECK(length(gathering_id) IN (0, 32)),
  day TEXT NOT NULL CHECK(length(day) = 10),
  created_at INTEGER NOT NULL,
  is_qa INTEGER NOT NULL DEFAULT 0 CHECK(is_qa IN (0, 1))
);

CREATE INDEX product_events_day_idx ON product_events(day, name, is_qa);
