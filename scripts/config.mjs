// Plugin options. Claude Code exports userConfig values to hook processes as
// CLAUDE_PLUGIN_OPTION_<KEY>; the review worker inherits them from the hook.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.mjs';

const DEFAULTS = {
  measure_review: true,
  reviewer_model: 'haiku',
  monthly_budget_usd: 5,
  long_turn_tool_calls: 15,
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

export function options() {
  const fromEnv = Object.keys(process.env).some((k) => k.startsWith('CLAUDE_PLUGIN_OPTION_'));
  const snap = fromEnv ? null : snapshot();
  if (snap) {
    const { updatedAt, ...rest } = snap;
    return rest;
  }
  return {
    measureReview: asBool(raw('measure_review'), DEFAULTS.measure_review),
    reviewerModel: raw('reviewer_model') || DEFAULTS.reviewer_model,
    monthlyBudgetUsd: asNumber(raw('monthly_budget_usd'), DEFAULTS.monthly_budget_usd),
    longTurnToolCalls: asNumber(raw('long_turn_tool_calls'), DEFAULTS.long_turn_tool_calls),
  };
}
