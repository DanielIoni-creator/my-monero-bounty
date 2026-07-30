'use strict';

/**
 * Token Metadata Service.
 *
 * Implements the OpenSea / ERC-1155 metadata JSON schema for token
 * metadata, with pluggable IPFS and Arweave URL resolution, deterministic
 * SHA-256 content hashing for integrity verification, and a strict
 * validator that returns machine-readable errors instead of throwing.
 *
 * The service is intentionally side-effect free: it never makes a network
 * call. Pinning/upload is delegated to a backend adapter so the same
 * metadata shape can be targeted at IPFS (web3.storage / Pinata /
 * ipfs-http-client) or Arweave (Bundlr / Turbo) without changing the
 * caller.
 *
 * Reference: OpenSea metadata standard and ERC-1155 Metadata JSON Schema.
 *   https://docs.opensea.io/docs/metadata-standards
 *   https://eips.ethereum.org/EIPS/eip-1155#metadata
 */

const crypto = require('crypto');

const SCHEMA_VERSION = '1.0.0';

const IPFS_SCHEME = 'ipfs://';
const ARWEAVE_SCHEME = 'ar://';

const IPFS_GATEWAY = (process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/').replace(/\/?$/, '/');
const ARWEAVE_GATEWAY = (process.env.ARWEAVE_GATEWAY || 'https://arweave.net/').replace(/\/?$/, '/');
const ARWEAVE_TX_GATEWAY = (process.env.ARWEAVE_TX_GATEWAY || 'https://arweave.net/tx/').replace(/\/?$/, '/');
const BASE_URL = (process.env.BASE_URL || '').replace(/\/?$/, '');

// ERC-1155 / OpenSea trait allowed attribute shape.
const ALLOWED_ATTRIBUTE_KEYS = ['trait_type', 'value', 'display_type', 'max_value'];
const ALLOWED_DISPLAY_TYPES = [
  null,
  'number',
  'boost_number',
  'boost_percentage',
  'date',
  'string',
];

/**
 * Build ERC-1155 / OpenSea compliant metadata from a partial token input.
 * The output is a plain JSON-serializable object. Unknown input fields are
 * dropped; required-but-missing fields are filled with safe defaults so the
 * validator can flag real gaps.
 */
function buildMetadata(token) {
  if (!token || typeof token !== 'object') {
    throw new TypeError('buildMetadata: token must be an object');
  }

  const symbol = token.symbol ? String(token.symbol) : '';
  const fallbackName = symbol || 'Token';

  const metadata = {
    name: token.name ? String(token.name) : fallbackName,
    symbol,
    description: token.description ? String(token.description) : '',
    image: token.image ? String(token.image) : '',
    external_url: token.externalUrl
      ? String(token.externalUrl)
      : (BASE_URL && symbol ? `${BASE_URL}/tokens/${symbol}` : ''),
    attributes: buildAttributes(token),
    properties: buildProperties(token),
    decimals: Number.isInteger(token.decimals) ? token.decimals : 18,
  };

  // Optional common OpenSea extensions (only present when supplied).
  if (token.backgroundColor) metadata.background_color = String(token.backgroundColor);
  if (token.animationUrl) metadata.animation_url = String(token.animationUrl);
  if (token.youtubeUrl) metadata.youtube_url = String(token.youtubeUrl);

  return metadata;
}

function buildAttributes(token) {
  const attributes = [];
  const push = (trait_type, value, display_type) => {
    if (value === undefined || value === null || value === '') return;
    const attr = { trait_type, value };
    if (display_type) attr.display_type = display_type;
    attributes.push(attr);
  };

  push('Property Type', token.propertyType);
  push('Location', token.location);
  push('Annual Yield', token.annualYield, 'boost_percentage');
  push('Total Supply', token.totalSupply ? toString(token.totalSupply) : undefined, 'number');
  push('Token Price (SGD)', token.tokenPriceSGD ? toString(token.tokenPriceSGD) : undefined, 'number');
  push('Valuation (SGD)', token.valuationSGD ? toString(token.valuationSGD) : undefined, 'number');

  if (Array.isArray(token.extraAttributes)) {
    for (const extra of token.extraAttributes) {
      if (!extra || typeof extra !== 'object') continue;
      const trait = extra.trait_type != null ? String(extra.trait_type) : null;
      if (!trait) continue;
      attributes.push({
        trait_type: trait,
        value: extra.value != null ? extra.value : '',
        ...(extra.display_type ? { display_type: String(extra.display_type) } : {}),
      });
    }
  }

  return attributes;
}

function buildProperties(token) {
  const files = [];
  if (token.image) {
    files.push({ uri: String(token.image), type: detectMimeType(token.image) });
  }
  if (Array.isArray(token.files)) {
    for (const f of token.files) {
      if (!f || typeof f !== 'object' || !f.uri) continue;
      files.push({ uri: String(f.uri), type: f.type ? String(f.type) : detectMimeType(f.uri) });
    }
  }
  return {
    files,
    category: token.category ? String(token.category) : 'real-estate',
  };
}

function detectMimeType(uri) {
  const u = String(uri).toLowerCase();
  if (u.endsWith('.png')) return 'image/png';
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg';
  if (u.endsWith('.gif')) return 'image/gif';
  if (u.endsWith('.webp')) return 'image/webp';
  if (u.endsWith('.svg')) return 'image/svg+xml';
  if (u.endsWith('.mp4')) return 'video/mp4';
  if (u.endsWith('.pdf')) return 'application/pdf';
  return '';
}

/**
 * Deterministic SHA-256 hash of the canonical metadata JSON. The canonical
 * form is JSON.stringify with object keys sorted recursively so that two
 * equivalent metadata objects produce the same hash.
 */
function generateMetadataHash(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    throw new TypeError('generateMetadataHash: metadata must be an object');
  }
  const canonical = canonicalize(metadata);
  return '0x' + crypto.createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

/**
 * Resolve a URI in `ipfs://CID[/path]` or `ar://TXID` form to a public
 * gateway URL. Returns the input unchanged when it is neither scheme.
 */
function resolveIpfsUrl(uri) {
  if (!uri || typeof uri !== 'string') return '';
  if (uri.startsWith(IPFS_SCHEME)) return IPFS_GATEWAY + uri.slice(IPFS_SCHEME.length);
  if (uri.startsWith(ARWEAVE_SCHEME)) return ARWEAVE_GATEWAY + uri.slice(ARWEAVE_SCHEME.length);
  return uri;
}

function resolveArweaveTxUrl(txId) {
  if (!txId || typeof txId !== 'string') return '';
  return ARWEAVE_TX_GATEWAY + txId;
}

/**
 * Validate a metadata object against the OpenSea / ERC-1155 schema. Returns
 * `{ valid: true }` on success or `{ valid: false, errors: [...] }` with
 * one human-readable error string per failed check.
 */
function validateMetadata(metadata) {
  const errors = [];

  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { valid: false, errors: ['metadata must be a JSON object'] };
  }

  // Required string fields.
  for (const key of ['name', 'description', 'image']) {
    if (typeof metadata[key] !== 'string' || metadata[key].trim() === '') {
      errors.push(`missing required string field: ${key}`);
    }
  }

  // Optional but typed string fields.
  if (metadata.external_url !== undefined && typeof metadata.external_url !== 'string') {
    errors.push('external_url must be a string when present');
  }
  if (metadata.background_color !== undefined && !/^[0-9a-fA-F]{6}$/.test(metadata.background_color)) {
    errors.push('background_color must be a 6-character hex string when present');
  }

  if (metadata.decimals !== undefined && !(Number.isInteger(metadata.decimals) && metadata.decimals >= 0 && metadata.decimals <= 255)) {
    errors.push('decimals must be an integer in [0, 255] when present');
  }

  // Attributes.
  if (metadata.attributes !== undefined) {
    if (!Array.isArray(metadata.attributes)) {
      errors.push('attributes must be an array when present');
    } else {
      metadata.attributes.forEach((attr, i) => {
        if (!attr || typeof attr !== 'object' || Array.isArray(attr)) {
          errors.push(`attributes[${i}] must be an object`);
          return;
        }
        const unknown = Object.keys(attr).filter((k) => !ALLOWED_ATTRIBUTE_KEYS.includes(k));
        if (unknown.length) {
          errors.push(`attributes[${i}] has unknown keys: ${unknown.join(', ')}`);
        }
        if (typeof attr.trait_type !== 'string' || attr.trait_type.trim() === '') {
          errors.push(`attributes[${i}].trait_type must be a non-empty string`);
        }
        if (attr.display_type !== undefined && !ALLOWED_DISPLAY_TYPES.includes(attr.display_type)) {
          errors.push(`attributes[${i}].display_type must be one of ${ALLOWED_DISPLAY_TYPES.join(', ')}`);
        }
      });
    }
  }

  // Properties.
  if (metadata.properties !== undefined) {
    const props = metadata.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
      errors.push('properties must be an object when present');
    } else {
      if (props.files !== undefined) {
        if (!Array.isArray(props.files)) {
          errors.push('properties.files must be an array when present');
        } else {
          props.files.forEach((f, i) => {
            if (!f || typeof f !== 'object') {
              errors.push(`properties.files[${i}] must be an object`);
              return;
            }
            if (typeof f.uri !== 'string' || f.uri.trim() === '') {
              errors.push(`properties.files[${i}].uri must be a non-empty string`);
            }
          });
        }
      }
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Pinner adapter interface. A concrete adapter is responsible for uploading
 * the JSON metadata to a decentralized backend and returning the resulting
 * URI (e.g. `ipfs://Qm...` or `ar://TXID`). The metadata service makes no
 * assumptions about the underlying network transport.
 *
 *   interface Adapter {
 *     async pin(metadata: object): Promise<{ uri: string, provider: string }>;
 *   }
 *
 * A built-in stub adapter is exposed for offline unit tests; production
 * deployments should inject a real web3.storage / Pinata / Bundlr client.
 */
function createStubPinner(receivedRef) {
  return {
    provider: 'stub',
    async pin(metadata) {
      if (receivedRef) receivedRef.value = metadata;
      return { uri: IPFS_SCHEME + generateMetadataHash(metadata).slice(2), provider: 'stub' };
    },
  };
}

function toString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

module.exports = {
  SCHEMA_VERSION,
  buildMetadata,
  generateMetadataHash,
  validateMetadata,
  resolveIpfsUrl,
  resolveArweaveTxUrl,
  canonicalize,
  createStubPinner,
};
