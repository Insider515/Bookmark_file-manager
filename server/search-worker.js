import { parentPort, workerData } from 'node:worker_threads';

import { runSearch } from './search.js';

/**
 * The thread a search runs in.
 *
 * It exists so the search can be *stopped*. A regular expression supplied by a
 * client can be made to backtrack for longer than the universe will last, and
 * once `exec` is running there is nothing cooperative left to check a clock
 * from — only terminating the thread ends it. Matches are posted as they are
 * found so that a search killed part way through still returns what it had.
 */
runSearch({
  ...workerData,
  onBatch: (batch) => parentPort.postMessage({ type: 'matches', batch }),
})
  .then((summary) => {
    // The matches themselves already went out in batches.
    const { matches, ...rest } = summary;
    parentPort.postMessage({ type: 'done', summary: rest });
  })
  .catch((err) => {
    parentPort.postMessage({
      type: 'error',
      status: err?.status ?? 500,
      code: err?.code ?? 'SEARCH_FAILED',
      message: err?.message ?? 'The search failed',
    });
  });
