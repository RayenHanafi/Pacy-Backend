//// Pacy — prescription minting policy (Checkpoint 1).
////
//// The whole point: move the "who may mint / who may burn" rule OFF the backend
//// and ONTO the chain. In the deployed system a single custodial service wallet
//// signs everything, so the backend is trusted to behave. Here the ledger itself
//// enforces it:
////
////   - a MINT (positive quantity) is valid only if the DOCTOR's key signed the tx
////   - a BURN (negative quantity) is valid only if the PHARMACY's key signed the tx
////
//// Neither the backend nor anyone else can forge a prescription or dispense one
//// without the right key — the validator rejects the transaction outright.
////
//// The two key hashes are validator PARAMETERS, bound at build time to our demo
//// wallets. Checkpoint 2 replaces these fixed keys with an on-chain settings UTxO
//// (a datum holding the list of allowed doctors/pharmacies) so credentials can be
//// updated without recompiling.

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/assets.{PolicyId}
use cardano/transaction.{Transaction}

validator prescription(doctor: VerificationKeyHash, pharmacy: VerificationKeyHash) {
  mint(_redeemer: Data, policy_id: PolicyId, self: Transaction) {
    // All tokens minted/burned under THIS policy in this transaction.
    let minted = assets.tokens(self.mint, policy_id)

    // Net quantity: > 0 is a mint, < 0 is a burn. Summed so a single tx that
    // touched several asset names under the policy still resolves one way.
    let total =
      dict.foldr(minted, 0, fn(_asset_name, quantity, acc) { acc + quantity })

    if total > 0 {
      // Minting a prescription — only the doctor may authorise it.
      list.has(self.extra_signatories, doctor)
    } else if total < 0 {
      // Burning (dispensing) — only the pharmacy may authorise it.
      list.has(self.extra_signatories, pharmacy)
    } else {
      // A no-op forge under our policy is never legitimate.
      False
    }
  }

  // This validator is a minting policy only; it never guards a spend, withdrawal,
  // or any other purpose, so every other script purpose is rejected.
  else(_) {
    fail
  }
}
