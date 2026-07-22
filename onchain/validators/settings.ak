//// The settings UTxO — the on-chain governance record.
////
//// Holds the allow-list (see `pacy/types.Settings`) as its inline datum. Spending it is
//// how the admin UPDATES the list: the spend is valid only if the current admin signed
//// the transaction. The prescription policy reads this UTxO as a reference input without
//// spending it, so day-to-day mints/burns never trigger this validator — only updates do.

use aiken/collection/list
use cardano/transaction.{OutputReference, Transaction}
use pacy/types.{Settings}

validator settings {
  spend(
    datum: Option<Settings>,
    _redeemer: Data,
    _own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(current) = datum
    // Only the current admin may update the allow-list.
    list.has(self.extra_signatories, current.admin)
  }

  else(_) {
    fail
  }
}
