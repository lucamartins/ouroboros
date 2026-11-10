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
    queue_state           TEXT,              -- NULL | queued | running | done | skipped | failed | waiting (v0.23: to finish later)
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
    trigger            TEXT,                 -- session_end | backfill | periodic | recovery (long_turn before v0.8.1) | manual
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
  // 2 — phase 2: learnings written by the curator, with a ledger for undo
  `
  CREATE TABLE learnings (
    id             TEXT PRIMARY KEY,          -- lrn_<time><rand>
    kind           TEXT NOT NULL,             -- memory | skill | instructions | rules (profile: retired in v0.12)
    scope          TEXT NOT NULL,             -- global | project
    memory_type    TEXT,
    block          TEXT,                      -- retired profile block: user | environment
    project        TEXT,
    name           TEXT NOT NULL,
    title          TEXT NOT NULL,
    path           TEXT NOT NULL,
    confidence     REAL,
    status         TEXT NOT NULL,             -- active | archived | reverted | removed (v0.23: file deleted outside Ouroboros)
    trigger        TEXT,
    origin_session TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    uses           INTEGER NOT NULL DEFAULT 0,
    last_used_at   INTEGER
  );
  CREATE INDEX learnings_path ON learnings(path);
  CREATE INDEX learnings_status ON learnings(status);

  -- One row per file touched; a batch groups the files of one operation.
  CREATE TABLE writes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    batch        TEXT NOT NULL,
    learning_id  TEXT,
    ts           INTEGER NOT NULL,
    op           TEXT NOT NULL,               -- create | patch | archive | revert
    actor        TEXT NOT NULL,               -- manual | inloop | background
    session_id   TEXT,
    file         TEXT NOT NULL,
    before       TEXT,                        -- NULL: file did not exist
    after        TEXT,                        -- NULL: file removed
    reverted_at  INTEGER
  );
  CREATE INDEX writes_batch ON writes(batch);
  CREATE INDEX writes_learning ON writes(learning_id);

  CREATE TABLE meta (
    key    TEXT PRIMARY KEY,
    value  TEXT
  );
  `,
  // 3 — phase 3: periodic in-loop reviews, background learning, notices
  `
  ALTER TABLE sessions ADD COLUMN review_requested_at INTEGER;
  ALTER TABLE sessions ADD COLUMN review_requested_line INTEGER;
  ALTER TABLE sessions ADD COLUMN review_trigger TEXT;
  ALTER TABLE candidates ADD COLUMN outcome TEXT;      -- created | duplicate | rejected | over_budget | error (NULL: measure only)
  ALTER TABLE candidates ADD COLUMN learning_id TEXT;
  CREATE TABLE notices (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    session_id    TEXT,
    text          TEXT NOT NULL,
    delivered_at  INTEGER
  );
  `,
  // 4 — phase 4: approval queue, maintenance runs
  `
  ALTER TABLE candidates ADD COLUMN payload TEXT;      -- the proposal as JSON, for queued items
  ALTER TABLE candidates ADD COLUMN cwd TEXT;
  ALTER TABLE candidates ADD COLUMN decided_at INTEGER;
  CREATE INDEX candidates_outcome ON candidates(outcome);
  CREATE TABLE maintenance (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    kind      TEXT NOT NULL,                       -- decay | consolidate:<area>
    detail    TEXT,
    archived  INTEGER NOT NULL DEFAULT 0,
    merged    INTEGER NOT NULL DEFAULT 0,
    cost_usd  REAL NOT NULL DEFAULT 0
  );
  `,
  // 5 — triage against existing knowledge
  `
  ALTER TABLE candidates ADD COLUMN note TEXT;
  ALTER TABLE candidates ADD COLUMN triaged_at INTEGER;
  `,
  // 6 — v0.7: changes are composed per file (changesets) and grounded in the project
  `
  CREATE TABLE changesets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    file        TEXT NOT NULL,                     -- the one knowledge file it changes
    kind        TEXT NOT NULL,                     -- memory | skill | rules | instructions
    cwd         TEXT,
    project     TEXT,
    base_hash   TEXT NOT NULL,                     -- the file's content it was composed against
    edits       TEXT NOT NULL,                     -- JSON [{ old, new | append, section, claims, why, corrects }]
    corrects    INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL,                     -- pending | applied | rejected | superseded | stale
    note        TEXT,
    cost_usd    REAL NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    decided_at  INTEGER,
    learning_id TEXT
  );
  CREATE INDEX changesets_status ON changesets(status);
  ALTER TABLE candidates ADD COLUMN changeset_id INTEGER;
  ALTER TABLE candidates ADD COLUMN claim TEXT;      -- what the learning says, as one statement for the editor
  ALTER TABLE candidates ADD COLUMN target TEXT;     -- the knowledge file that owns it
  CREATE INDEX candidates_changeset ON candidates(changeset_id);
  `,
  // 7 — v0.8: undo per change, notices per project
  `
  ALTER TABLE changesets ADD COLUMN batch TEXT;       -- the ledger batch that applied it (undo)
  ALTER TABLE notices ADD COLUMN project TEXT;        -- NULL: for any project (maintenance)
  `,
  // 8 — v0.8.2: each write says what it learned and why; learnings the user keeps
  `
  ALTER TABLE writes ADD COLUMN title TEXT;           -- what this write learned (one line)
  ALTER TABLE writes ADD COLUMN why TEXT;             -- where it came from (evidence, the learnings of a change)
  ALTER TABLE learnings ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;  -- kept by the user: never archived automatically
  `,
  // 9 — v0.9.1: the user's own words behind a learning (the turns its evidence cites)
  `
  ALTER TABLE candidates ADD COLUMN quotes TEXT;      -- JSON [{ n, text }]; resolved from the transcript
  `,
  // 10 — v0.15: what a review noticed but could not settle, carried to the session's next review
  `
  CREATE TABLE observations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    text        TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    closed_at   INTEGER                            -- settled by a later review, or the session's last review ran
  );
  CREATE INDEX observations_session ON observations(session_id, closed_at);
  `,
  // 11 — v0.17: one instrument for the correction rate
  `
  ALTER TABLE reviews ADD COLUMN instrument TEXT;            -- 'corrections': counts toward the correction rate
  ALTER TABLE sessions ADD COLUMN measure_cursor INTEGER NOT NULL DEFAULT 0;   -- transcript line the instrument has measured up to
  -- Measure-mode reviews (learning off, measure backfills) read whole sessions with the
  -- instrument's definition of a correction: they are the baseline.
  UPDATE reviews SET instrument = 'corrections' WHERE mode = 'measure' AND status = 'ok';
  UPDATE sessions SET measure_cursor = review_cursor WHERE id IN (SELECT session_id FROM reviews WHERE mode = 'measure' AND status = 'ok');
  `,
  // 12 — v0.19: a learning the user had to repeat (saved, yet it did not work)
  `
  ALTER TABLE learnings ADD COLUMN misses INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE learnings ADD COLUMN last_missed_at INTEGER;
  ALTER TABLE learnings ADD COLUMN miss_flagged_at INTEGER;   -- a suggestion to reword it was sent to the inbox
  `,
  // 13 — v0.23: what happened between the failures and the success of a command
  // (learnings.status also takes 'removed': the file was deleted outside Ouroboros;
  //  sessions.queue_state also takes 'waiting': a review to finish later)
  `
  ALTER TABLE fail_streaks ADD COLUMN first_command TEXT;                -- the command text of the first failure
  ALTER TABLE fail_streaks ADD COLUMN edits INTEGER NOT NULL DEFAULT 0;   -- files written meanwhile (the code was being fixed)
  ALTER TABLE fail_streaks ADD COLUMN others INTEGER NOT NULL DEFAULT 0;  -- other commands run meanwhile
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

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

export function setMetaOnce(db, key, value) {
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}

/**
 * A named lease held by one process at a time (stored in `meta`): the learning
 * evaluation runs as a single consumer so two processes never compose changes to the
 * same file at once. Returns a token to release with, or null when someone else holds
 * it. An expired lease (a crashed holder) can be taken over.
 */
export function acquireLease(db, name, ttlMs = 30 * 60 * 1000) {
  const now = Date.now();
  const token = `${now + ttlMs}|${process.pid}|${Math.random().toString(36).slice(2, 10)}`;
  const r = db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(meta.value AS INTEGER) < ?`).run(`lease:${name}`, token, now);
  return r.changes ? token : null;
}

/**
 * Push a held lease's expiry forward; returns the new token, or null when the lease is
 * no longer ours (it expired and someone took it). A long evaluation renews before each
 * model call, so its lease never runs out while it is alive.
 */
export function renewLease(db, name, token, ttlMs = 30 * 60 * 1000) {
  if (!token) return null;
  const next = `${Date.now() + ttlMs}|${token.split('|').slice(1).join('|')}`;
  const r = db.prepare('UPDATE meta SET value = ? WHERE key = ? AND value = ?').run(next, `lease:${name}`, token);
  return r.changes ? next : null;
}

export function releaseLease(db, name, token) {
  if (token) db.prepare('DELETE FROM meta WHERE key = ? AND value = ?').run(`lease:${name}`, token);
}

/** Start of the current calendar month (local time), epoch ms. */
export function monthStart(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

export function monthSpend(db, now = new Date()) {
  return db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM reviews WHERE ts >= ?').get(monthStart(now)).total;
}

export class BudgetError extends Error {
  constructor(spent, budget) {
    super(`monthly budget reached (US$ ${spent.toFixed(2)} of ${budget})`);
    this.name = 'BudgetError';
  }
}

/** Throw BudgetError when the month's model spend reached the budget; called before every model call. */
export function assertBudget(db, budgetUsd) {
  const spent = monthSpend(db);
  if (budgetUsd <= 0 || spent >= budgetUsd) throw new BudgetError(spent, budgetUsd);
}
