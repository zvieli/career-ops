// @ts-check
/** Executes only exact inventory-approved zero-cost models via installed runtimes. */
import { spawn } from 'node:child_process';
import { isZeroCostModel } from '../zero-cost-router.mjs';

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const EXPLICIT_RUNTIME_FAILURES = Object.freeze(['RATE_LIMITED', 'QUOTA_EXHAUSTED', 'AUTH_FAILURE', 'TIMEOUT']);
export function isExplicitRuntimeFailure(code) { return EXPLICIT_RUNTIME_FAILURES.includes(code); }

function classifyExecutionError(error) {
  const safeText = `${error?.message || ''} ${error?.stderr || ''}`.toLowerCase();
  if (/rate.?limit|too many requests|http_429/.test(safeText)) return 'RATE_LIMITED';
  if (/quota exhausted|quota exceeded|out of quota|limit reached/.test(safeText)) return 'QUOTA_EXHAUSTED';
  if (/unauthori[sz]ed|authentication|credential|oauth/.test(safeText)) return 'AUTH_FAILURE';
  if (/timed? ?out|timeout|aborted/.test(safeText) || error?.killed) return 'TIMEOUT';
  if (/enoent|not found/.test(safeText)) return 'CLI_UNAVAILABLE';
  return error?.code && typeof error.code === 'string' ? error.code : 'PROVIDER_EXECUTION_FAILED';
}

/** Spawn a CLI without a shell; kill its process group on timeout or output overflow. */
export function runCommandBounded(command, args, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let killTimer;
    const timeout = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 500);
    }, timeoutMs);
    timeout.unref?.();

    function killGroup(signal) {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        killGroup('SIGTERM');
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (Buffer.byteLength(stderr) < 64 * 1024) stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      error.code = classifyExecutionError(error);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (timedOut) {
        const error = new Error('Provider process exceeded its hard timeout');
        error.code = 'TIMEOUT';
        reject(error);
      } else if (outputExceeded) {
        const error = new Error('Provider process exceeded output limit');
        error.code = 'OUTPUT_LIMIT';
        reject(error);
      } else if (code !== 0) {
        const error = new Error('Provider CLI exited unsuccessfully');
        error.code = classifyExecutionError({ message: stderr, code, signal });
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function executeInstalledModel({ modelId, systemPrompt, userMessage, timeoutMs }) {
  const provider = modelId.split('/')[0];
  const prompt = `${systemPrompt}\n\n${userMessage}`;

  if (provider === 'ollama') {
    const response = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelId.slice('ollama/'.length),
        prompt,
        format: 'json',
        stream: false,
        options: { temperature: 0.1 }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP_${response.status}`);
    const payload = await response.json();
    if (typeof payload.response !== 'string' || !payload.response.trim()) throw new Error('Ollama returned no content');
    return payload.response;
  }

  let command;
  let args;
  if (provider === 'opencode') {
    command = 'opencode';
    args = ['run', '--model', modelId, prompt];
  } else if (['antigravity', 'openai-codex', 'kilo'].includes(provider)) {
    command = 'pi';
    args = [
      '--model', modelId,
      '--mode', 'text',
      '--no-session',
      '--no-tools',
      '--no-mcp',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--system-prompt', systemPrompt,
      '-p', userMessage
    ];
  } else {
    throw new Error(`No installed execution adapter for provider ${provider}`);
  }

  const { stdout } = await runCommandBounded(command, args, timeoutMs, {
    env: { ...process.env, PI_OFFLINE: '' }
  });
  if (!stdout.trim()) throw new Error(`${provider} returned no content`);
  return stdout.trim();
}

/**
 * Create a model runner constrained to the verified inventory.
 * @param {{ timeoutMs?: number, retries?: number, execute?: Function, onModelAttempt?: (attempt: {modelId: string, provider: string, tier?: number, attempt: number}) => void }} [options]
 */
export function createZeroCostProviderRunner(options = {}) {
  const timeoutMs = Math.min(120_000, Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const retries = Math.min(2, Math.max(0, options.retries ?? 1));
  const execute = options.execute ?? executeInstalledModel;

  return async ({ modelId, tier, systemPrompt, userMessage }) => {
    if (!isZeroCostModel(modelId)) {
      throw new Error(`Refusing model not verified zero-cost: ${modelId}`);
    }
    const provider = modelId.split('/')[0];
    let lastErrorCode = 'PROVIDER_EXECUTION_FAILED';
    for (let attempt = 0; attempt <= retries; attempt++) {
      const attemptNumber = attempt + 1;
      options.onModelAttempt?.({ modelId, provider, tier, attempt: attemptNumber });
      const started = performance.now();
      let content;
      try {
        content = await execute({ modelId, systemPrompt, userMessage, timeoutMs });
      } catch (error) {
        lastErrorCode = error?.code || classifyExecutionError(error);
        options.onModelFailure?.({ modelId, provider, tier, attempt: attemptNumber, error_code: lastErrorCode });
        if (!isExplicitRuntimeFailure(lastErrorCode) || attempt === retries) {
          const failure = new Error(`${provider}/${modelId} failed after ${attemptNumber} attempt(s) (${lastErrorCode})`, { cause: error });
          failure.code = lastErrorCode;
          failure.provider = provider;
          failure.modelId = modelId;
          failure.attempts = attemptNumber;
          throw failure;
        }
        continue;
      }
      if (typeof content !== 'string' || !content.trim()) {
        const failure = new Error(`${provider}/${modelId} returned empty content`);
        failure.code = 'INVALID_MODEL_OUTPUT';
        failure.provider = provider;
        failure.modelId = modelId;
        failure.attempts = attemptNumber;
        options.onModelFailure?.({ modelId, provider, tier, attempt: attemptNumber, error_code: failure.code });
        throw failure;
      }
      const latency_ms = Math.round(performance.now() - started);
      const call = { modelId, provider, tier, attempt: attemptNumber, status: 'SUCCESS', latency_ms, exact_inventory_match: true, incremental_cost: 0 };
      options.onModelResult?.(call);
      return {
        content,
        provider,
        model: modelId,
        model_version: null,
        latency_ms,
        attempts: attemptNumber,
        exact_inventory_match: true,
        incremental_cost: 0
      };
    }
    const failure = new Error(`${provider}/${modelId} exhausted ${retries + 1} bounded attempt(s) (${lastErrorCode})`);
    failure.code = lastErrorCode;
    failure.provider = provider;
    failure.modelId = modelId;
    failure.attempts = retries + 1;
    throw failure;
  };
}
