//// Shared on-chain types for Pacy Checkpoint 2.

use aiken/crypto.{VerificationKeyHash}

/// The on-chain allow-list, stored as the inline datum of a single "settings" UTxO.
///
/// - `admin`      — the cold key permitted to update this list (spend the settings UTxO).
/// - `doctors`    — key hashes allowed to MINT a prescription.
/// - `pharmacies` — key hashes allowed to BURN (dispense) a prescription.
///
/// Changing who may prescribe or dispense is a datum update signed by `admin`; it needs
/// no recompilation and no redeployment of any script.
pub type Settings {
  admin: VerificationKeyHash,
  doctors: List<VerificationKeyHash>,
  pharmacies: List<VerificationKeyHash>,
}
