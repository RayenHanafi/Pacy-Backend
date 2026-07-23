//// Pacy — prescription minting policy (Checkpoint 2).
////
//// Enforces "doctors mint, pharmacies burn" on-chain against the allow-list read from the
//// settings UTxO (a reference input). Expiry and refill counts are enforced by the backend
//// (refills are also bounded by the token quantity the ledger tracks). Keeping the policy
//// free of a time check keeps mint/burn simple and robust — no per-token datum required.

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Input, Transaction}
use pacy/types.{Settings}

validator prescription_gated(settings_script: ScriptHash) {
  mint(_redeemer: Data, policy_id: PolicyId, self: Transaction) {
    // Find the settings UTxO among the reference inputs, by its script address.
    expect Some(settings_ref) =
      list.find(
        self.reference_inputs,
        fn(input: Input) {
          when input.output.address.payment_credential is {
            Script(hash) -> hash == settings_script
            _ -> False
          }
        },
      )
    expect InlineDatum(raw) = settings_ref.output.datum
    expect settings: Settings = raw

    let minted = assets.tokens(self.mint, policy_id)
    let total = dict.foldr(minted, 0, fn(_name, qty, acc) { acc + qty })

    if total > 0 {
      // Minting — at least one enrolled doctor must have signed.
      list.any(settings.doctors, fn(d) { list.has(self.extra_signatories, d) })
    } else if total < 0 {
      // Burning — at least one enrolled pharmacy must have signed.
      list.any(settings.pharmacies, fn(p) { list.has(self.extra_signatories, p) })
    } else {
      False
    }
  }

  else(_) {
    fail
  }
}
