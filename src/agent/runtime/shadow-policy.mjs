/** Explicit policy boundary for scheduled SHADOW runs. This module only decides; it never executes actions. */
export const SHADOW_MODE = 'SHADOW_SCHEDULED';
export const MANUAL_MODE = 'MANUAL';

export const OPERATION_CLASSES = Object.freeze({
  READ_ONLY: 'READ_ONLY',
  LOCAL_DURABLE_WRITE: 'LOCAL_DURABLE_WRITE',
  EXTERNAL_REVERSIBLE: 'EXTERNAL_REVERSIBLE',
  EXTERNAL_MUTATION: 'EXTERNAL_MUTATION',
  IRREVERSIBLE: 'IRREVERSIBLE'
});

const ALLOWED_SHADOW_OPERATIONS = new Set([
  OPERATION_CLASSES.READ_ONLY,
  OPERATION_CLASSES.LOCAL_DURABLE_WRITE
]);
const KNOWN_OPERATIONS = new Set(Object.values(OPERATION_CLASSES));
const EXPLICITLY_DENIED_ACTIONS = new Set([
  'FILL_APPLICATION', 'SUBMIT_APPLICATION', 'APPLY', 'SEND',
  'CONFIRM_MANUAL_SUBMISSION', 'CONTACT_RECRUITER', 'ACCEPT_CALENDAR_INVITE'
]);

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
  return value.trim();
}

/** Return an authorization decision/receipt; callers must not treat it as an execution request. */
export function decideOperation({ mode, operation, action, reason, runId, applicationId = null, now = new Date() } = {}) {
  if (mode !== SHADOW_MODE && mode !== MANUAL_MODE) throw new Error(`Unknown execution mode: ${String(mode)}`);
  if (typeof operation !== 'string' || !KNOWN_OPERATIONS.has(operation)) throw new Error(`Unknown operation class: ${String(operation)}`);
  const normalizedAction = requiredText(action, 'action');
  const normalizedReason = requiredText(reason, 'reason');
  const normalizedRunId = requiredText(runId, 'runId');
  if (applicationId !== null && (typeof applicationId !== 'string' || !applicationId.trim())) {
    throw new TypeError('applicationId must be null or a non-empty string.');
  }
  const createdAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

  // MANUAL is deliberately not interpreted here: callers continue through the existing
  // manually authorized path, with that path's own checks and confirmation requirements.
  if (mode === MANUAL_MODE) return Object.freeze({ decision: 'MANUAL_PATH', allowed: false });

  const explicitlyDenied = EXPLICITLY_DENIED_ACTIONS.has(normalizedAction.toUpperCase());
  const allowed = ALLOWED_SHADOW_OPERATIONS.has(operation) && !explicitlyDenied;
  const humanBoundary = operation !== OPERATION_CLASSES.READ_ONLY || explicitlyDenied;
  return Object.freeze({
    decision: allowed ? 'ALLOWED_IN_SHADOW' : 'BLOCKED_BY_SHADOW_MODE',
    allowed,
    receipt: Object.freeze({
      run_id: normalizedRunId,
      application_id: applicationId?.trim() ?? null,
      action: normalizedAction,
      reason: normalizedReason,
      required_human_review: humanBoundary,
      blocked_by_shadow_mode: !allowed,
      created_at: createdAt
    })
  });
}
