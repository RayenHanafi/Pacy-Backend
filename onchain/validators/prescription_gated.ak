//// Pacy — prescription minting policy (Checkpoint 2 + on-chain expiry).
////
//// Enforces "doctors mint, pharmacies burn" against the on-chain allow-list (read from
//// the settings UTxO as a reference input), AND enforces per-prescription expiry.
////
//// Expiry: at mint the token is created carrying an INLINE DATUM = its expiry as POSIX
//// milliseconds (0 means "never expires"). On a burn, the policy reads that datum from the
//// token input and requires the transaction's validity range to end at or before the
//// expiry. Since the ledger only accepts a transaction within its validity range, a
//// dispense after expiry becomes impossible by construction — the same guarantee the
//// native-script `before(slot)` time-lock gave, but per-prescription under one policy id.

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use aiken/interval.{Finite}
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
      // Burning — an enrolled pharmacy must sign AND the prescription must not be expired.
      let pharmacy_ok =
        list.any(settings.pharmacies, fn(p) { list.has(self.extra_signatories, p) })
      pharmacy_ok && not_expired(self, policy_id)
    } else {
      False
    }
  }

  else(_) {
    fail
  }
}

/// Reads the expiry (POSIX ms) from the datum of the token input being burned, and checks
/// the transaction is bounded to end at or before it. 0 means "never expires".
fn not_expired(self: Transaction, policy_id: PolicyId) -> Bool {
  expect Some(token_input) =
    list.find(
      self.inputs,
      fn(i: Input) { !dict.is_empty(assets.tokens(i.output.value, policy_id)) },
    )
  expect InlineDatum(raw) = token_input.output.datum
  expect expiry: Int = raw

  if expiry == 0 {
    True
  } else {
    when self.validity_range.upper_bound.bound_type is {
      // The tx must not be valid past the expiry.
      Finite(upper) -> upper <= expiry
      // No finite upper bound -> cannot prove it is before expiry -> reject.
      _ -> False
    }
  }
}
