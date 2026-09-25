import { HDNodeWallet, Mnemonic } from 'ethers';
import { TronWeb } from 'tronweb';

// TRON BIP-44: m/44'/195'/0'/0/<index>. The API holds only the account xpub
// (m/44'/195'/0'); the seed is only ever decrypted in the worker.
export const TRON_ACCOUNT_PATH = "m/44'/195'/0'";

function toTron(evmAddress: string): string {
  return TronWeb.address.fromHex('41' + evmAddress.slice(2).toLowerCase());
}

/** Public derivation, safe for the API process. */
export function deriveAddressFromXpub(accountXpub: string, index: number): string {
  const node = HDNodeWallet.fromExtendedKey(accountXpub);
  if (node.depth !== 3) throw new Error('HD_ACCOUNT_XPUB must be the account-level key (depth 3)');
  return toTron(node.deriveChild(0).deriveChild(index).address);
}

/** Private derivation, worker only. Returns hex private key without 0x. */
export function derivePrivateKey(seedPhrase: string, index: number, expectedAddress: string): string {
  const root = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(seedPhrase), `${TRON_ACCOUNT_PATH}/0/${index}`);
  if (toTron(root.address) !== expectedAddress) {
    throw new Error(`Derived key for index ${index} does not match recorded EOA`);
  }
  return root.privateKey.slice(2);
}

/** Account xpub for a seed phrase; used once at bootstrap to produce HD_ACCOUNT_XPUB. */
export function accountXpub(seedPhrase: string): string {
  return HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(seedPhrase), TRON_ACCOUNT_PATH).neuter().extendedKey;
}
