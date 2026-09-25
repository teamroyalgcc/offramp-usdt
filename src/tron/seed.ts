import { Mnemonic } from 'ethers';
import { accountXpub } from './hd.js';

// The deposit-address seed phrase (HD_MNEMONIC). Every user's deposit address is
// derived from it, so it must be set once before launch and never changed.
// ponytail: plain env var on the host (Render encrypts env at rest). Upgrade path:
// move to a KMS/HSM-backed signer when volume or team size justifies the cost.
let cached: { phrase: string; xpub: string } | null = null;

function load() {
  if (cached) return cached;
  const phrase = (process.env.HD_MNEMONIC ?? '').trim().split(/\s+/).join(' ');
  if (!phrase) throw new Error('HD_MNEMONIC is not set');
  if (!Mnemonic.isValidMnemonic(phrase)) throw new Error('HD_MNEMONIC is not a valid BIP-39 phrase');
  cached = { phrase, xpub: accountXpub(phrase) };
  return cached;
}

export const loadSeedPhrase = () => load().phrase;
export const loadAccountXpub = () => load().xpub;
