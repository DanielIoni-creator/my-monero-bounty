# Token Metadata Service

Implements the OpenSea / ERC-1155 metadata JSON schema for token
metadata, with:

- `buildMetadata(token)` — produce a schema-compliant JSON object from a
  partial token record.
- `validateMetadata(metadata)` — strict validator that returns
  machine-readable errors instead of throwing.
- `generateMetadataHash(metadata)` — deterministic SHA-256 hash of the
  canonical JSON form, suitable for integrity verification.
- `resolveIpfsUrl(uri)` / `resolveArweaveTxUrl(txId)` — gateway URL
  resolution for `ipfs://...` and `ar://...` URIs.
- `createStubPinner(ref)` — adapter interface for pin/upload backends;
  the production path plugs in a real web3.storage / Pinata / Bundlr
  client.

Run the unit tests with the built-in Node test runner:

```
node --test tests/metadataService.test.js
```

Environment variables (optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `IPFS_GATEWAY` | `https://ipfs.io/ipfs/` | Public gateway used by `resolveIpfsUrl` for `ipfs://...` |
| `ARWEAVE_GATEWAY` | `https://arweave.net/` | Public gateway used by `resolveIpfsUrl` for `ar://...` |
| `ARWEAVE_TX_GATEWAY` | `https://arweave.net/tx/` | Raw transaction URL used by `resolveArweaveTxUrl` |
| `BASE_URL` | `''` | Used to build `external_url` when not supplied on the token |

Reference: OpenSea metadata standard and
[ERC-1155 Metadata JSON Schema](https://eips.ethereum.org/EIPS/eip-1155#metadata).
