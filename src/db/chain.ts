import { db } from './client.js';
import { AppError } from '../lib/errors.js';

export type ChainWalletRow = {
  profile_id: string;
  role: 'doctor' | 'pharmacy';
  address: string;
  key_hash: string;
  created_at: string;
};

export type ChainConfigRow = {
  id: number;
  policy_id: string | null;
  settings_address: string | null;
  settings_tx_hash: string | null;
  settings_output_index: number | null;
  doctors: string[];
  pharmacies: string[];
  updated_at: string;
};

const WALLET_COLUMNS = 'profile_id, role, address, key_hash, created_at';
const CONFIG_COLUMNS =
  'id, policy_id, settings_address, settings_tx_hash, settings_output_index, doctors, pharmacies, updated_at';

/** Records (or replaces) a user's Cardano signing identity. Idempotent per profile. */
export async function upsertChainWallet(input: {
  profile_id: string;
  role: 'doctor' | 'pharmacy';
  address: string;
  key_hash: string;
}): Promise<ChainWalletRow> {
  const { data, error } = await db()
    .from('chain_wallets')
    .upsert(input, { onConflict: 'profile_id' })
    .select(WALLET_COLUMNS)
    .single();

  if (error) throw new AppError('INTERNAL_ERROR', `Failed to save chain wallet: ${error.message}`);
  return data as ChainWalletRow;
}

export async function getChainWallet(profileId: string): Promise<ChainWalletRow | null> {
  const { data, error } = await db()
    .from('chain_wallets')
    .select(WALLET_COLUMNS)
    .eq('profile_id', profileId)
    .maybeSingle();

  if (error) throw new AppError('INTERNAL_ERROR', `Failed to load chain wallet: ${error.message}`);
  return (data as ChainWalletRow) ?? null;
}

export async function getChainConfig(): Promise<ChainConfigRow | null> {
  const { data, error } = await db()
    .from('chain_config')
    .select(CONFIG_COLUMNS)
    .eq('id', 1)
    .maybeSingle();

  if (error) throw new AppError('INTERNAL_ERROR', `Failed to load chain config: ${error.message}`);
  return (data as ChainConfigRow) ?? null;
}

/** Writes the singleton chain_config row (id = 1). */
export async function setChainConfig(input: {
  policy_id: string;
  settings_address: string;
  settings_tx_hash: string;
  settings_output_index: number;
  doctors: string[];
  pharmacies: string[];
}): Promise<ChainConfigRow> {
  const { data, error } = await db()
    .from('chain_config')
    .upsert({ id: 1, ...input, updated_at: new Date().toISOString() }, { onConflict: 'id' })
    .select(CONFIG_COLUMNS)
    .single();

  if (error) throw new AppError('INTERNAL_ERROR', `Failed to save chain config: ${error.message}`);
  return data as ChainConfigRow;
}
