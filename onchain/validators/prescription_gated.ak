//// Pacy — prescription minting policy (Checkpoint 2).
////
//// Like Checkpoint 1 it enforces "doctors mint, pharmacies burn" on-chain — but instead
//// of hardcoding two keys as parameters, it READS the allowed keys from the settings
//// UTxO at validation time. The settings UTxO is passed as a REFERENCE INPUT (read, not
//// spent), and this policy checks that the transaction signer appears in the relevant
//// list inside that UTxO's datum.
////
//// Consequence: adding or removing a doctor/pharmacy is a datum update (see settings.ak),
//// not a recompile. The policy id never changes, so previously minted prescriptions stay
//// valid. The only parameter is the settings validator's script hash, which pins WHICH
//// settings UTxO this policy trusts.

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

    // Read the allow-list from its inline datum.
    expect InlineDatum(raw) = settings_ref.output.datum
    expect settings: Settings = raw

    // Net quantity forged under this policy: > 0 mint, < 0 burn.
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
