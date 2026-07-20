import { waitForWalletSettled } from './confirm.js';
import { serviceAddress } from './wallet.js';

/**
 * Serializes every chain write through the service wallet.
 *
 * Why this is required: the wallet picks its inputs from the UTxO set Blockfrost
 * reports. A transaction that has been submitted but not yet included in a block does
 * NOT change that reported set, so a second transaction built immediately afterwards
 * selects the very same inputs and is rejected with:
 *
 *   ConwayMempoolFailure "All inputs are spent. Transaction has probably already been
 *   included"
 *
 * With one shared custodial wallet (PROJECT.md §13 decision 2) that happens any time a
 * doctor writes two prescriptions in a row — i.e. constantly, during a demo.
 *
 * The queue therefore holds its slot until the previous transaction is actually
 * confirmed. The caller, however, gets its result as soon as the node accepts the
 * submission, so an HTTP request never blocks for a full confirmation.
 */
let tail: Promise<void> = Promise.resolve();

export function enqueueChainWrite<T extends { tx_hash: string }>(
  task: () => Promise<T>,
): Promise<T> {
  // Run regardless of whether the previous write succeeded or failed.
  const started = tail.then(task, task);

  tail = started.then(
    async (result) => {
      try {
        // Wait for the new change output to be VISIBLE, not merely for the tx to be
        // indexed — otherwise the next build re-selects an already-spent input.
        await waitForWalletSettled(await serviceAddress(), result.tx_hash);
      } catch {
        // A settle timeout must not wedge the queue forever.
      }
    },
    () => {
      // Failed writes consumed no inputs; the next write can start immediately.
    },
  );

  return started;
}
