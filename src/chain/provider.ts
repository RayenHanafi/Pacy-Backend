import { BlockfrostProvider } from '@meshsdk/core';
import { requireConfig } from '../config.js';

let provider: BlockfrostProvider | null = null;

/** Hosted chain access — no self-run node. Preprod only. */
export function blockfrost(): BlockfrostProvider {
  if (!provider) {
    provider = new BlockfrostProvider(requireConfig('BLOCKFROST_PROJECT_ID'));
  }
  return provider;
}
