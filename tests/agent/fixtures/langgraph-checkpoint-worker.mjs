import { appendFileSync } from 'node:fs';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { openLangGraphCheckpointStore, stableEvaluationThreadId } from '../../../lib/autonomous-langgraph.mjs';

const [mode, root, marker] = process.argv.slice(2);
const applicationId = 'app-checkpoint-fixture';
const store = openLangGraphCheckpointStore({ dataRoot: root });
const State = Annotation.Root({
  events: Annotation({ reducer: (left, right) => [...left, ...right], default: () => [] })
});
const graph = new StateGraph(State)
  .addNode('completed_step', async () => {
    appendFileSync(marker, 'first\n');
    return { events: ['first'] };
  })
  .addNode('crash_or_finish', async () => {
    if (mode === 'crash') process.exit(77);
    return { events: ['second'] };
  })
  .addEdge(START, 'completed_step')
  .addEdge('completed_step', 'crash_or_finish')
  .addEdge('crash_or_finish', END)
  .compile({ checkpointer: store.checkpointer });

const config = { configurable: { thread_id: stableEvaluationThreadId(applicationId) }, durability: 'sync' };
if (mode === 'crash') await graph.invoke({ events: [] }, config);
else if (mode === 'resume') {
  const output = await graph.invoke(null, config);
  process.stdout.write(`${JSON.stringify(output)}\n`);
  store.close();
} else {
  store.close();
  throw new Error(`Unknown fixture mode: ${mode}`);
}
