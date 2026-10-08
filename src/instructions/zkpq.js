'use strict';

/**
 * @file Builders for `XerisInstruction` variants 46-53 and 61: the ZK verifier
 * registry (`xeris_zk_verifier`) and the PQ key registry (`xeris_pq_keys`)
 * instructions (`token.rs:607-731`, `token.rs:795-807`).
 *
 * Wire format: the node embeds `XerisInstruction` values in transaction
 * instruction `data` with `bincode::serialize` (bincode 1.3.3 default options;
 * serde derive at `token.rs:29`). Each instruction is `u32le(variant index)`
 * followed by the variant's fields in declaration order; strings and `Vec<u8>`
 * carry a `u64le` length prefix, `bool` is one byte. The variant index is the
 * declaration position in the enum (`token.rs:30`), so the indices below must
 * never be reordered.
 *
 * These builders are pure wire encoders. They reject only what bincode cannot
 * encode (wrong JavaScript type, integer outside the field's domain, lone UTF-16
 * surrogate, wrong argument count) and never substitute a default for a caller
 * value or apply a node business rule (`'dilithium3'`, 1952-byte keys, level 3,
 * `'groth16'`, PQ-claim tokens). The node rules that apply to each variant are
 * cited in the builder's JSDoc; `XerisClient` (`src/client.js`, `checks.*`)
 * enforces them before any network call. The `zero-values` reference vectors
 * for ZkProofSubmit and PqKeyRegister (empty strings, empty byte vectors,
 * level 0) must encode byte-exactly, which rules out any substitution here.
 *
 * Three of the nine variants are skipped by the node's block dispatcher after
 * the transaction fee has been charged and produce no state change:
 * ZkPrivateTransfer (48, `ledger.rs:8669-8685`), ZkIdentityProof (49,
 * `ledger.rs:8687-8697`) and PqSignedTransfer (52, `ledger.rs:8809-8828`).
 * `validate_tx_semantics` (`ledger.rs:1382-1455`) has no arm for them, so a
 * submitted transaction is admitted, included in a block, charged
 * `BASE_TX_FEE`, and then dropped by the `continue`. Their public builders
 * therefore throw `FeatureDisabledError` synchronously; the wire encoders stay
 * available as `_raw.<name>` so the reference vectors can still be asserted,
 * and `src/transaction.js` / `XerisClient.sendInstruction` refuse the three
 * variant indices again before anything is signed.
 *
 * Integers: `number` must be a safe integer; values above 2^53-1 must be passed
 * as `bigint`. Bytes: `Buffer | Uint8Array` only. Booleans are only `true` /
 * `false`. Every builder throws `EncodingError` (`code: 'arity'`) when called
 * with the wrong number of arguments: bincode has no field names, so a dropped
 * or extra positional argument would shift every later field on the wire.
 */

const {
  assertString,
  concat,
  encodeBool,
  encodeBytes,
  encodeFixedBytes,
  encodeString,
  encodeU64,
  encodeU8,
  encodeVariant,
  toBytes,
} = require('../encoding');
const { EncodingError, disabledFeature } = require('../errors');
const { PQ_PUBLIC_KEY_LEN, PQ_ROTATE_TAG } = require('../constants');

// Variant indices = declaration order of `enum XerisInstruction` (token.rs:30).
// The line cited on each entry is the variant's declaration.
const IDX = Object.freeze({
  ZkProofSubmit: 46, // token.rs:607
  ZkProofVerify: 47, // token.rs:626
  ZkPrivateTransfer: 48, // token.rs:634
  ZkIdentityProof: 49, // token.rs:654
  PqKeyRegister: 50, // token.rs:680
  PqKeyRotate: 51, // token.rs:694
  PqSignedTransfer: 52, // token.rs:709
  PqAttest: 53, // token.rs:722
  ZkVkRegister: 61, // token.rs:795
});

/**
 * Throws when a builder is called with the wrong number of arguments.
 * @param {number} actual `arguments.length` of the caller
 * @param {number} expected the variant's field count
 * @param {string} qualifiedName name shown in the message, e.g. `Instructions.pqAttest`
 * @param {string} fields comma-separated parameter list shown in the message
 * @returns {void}
 * @throws {EncodingError} `code: 'arity'`
 */
function assertArity(actual, expected, qualifiedName, fields) {
  if (actual !== expected) {
    throw new EncodingError(
      `${qualifiedName} expects exactly ${expected} arguments (${fields}), got ${actual}`,
      { code: 'arity', details: { builder: qualifiedName, expected, got: actual } },
    );
  }
}

// ---------------------------------------------------------------------------
// ZK verifier registry (`xeris_zk_verifier`)
// ---------------------------------------------------------------------------

/**
 * Encodes `ZkProofSubmit` (variant 46): submit a Groth16/BN254 proof for
 * verification against a registered verification key (`token.rs:607-622`).
 *
 * Node handling (`ledger.rs:8529-8661`), in order:
 * - `proofSystem` must be exactly `"groth16"` and none of `proofSystem`,
 *   `proofType`, `metadataJson` may contain a PQ-claim token (`asserts_pq_claim`,
 *   `ledger.rs:5362-5374`; `PQ_CLAIM_TOKENS`); otherwise the instruction is
 *   skipped (`ledger.rs:8566-8573`).
 * - `verificationKeyHash` must be a `vk_id` registered with `ZkVkRegister`
 *   (variant 61); inline VK bytes are not accepted (`ledger.rs:8587-8604`).
 * - The proof is checked with `verify_classical_groth16` (`crypto.rs:1045-1114`)
 *   against the registered VK: `proofData` at most 512 bytes
 *   (`crypto.rs:1041, 1048`), `publicInputs` a whole number of 32-byte
 *   little-endian `Fr` elements, at most 64 of them (`crypto.rs:1043, 1050,
 *   1090-1098`), exact byte consumption with no trailing bytes
 *   (`crypto.rs:1068-1098`). A
 *   proof that fails is not stored at all (`ledger.rs:8620-8623`).
 * - The stored record's `proof_type` is the `claim_type` registered with the
 *   VK; the caller's `proofType` is ignored (`ledger.rs:8643-8650`).
 *   `metadataJson` is stored verbatim as annotation (`ledger.rs:8651`).
 * - A duplicate `proofId` is rejected by the registry (`contracts.rs:6046`);
 *   at most 64 `groth16` submissions are allowed per block (`ledger.rs:154,
 *   162-167`); the instruction must fit `MAX_IX_DATA_SIZE` (`ledger.rs:93`).
 * The transaction fee is charged whether or not the proof is stored.
 * `XerisClient.zkProofSubmit` applies `checks.groth16` before sending.
 * @param {string} proofId unique proof identifier
 * @param {string} proofSystem proof system name; the node accepts only `"groth16"`
 * @param {Buffer|Uint8Array} proofData compressed arkworks Groth16/BN254 proof bytes (128 bytes for a standard proof)
 * @param {Buffer|Uint8Array} publicInputs concatenated 32-byte little-endian BN254 `Fr` elements
 * @param {string} verificationKeyHash the registered `vk_id` to verify against
 * @param {string} proofType caller-declared claim; not stored (see above)
 * @param {string} metadataJson JSON annotation stored verbatim
 * @returns {Buffer} encoded instruction (variant 46)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} a field has the wrong type
 * @throws {RangeError} a string contains a lone surrogate
 * @see ledger.rs:8529-8661
 */
function zkProofSubmit(
  proofId,
  proofSystem,
  proofData,
  publicInputs,
  verificationKeyHash,
  proofType,
  metadataJson,
) {
  assertArity(
    arguments.length,
    7,
    'Instructions.zkProofSubmit',
    'proofId, proofSystem, proofData, publicInputs, verificationKeyHash, proofType, metadataJson',
  );
  return concat([
    encodeVariant(IDX.ZkProofSubmit),
    encodeString(proofId, 'proofId'),
    encodeString(proofSystem, 'proofSystem'),
    encodeBytes(proofData, 'proofData'),
    encodeBytes(publicInputs, 'publicInputs'),
    encodeString(verificationKeyHash, 'verificationKeyHash'),
    encodeString(proofType, 'proofType'),
    encodeString(metadataJson, 'metadataJson'),
  ]);
}

/**
 * Encodes `ZkProofVerify` (variant 47): read back the stored verification
 * status of a proof (`token.rs:626-628`).
 *
 * The registry method it reaches is read-only: it returns `{proof_id, verified,
 * verification_slot, proof_system, note}` from the stored record and can never
 * change `verified`, which is fixed at submission time (`contracts.rs:6111-6132`;
 * dispatcher `ledger.rs:8663-8667`). A missing `proofId` is a registry error.
 * The transaction still costs `BASE_TX_FEE`; the same record is readable
 * without a transaction through `GET /zk/verify/{proofId}`
 * (`network.rs:5927-5938`, `XerisClient.getZkProofStatus`).
 * @param {string} proofId identifier used in `ZkProofSubmit`
 * @returns {Buffer} encoded instruction (variant 47)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} `proofId` is not a string
 * @throws {RangeError} `proofId` contains a lone surrogate
 * @see ledger.rs:8663-8667
 */
function zkProofVerify(proofId) {
  assertArity(arguments.length, 1, 'Instructions.zkProofVerify', 'proofId');
  return concat([
    encodeVariant(IDX.ZkProofVerify),
    encodeString(proofId, 'proofId'),
  ]);
}

/**
 * Wire encoder for `ZkPrivateTransfer` (variant 48; `token.rs:634-649`).
 * Exposed only as `_raw.zkPrivateTransfer` for wire-format tests: the node
 * dispatcher charges the fee and then skips the instruction with no balance
 * change (`ledger.rs:8669-8685`, NEW-CRIT-3), so `Instructions.zkPrivateTransfer`
 * throws instead of returning these bytes.
 * @param {string} tokenId token being transferred
 * @param {string} from sender
 * @param {string} to recipient
 * @param {Buffer|Uint8Array} amountCommitment commitment bytes
 * @param {Buffer|Uint8Array} rangeProof range proof bytes
 * @param {Buffer|Uint8Array} balanceProof balance proof bytes
 * @param {Buffer|Uint8Array} nullifier nullifier bytes
 * @returns {Buffer} encoded instruction (variant 48)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} a field has the wrong type
 * @throws {RangeError} a string contains a lone surrogate
 * @see ledger.rs:8669-8685
 */
function rawZkPrivateTransfer(
  tokenId,
  from,
  to,
  amountCommitment,
  rangeProof,
  balanceProof,
  nullifier,
) {
  assertArity(
    arguments.length,
    7,
    '_raw.zkPrivateTransfer',
    'tokenId, from, to, amountCommitment, rangeProof, balanceProof, nullifier',
  );
  return concat([
    encodeVariant(IDX.ZkPrivateTransfer),
    encodeString(tokenId, 'tokenId'),
    encodeString(from, 'from'),
    encodeString(to, 'to'),
    encodeBytes(amountCommitment, 'amountCommitment'),
    encodeBytes(rangeProof, 'rangeProof'),
    encodeBytes(balanceProof, 'balanceProof'),
    encodeBytes(nullifier, 'nullifier'),
  ]);
}

/**
 * `ZkPrivateTransfer` (variant 48) is skipped by the node dispatcher after the
 * fee is charged (`ledger.rs:8669-8685`, NEW-CRIT-3), so this builder never
 * encodes anything: it throws synchronously without reading its arguments.
 * There is no private-transfer path on the node; use `nativeTransfer`
 * (variant 11) or `tokenTransfer` (variant 1). The raw wire encoder is
 * `_raw.zkPrivateTransfer(tokenId, from, to, amountCommitment, rangeProof,
 * balanceProof, nullifier)`.
 * @returns {never}
 * @throws {FeatureDisabledError} always (`feature: 'ZkPrivateTransfer'`)
 * @see ledger.rs:8669-8685
 */
function zkPrivateTransfer() {
  throw disabledFeature('ZkPrivateTransfer');
}

/**
 * Wire encoder for `ZkIdentityProof` (variant 49; `token.rs:654-666`).
 * Exposed only as `_raw.zkIdentityProof` for wire-format tests: the node
 * dispatcher charges the fee and then skips the instruction
 * (`ledger.rs:8687-8697`, NEW-CRIT-1), so `Instructions.zkIdentityProof` throws
 * instead of returning these bytes.
 * @param {string} identityPubkey identity making the claim
 * @param {string} claimType claim name
 * @param {number|bigint} claimValue u64 threshold or target value
 * @param {Buffer|Uint8Array} proofData proof bytes
 * @param {Buffer|Uint8Array} publicInputs public input bytes
 * @returns {Buffer} encoded instruction (variant 49)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} a field has the wrong type
 * @throws {RangeError} `claimValue` outside `0..=2^64-1`, or a string contains a lone surrogate
 * @see ledger.rs:8687-8697
 */
function rawZkIdentityProof(identityPubkey, claimType, claimValue, proofData, publicInputs) {
  assertArity(
    arguments.length,
    5,
    '_raw.zkIdentityProof',
    'identityPubkey, claimType, claimValue, proofData, publicInputs',
  );
  return concat([
    encodeVariant(IDX.ZkIdentityProof),
    encodeString(identityPubkey, 'identityPubkey'),
    encodeString(claimType, 'claimType'),
    encodeU64(claimValue, 'claimValue'),
    encodeBytes(proofData, 'proofData'),
    encodeBytes(publicInputs, 'publicInputs'),
  ]);
}

/**
 * `ZkIdentityProof` (variant 49) is skipped by the node dispatcher after the
 * fee is charged (`ledger.rs:8687-8697`, NEW-CRIT-1), so this builder never
 * encodes anything: it throws synchronously without reading its arguments.
 * The only live proof path is `zkProofSubmit` (variant 46) against a VK
 * registered with `zkVkRegister` (variant 61). The raw wire encoder is
 * `_raw.zkIdentityProof(identityPubkey, claimType, claimValue, proofData,
 * publicInputs)`.
 * @returns {never}
 * @throws {FeatureDisabledError} always (`feature: 'ZkIdentityProof'`)
 * @see ledger.rs:8687-8697
 */
function zkIdentityProof() {
  throw disabledFeature('ZkIdentityProof');
}

/**
 * Encodes `ZkVkRegister` (variant 61): register a Groth16/BN254 verification
 * key, with the claim semantics proofs under it will carry, in
 * `xeris_zk_verifier` (`token.rs:795-807`).
 *
 * Node handling (`ledger.rs:8456-8527`), in order:
 * - The signer's stake must be at least `MIN_STAKE_TO_MINE` = 1,000 XRS
 *   (`ledger.rs:232`, `8480-8491`; `MIN_STAKE_LAMPORTS`).
 * - None of `vkId`, `claimType`, `description` may contain a PQ-claim token
 *   (`asserts_pq_claim`, `ledger.rs:5362-5374`, applied at `8492-8495`;
 *   `PQ_CLAIM_TOKENS`). Note that the bare token `pq` matches as a substring.
 * - `vkBase64` must decode as base64 (`ledger.rs:8496-8502`) to a canonical
 *   compressed arkworks `VerifyingKey<Bn254>` of 1..=16384 bytes with no
 *   trailing bytes (`validate_groth16_vk_bytes`, `crypto.rs:1143-1152`;
 *   `MAX_GROTH16_VK_BYTES`; `ledger.rs:8503-8506`).
 * - Registration is immutable: a second `ZkVkRegister` for an existing `vkId`
 *   is a registry error (`contracts.rs:6028`); the registry holds at most
 *   10,000 keys (`contracts.rs:6029`).
 * The stored metadata is `{vk_base64, claim_type, description, registered_by,
 * registered_slot}` (`ledger.rs:8513-8519`); `claimType` becomes the
 * `proof_type` of every proof later verified under this `vkId`
 * (`ledger.rs:8643-8650`). A rejected instruction still costs the fee.
 * `XerisClient.zkVkRegister` applies `checks.noPqClaim` and `checks.vkBase64`
 * before sending.
 * @param {string} vkId registry key that `ZkProofSubmit.verificationKeyHash` references
 * @param {string} vkBase64 base64 of the compressed BN254 verifying key bytes
 * @param {string} claimType claim semantics bound to the key (e.g. `"transfer"`, `"computation"`)
 * @param {string} description registration note stored verbatim
 * @returns {Buffer} encoded instruction (variant 61)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} a field is not a string
 * @throws {RangeError} a string contains a lone surrogate
 * @see ledger.rs:8456-8527
 */
function zkVkRegister(vkId, vkBase64, claimType, description) {
  assertArity(
    arguments.length,
    4,
    'Instructions.zkVkRegister',
    'vkId, vkBase64, claimType, description',
  );
  return concat([
    encodeVariant(IDX.ZkVkRegister),
    encodeString(vkId, 'vkId'),
    encodeString(vkBase64, 'vkBase64'),
    encodeString(claimType, 'claimType'),
    encodeString(description, 'description'),
  ]);
}

// ---------------------------------------------------------------------------
// PQ key registry (`xeris_pq_keys`)
// ---------------------------------------------------------------------------

/**
 * Encodes `PqKeyRegister` (variant 50): bind an ML-DSA-65 (Dilithium3) public
 * key to an Ed25519 address in `xeris_pq_keys` (`token.rs:680-689`).
 *
 * Node handling (`ledger.rs:8701-8736`, then registry `register`
 * `contracts.rs:6168-6245`), in order:
 * - `pqAlgorithm` must be exactly `"dilithium3"` (case-sensitive;
 *   `SUPPORTED_PQ_ALGORITHM`, `crypto.rs:924-938`; `ledger.rs:8707-8710`).
 * - `pqPublicKey` must be exactly 1952 bytes (`pq_pubkey_len`,
 *   `crypto.rs:946-976`; `PQ_PUBLIC_KEY_LEN`; `ledger.rs:8713-8716`) and parse
 *   as a Dilithium3 public key (`dilithium_validate_pubkey`, `crypto.rs:1231`;
 *   `ledger.rs:8719-8725`).
 * - `securityLevel`: `validate_pq_key_format` accepts 1, 2, 3 or 5
 *   (`crypto.rs:975`) but the registry rejects anything other than 3
 *   (`contracts.rs:6207-6209`; `PQ_SECURITY_LEVEL`).
 * - The transaction signer must equal `ed25519Pubkey` (`contracts.rs:6183`),
 *   and the address must not already have a key: a registered key can only be
 *   changed through `pqKeyRotate` (`contracts.rs:6192-6194`).
 * The dedicated route `POST /pq-register` (`network.rs:4571-4655`) runs the
 * same signer check before mempool admission (first instruction must be
 * `PqKeyRegister`, `network.rs:4595-4605`; `signer == ed25519_pubkey`,
 * `network.rs:4609-4615`) and replies `{status:'queued', message,
 * ed25519_pubkey, signature}` (`network.rs:4654`); `POST /submit` also
 * accepts it. `XerisClient.pqKeyRegister` applies `checks.pqRegister` and uses
 * `/pq-register` by default.
 * @param {string} ed25519Pubkey base58 address the key is bound to; must be the transaction signer
 * @param {Buffer|Uint8Array} pqPublicKey ML-DSA-65 public key bytes (1952 bytes on the node)
 * @param {string} pqAlgorithm algorithm name; the node accepts only `"dilithium3"`
 * @param {number|bigint} securityLevel u8 NIST level; the registry accepts only 3
 * @returns {Buffer} encoded instruction (variant 50)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} a field has the wrong type
 * @throws {RangeError} `securityLevel` outside `0..=255`, or a string contains a lone surrogate
 * @see ledger.rs:8701-8736
 */
function pqKeyRegister(ed25519Pubkey, pqPublicKey, pqAlgorithm, securityLevel) {
  assertArity(
    arguments.length,
    4,
    'Instructions.pqKeyRegister',
    'ed25519Pubkey, pqPublicKey, pqAlgorithm, securityLevel',
  );
  return concat([
    encodeVariant(IDX.PqKeyRegister),
    encodeString(ed25519Pubkey, 'ed25519Pubkey'),
    encodeBytes(pqPublicKey, 'pqPublicKey'),
    encodeString(pqAlgorithm, 'pqAlgorithm'),
    encodeU8(securityLevel, 'securityLevel'),
  ]);
}

/**
 * Encodes `PqKeyRotate` (variant 51): replace the registered ML-DSA-65 key of
 * an address with a new one, authorised by the current key (`token.rs:694-704`).
 *
 * Node handling (`ledger.rs:8738-8807`), in order:
 * - The transaction signer must equal `ed25519Pubkey` (`ledger.rs:8751-8754`).
 * - `newPqAlgorithm` must be exactly `"dilithium3"` and `newPqPublicKey` must
 *   parse as a Dilithium3 public key (`ledger.rs:8758-8763`); the registry
 *   re-checks the algorithm and the exact 1952-byte length (`contracts.rs:6270-6278`).
 * - A key must already be registered for the address (`ledger.rs:8765-8777`)
 *   and its algorithm must start with `dilithium` case-insensitively
 *   (`ledger.rs:8781-8784`; the slot-1 bootstrap registers `"Dilithium3"`).
 * - `rotationProof` must be the detached ML-DSA-65 signature (3309 bytes,
 *   `crypto.rs:1165, 1178-1180`; `PQ_SIGNATURE_LEN`) made with the CURRENTLY
 *   REGISTERED secret key over the message returned by
 *   `buildPqRotationMessage(chainId, oldPk, newPk, rotationCount)`
 *   (`verify_key_rotation_v5_dilithium`, `crypto.rs:851-870`;
 *   `ledger.rs:8787-8792`). `rotationCount` is the account's current
 *   `rotation_count` from `GET /pq/keys/{address}` (`network.rs:5958-5976`,
 *   `XerisClient.getPqKey`): 0 for the first rotation (`contracts.rs:6243`),
 *   incremented by every applied rotation (`contracts.rs:6316`).
 * A rejected instruction still costs the fee. `XerisClient.pqKeyRotate` applies
 * `checks.pqRotate` before sending.
 * @param {string} ed25519Pubkey base58 address whose key rotates; must be the transaction signer
 * @param {Buffer|Uint8Array} newPqPublicKey new ML-DSA-65 public key bytes (1952 bytes on the node)
 * @param {string} newPqAlgorithm algorithm name; the node accepts only `"dilithium3"`
 * @param {Buffer|Uint8Array} rotationProof ML-DSA-65 signature by the current key over the rotation message
 * @returns {Buffer} encoded instruction (variant 51)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} a field has the wrong type
 * @throws {RangeError} a string contains a lone surrogate
 * @see ledger.rs:8738-8807
 */
function pqKeyRotate(ed25519Pubkey, newPqPublicKey, newPqAlgorithm, rotationProof) {
  assertArity(
    arguments.length,
    4,
    'Instructions.pqKeyRotate',
    'ed25519Pubkey, newPqPublicKey, newPqAlgorithm, rotationProof',
  );
  return concat([
    encodeVariant(IDX.PqKeyRotate),
    encodeString(ed25519Pubkey, 'ed25519Pubkey'),
    encodeBytes(newPqPublicKey, 'newPqPublicKey'),
    encodeString(newPqAlgorithm, 'newPqAlgorithm'),
    encodeBytes(rotationProof, 'rotationProof'),
  ]);
}

/**
 * Wire encoder for `PqSignedTransfer` (variant 52; `token.rs:709-717`).
 * Exposed only as `_raw.pqSignedTransfer` for wire-format tests: the node
 * dispatcher charges the fee and then skips the instruction with no balance
 * change (`ledger.rs:8809-8828`, NEW-CRIT-4), so `Instructions.pqSignedTransfer`
 * throws instead of returning these bytes. The variant carries no nonce, so the
 * node's hardened verifier (`crypto.rs:886-909`) cannot be wired to it
 * (`ledger.rs:8822-8825`).
 * @param {string} from sender
 * @param {string} to recipient
 * @param {number|bigint} amount u64 base units
 * @param {Buffer|Uint8Array} pqSignature signature bytes
 * @param {string} pqAlgorithm algorithm name
 * @returns {Buffer} encoded instruction (variant 52)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} a field has the wrong type
 * @throws {RangeError} `amount` outside `0..=2^64-1`, or a string contains a lone surrogate
 * @see ledger.rs:8809-8828
 */
function rawPqSignedTransfer(from, to, amount, pqSignature, pqAlgorithm) {
  assertArity(
    arguments.length,
    5,
    '_raw.pqSignedTransfer',
    'from, to, amount, pqSignature, pqAlgorithm',
  );
  return concat([
    encodeVariant(IDX.PqSignedTransfer),
    encodeString(from, 'from'),
    encodeString(to, 'to'),
    encodeU64(amount, 'amount'),
    encodeBytes(pqSignature, 'pqSignature'),
    encodeString(pqAlgorithm, 'pqAlgorithm'),
  ]);
}

/**
 * `PqSignedTransfer` (variant 52) is skipped by the node dispatcher after the
 * fee is charged (`ledger.rs:8809-8828`, NEW-CRIT-4), so this builder never
 * encodes anything: it throws synchronously without reading its arguments.
 * Transfers are Ed25519-signed `nativeTransfer` (variant 11); `pqKeyRegister`
 * (50) and `pqKeyRotate` (51) remain live. The raw wire encoder is
 * `_raw.pqSignedTransfer(from, to, amount, pqSignature, pqAlgorithm)`.
 * @returns {never}
 * @throws {FeatureDisabledError} always (`feature: 'PqSignedTransfer'`)
 * @see ledger.rs:8809-8828
 */
function pqSignedTransfer() {
  throw disabledFeature('PqSignedTransfer');
}

/**
 * Encodes `PqAttest` (variant 53): record a self-asserted PQ adoption marker
 * in `xeris_zk_verifier` (`token.rs:722-731`).
 *
 * Node handling (`ledger.rs:8830-8871`): no cryptographic verification is
 * performed. The marker is stored through `submit_attestation` in the
 * registry's separate `pq_attestations` map (`contracts.rs:6076-6110`) with
 * record id `pq_attest_` + sha256(`signer:referenceId:slot`)
 * (`pq_attestation_id`, `ledger.rs:5328-5333`), `proof_system` =
 * `"pq_" + pqAlgorithm`, `proof_data_hash` = `referenceId`, `proof_type` =
 * `attestationType`, and metadata `{pq_algorithm, self_asserted: <verified>,
 * reference, note}` (`ledger.rs:8858-8865`). The stored record's `verified`
 * field is always `false`: the caller's `verified` flag only lands under the
 * metadata key `self_asserted` (`ledger.rs:8841-8845`; `contracts.rs:6076-6110`).
 * The handler requires `xeris_zk_verifier` to exist already (it does not
 * create it, `ledger.rs:8857`), and a duplicate record id is a registry error
 * (`contracts.rs:6087`). The fee is charged in every case.
 * @param {string} attestationType what was attested, e.g. `"transaction"`, `"block"`, `"key_registration"`
 * @param {string} referenceId identifier of the attested item (tx signature, block hash, key hash)
 * @param {string} pqAlgorithm algorithm name recorded in the marker
 * @param {boolean} verified caller's claim, stored as `self_asserted`; does not set the record's `verified`
 * @returns {Buffer} encoded instruction (variant 53)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} a string field is not a string, or `verified` is not a boolean
 * @throws {RangeError} a string contains a lone surrogate
 * @see ledger.rs:8830-8871
 */
function pqAttest(attestationType, referenceId, pqAlgorithm, verified) {
  assertArity(
    arguments.length,
    4,
    'Instructions.pqAttest',
    'attestationType, referenceId, pqAlgorithm, verified',
  );
  return concat([
    encodeVariant(IDX.PqAttest),
    encodeString(attestationType, 'attestationType'),
    encodeString(referenceId, 'referenceId'),
    encodeString(pqAlgorithm, 'pqAlgorithm'),
    encodeBool(verified, 'verified'),
  ]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds the message that `PqKeyRotate.rotationProof` must sign
 * (`verify_key_rotation_v5_dilithium`, `crypto.rs:851-870`):
 *
 *     ascii("xrs_pq_rotate_v5") ‖ chainId ‖ oldPk ‖ newPk ‖ u64le(rotationCount)
 *
 * No field carries a length prefix (`crypto.rs:861-868`): the tag is 16 bytes
 * and both keys are fixed at 1952 bytes, so the layout is unambiguous. The
 * node verifies with `chain_id_for(is_mainnet)` (`ledger.rs:8787-8788`), the
 * raw bytes `xeris-testnet-v1` / `xeris-mainnet-v1` (`ledger.rs:286-290`;
 * `CHAIN_ID_TESTNET` / `CHAIN_ID_MAINNET`), and `nonce` = the account's
 * current `rotation_count` (`ledger.rs:8767-8768`). The caller signs the
 * returned bytes with the CURRENTLY REGISTERED ML-DSA-65 secret key
 * (`dilithium_sign`, `crypto.rs:1198`); this SDK does not implement ML-DSA.
 * @param {string|Buffer|Uint8Array} chainId chain id: a string is used as its UTF-8 (ASCII) bytes, bytes are used as given
 * @param {Buffer|Uint8Array} oldPk currently registered public key, exactly `PQ_PUBLIC_KEY_LEN` (1952) bytes
 * @param {Buffer|Uint8Array} newPk public key being installed, exactly `PQ_PUBLIC_KEY_LEN` (1952) bytes
 * @param {number|bigint} rotationCount current `rotation_count` of the address (u64)
 * @returns {Buffer} the message bytes (`16 + chainId.length + 1952 + 1952 + 8`)
 * @throws {EncodingError} wrong argument count (`code: 'arity'`)
 * @throws {TypeError} `chainId` is not a string or bytes, a key is not bytes, or `rotationCount` is not a number/bigint
 * @throws {RangeError} `chainId` is empty or contains a lone surrogate, a key is not exactly 1952 bytes, or `rotationCount` is outside `0..=2^64-1`
 * @see crypto.rs:851-870
 * @see ledger.rs:8785-8792
 */
function buildPqRotationMessage(chainId, oldPk, newPk, rotationCount) {
  assertArity(
    arguments.length,
    4,
    'buildPqRotationMessage',
    'chainId, oldPk, newPk, rotationCount',
  );
  const chainIdBytes = typeof chainId === 'string'
    ? Buffer.from(assertString(chainId, 'chainId'), 'utf8')
    : toBytes(chainId, 'chainId');
  if (chainIdBytes.length === 0) {
    // `chain_id_for` never returns an empty id (ledger.rs:286-290); an empty
    // domain would produce a message no node verifies.
    throw new RangeError('chainId: expected the chain id bytes (e.g. CHAIN_ID_TESTNET), got an empty value');
  }
  return concat([
    Buffer.from(PQ_ROTATE_TAG, 'ascii'), // crypto.rs:864
    chainIdBytes, // crypto.rs:865
    encodeFixedBytes(oldPk, PQ_PUBLIC_KEY_LEN, 'oldPk'), // crypto.rs:866
    encodeFixedBytes(newPk, PQ_PUBLIC_KEY_LEN, 'newPk'), // crypto.rs:867
    encodeU64(rotationCount, 'rotationCount'), // crypto.rs:868 (`nonce.to_le_bytes()`)
  ]);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * The nine builders for variants 46-53 and 61, keyed by camelCase builder
 * name. `zkPrivateTransfer`, `zkIdentityProof` and `pqSignedTransfer` throw
 * `FeatureDisabledError`. Aggregated into `Instructions` by
 * `src/instructions/index.js`.
 * @type {Readonly<Record<string, Function>>}
 */
const zkpq = Object.freeze({
  zkProofSubmit,
  zkProofVerify,
  zkPrivateTransfer,
  zkIdentityProof,
  pqKeyRegister,
  pqKeyRotate,
  pqSignedTransfer,
  pqAttest,
  zkVkRegister,
});

/**
 * Raw wire encoders for the three variants whose public builder throws
 * `FeatureDisabledError` (48, 49, 52). They exist so the reference vectors in
 * `test/vectors.json` can be asserted; `src/transaction.js` and
 * `XerisClient.sendInstruction` refuse their variant indices, so the bytes
 * cannot be submitted through this SDK. Not re-exported from `index.js`.
 * @type {Readonly<{zkPrivateTransfer: Function, zkIdentityProof: Function, pqSignedTransfer: Function}>}
 */
const _raw = Object.freeze({
  zkPrivateTransfer: rawZkPrivateTransfer,
  zkIdentityProof: rawZkIdentityProof,
  pqSignedTransfer: rawPqSignedTransfer,
});

module.exports = { zkpq, _raw, buildPqRotationMessage };
