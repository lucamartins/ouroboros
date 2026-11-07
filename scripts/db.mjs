// SQLite storage (node:sqlite, Node >= 22.13). One file per plugin install, shared
// by concurrent sessions: WAL mode + busy timeout.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDir } from './paths.mjs';

const MIGRATIONS = [
  // 1 — phase 1: capture + measurement
  `
  CREATE TABLE sessions (
    id                    TEXT PRIMARY KEY,
    project               TEXT,
    cwd                   TEXT,
    transcript_path       TEXT,
    started_at            INTEGER,
    ended_at              INTEGER,
    end_reason            TEXT,
    turns                 INTEGER NOT NULL DEFAULT 0,
    tool_calls            INTEGER NOT NULL DEFAULT 0,
    tool_fails            INTEGER NOT NULL DEFAULT 0,
    turn_tool_calls       INTEGER NOT NULL DEFAULT 0,
    turns_at_last_review  INTEGER NOT NULL DEFAULT 0,
    review_cursor         INTEGER NOT NULL DEFAULT 0,
    queue_state           TEXT,              -- NULL | queued | running | done | skipped | failed
    reviewed_at           INTEGER,
    last_event_at         INTEGER
  );
  CREATE INDEX sessions_started ON sessions(started_at);
  CREATE INDEX sessions_queue ON sessions(queue_state);

  CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    agent_id    TEXT,
    ts          INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    target      TEXT,
    payload     TEXT
  );
  CREATE INDEX events_session ON events(session_id, kind);
  CREATE INDEX events_kind_ts ON events(kind, ts);

  -- Consecutive failures on the same target, closed into a 'recovery' event on success.
  CREATE TABLE fail_streaks (
    session_id  TEXT NOT NULL,
    target      TEXT NOT NULL,
    agent_id    TEXT,
    count       INTEGER NOT NULL,
    first_error TEXT,
    started_at  INTEGER NOT NULL,
    PRIMARY KEY (session_id, target)
  );

  CREATE TABLE reviews (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id         TEXT NOT NULL,
    mode               TEXT NOT NULL,        -- measure | inloop | background | manual
    trigger            TEXT,                 -- session_end | backfill | periodic | long_turn | manual
    model              TEXT,
    status             TEXT NOT NULL,        -- ok | skipped | failed
    detail             TEXT,
    turns_reviewed     INTEGER NOT NULL DEFAULT 0,
    corrections        INTEGER NOT NULL DEFAULT 0,
    learned            INTEGER NOT NULL DEFAULT 0,
    patched            INTEGER NOT NULL DEFAULT 0,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd           REAL NOT NULL DEFAULT 0,
    duration_ms        INTEGER,
    session_started_at INTEGER,
    ts                 INTEGER NOT NULL
  );
  CREATE INDEX reviews_ts ON reviews(ts);
  CREATE INDEX reviews_session ON reviews(session_id);

  CREATE TABLE corrections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id   INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    quote       TEXT,
    kind        TEXT,                        -- explicit | implicit
    ts          INTEGER NOT NULL
  );

  -- What a review would have learned (phase 1) or proposed (later phases).
  CREATE TABLE candidates (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id    INTEGER NOT NULL,
    session_id   TEXT NOT NULL,
    project      TEXT,
    kind         TEXT NOT NULL,              -- memory | skill
    scope        TEXT,                       -- global | project
    memory_type  TEXT,                       -- user | feedback | project | reference
    title        TEXT NOT NULL,
    summary      TEXT,
    evidence     TEXT,
    confidence   REAL,
    repeats      TEXT,                       -- existing memory/skill the user had to repeat (miss)
    ts           INTEGER NOT NULL
  );
  CREATE INDEX candidates_ts ON candidates(ts);

  CREATE TABLE errors (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    source   TEXT NOT NULL,
    message  TEXT
  );
  `,
];

export function openDb(explicitDir) {
  const dir = dataDir(explicitDir);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'events.db'));
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current >= MIGRATIONS.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-read inside the write lock: another process may have migrated meanwhile.
    const version = db.prepare('PRAGMA user_version').get().user_version;
    for (let v = version; v < MIGRATIONS.length; v++) db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function logError(db, source, err) {
  try {
    const message = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err);
    db.prepare('INSERT INTO errors (ts, source, message) VALUES (?, ?, ?)').run(Date.now(), source, message.slice(0, 4000));
  } catch {
    // Never let error logging break a hook.
  }
}

/** Start of the current calendar month (local time), epoch ms. */
export function monthStart(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

export function monthSpend(db, now = new Date()) {
  return db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM reviews WHERE ts >= ?').get(monthStart(now)).total;
}
