import { isMainModule } from '../lib/is-main-module.mjs';
import { main, QUEUE_RUNNER_USAGE } from '../src/agent/runtime/queue-runner.mjs';
export * from '../src/agent/runtime/queue-runner.mjs';

// Preserve the established command path while the implementation lives in src/agent.
if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${QUEUE_RUNNER_USAGE}\n`);
  } else {
    main().catch((error) => {
      console.error(error instanceof Error ? error.message : 'LangGraph queue run failed.');
      process.exitCode = 1;
    });
  }
}
