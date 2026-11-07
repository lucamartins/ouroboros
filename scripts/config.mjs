// Plugin options. Claude Code exports userConfig values to hook processes as
// CLAUDE_PLUGIN_OPTION_<KEY>; the review worker inherits them from the hook.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.mjs';

const DEFAULTS = {
  learning: true,
  autonomy: 'auto',
  learning_language: 'en',
  inloop_review: true,
  review_every_turns: 10,
  long_turn_tool_calls: 15,
  background_review: true,
  reviewer_model: 'haiku',
  monthly_budget_usd: 5,
};

function raw(key) {
  return process.env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`];
}

function asBool(v, fallback) {
  if (v === undefined || v === '') return fallback;
  return !/^(false|0|no|off)$/i.test(String(v).trim());
}

function asNumber(v, fallback) {
  const n = Number(v);
  return v === undefined || v === '' || !Number.isFinite(n) ? fallback : n;
}

/** Snapshot written by the SessionStart hook, for tools started outside hooks (backfill). */
function snapshot() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), 'options.json'), 'utf8'));
  } catch {
    return null;
  }
}

function fromEnv() {
  return {
    learning: asBool(raw('learning'), DEFAULTS.learning),
    autonomy: ['auto', 'hybrid', 'queue'].includes(raw('autonomy')) ? raw('autonomy') : DEFAULTS.autonomy,
    learningLanguage: ['en', 'pt-BR', 'auto'].includes(raw('learning_language')) ? raw('learning_language') : DEFAULTS.learning_language,
    inloopReview: asBool(raw('inloop_review'), DEFAULTS.inloop_review),
    reviewEveryTurns: Math.max(1, asNumber(raw('review_every_turns'), DEFAULTS.review_every_turns)),
    longTurnToolCalls: Math.max(1, asNumber(raw('long_turn_tool_calls'), DEFAULTS.long_turn_tool_calls)),
    // `measure_review` was the phase 1 name of this option.
    backgroundReview: asBool(raw('background_review') ?? raw('measure_review'), DEFAULTS.background_review),
    reviewerModel: raw('reviewer_model') || DEFAULTS.reviewer_model,
    monthlyBudgetUsd: asNumber(raw('monthly_budget_usd'), DEFAULTS.monthly_budget_usd),
  };
}

export function options() {
  const hasEnv = Object.keys(process.env).some((k) => k.startsWith('CLAUDE_PLUGIN_OPTION_'));
  const base = fromEnv();
  if (hasEnv) return base;
  const snap = snapshot();
  if (!snap) return base;
  const { updatedAt, measureReview, ...rest } = snap;
  return { ...base, ...(measureReview !== undefined && rest.backgroundReview === undefined ? { backgroundReview: measureReview } : {}), ...rest };
}
