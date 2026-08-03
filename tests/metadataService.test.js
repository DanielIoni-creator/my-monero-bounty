'use strict';

/**
 * Unit tests for metadataService. Runs under Node's built-in test runner
 * (`node --test`) so no external dev dependencies are required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMetadata,
  generateMetadataHash,
  validateMetadata,
  resolveIpfsUrl,
  resolveArweaveTxUrl,
  canonicalize,
  createStubPinner,
  SCHEMA_VERSION,
} = require('../services/metadataService');

test('SCHEMA_VERSION is a semver string', () => {
  assert.match(SCHEMA_VERSION, /^\d+\.\d+\.\d+$/);
});

test('buildMetadata produces an OpenSea-shaped object', () => {
  const token = {
    name: 'Marina Bay Financial Tower',
    symbol: 'MBFT',
    description: 'Prime commercial property at Marina Bay, Singapore',
    image: 'ipfs://QmX...',
    propertyType: 'Commercial',
    location: 'Marina Bay, Singapore',
    totalSupply: 8000,
    tokenPriceSGD: 1000,
    valuationSGD: 8000000,
    annualYield: 4.5,
  };

  const metadata = buildMetadata(token);

  assert.equal(metadata.name, 'Marina Bay Financial Tower');
  assert.equal(metadata.symbol, 'MBFT');
  assert.equal(metadata.description, 'Prime commercial property at Marina Bay, Singapore');
  assert.equal(metadata.image, 'ipfs://QmX...');
  assert.equal(metadata.decimals, 18);
  assert.equal(metadata.properties.category, 'real-estate');
  assert.ok(Array.isArray(metadata.attributes));
  assert.ok(metadata.attributes.some((a) => a.trait_type === 'Property Type' && a.value === 'Commercial'));
  assert.ok(metadata.attributes.some((a) => a.trait_type === 'Total Supply' && a.value === '8000' && a.display_type === 'number'));
  assert.ok(metadata.attributes.some((a) => a.trait_type === 'Annual Yield' && a.display_type === 'boost_percentage'));
});

test('buildMetadata falls back to symbol for name when name is missing', () => {
  const metadata = buildMetadata({ symbol: 'XYZ', description: '', image: '' });
  assert.equal(metadata.name, 'XYZ');
});

test('buildMetadata throws on non-object input', () => {
  assert.throws(() => buildMetadata(null), TypeError);
  assert.throws(() => buildMetadata('not-an-object'), TypeError);
});

test('generateMetadataHash is deterministic for semantically equal objects', () => {
  const a = { name: 'T', symbol: 'T', description: 'd', image: 'i', attributes: [{ trait_type: 'x', value: '1' }] };
  const b = { image: 'i', description: 'd', symbol: 'T', name: 'T', attributes: [{ value: '1', trait_type: 'x' }] };
  assert.equal(generateMetadataHash(a), generateMetadataHash(b));
  assert.match(generateMetadataHash(a), /^0x[0-9a-f]{64}$/);
});

test('generateMetadataHash changes when content changes', () => {
  const a = { name: 'A', description: 'd', image: 'i' };
  const b = { name: 'B', description: 'd', image: 'i' };
  assert.notEqual(generateMetadataHash(a), generateMetadataHash(b));
});

test('validateMetadata accepts a complete ERC-1155 object', () => {
  const token = {
    name: 'Marina Bay Financial Tower',
    symbol: 'MBFT',
    description: 'Prime commercial property',
    image: 'ipfs://QmX...',
    propertyType: 'Commercial',
    location: 'Marina Bay',
    totalSupply: 8000,
    tokenPriceSGD: 1000,
    valuationSGD: 8000000,
    annualYield: 4.5,
  };
  const result = validateMetadata(buildMetadata(token));
  assert.deepEqual(result, { valid: true });
});

test('validateMetadata rejects missing required fields', () => {
  const result = validateMetadata({ name: 'x' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('description')));
  assert.ok(result.errors.some((e) => e.includes('image')));
});

test('validateMetadata rejects non-object input', () => {
  assert.equal(validateMetadata(null).valid, false);
  assert.equal(validateMetadata('hi').valid, false);
  assert.equal(validateMetadata([]).valid, false);
});

test('validateMetadata rejects malformed attributes', () => {
  const metadata = {
    name: 'n', description: 'd', image: 'i',
    attributes: [{ value: 'no trait_type' }, { trait_type: 'ok', value: 'v', display_type: 'weird' }],
  };
  const result = validateMetadata(metadata);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('trait_type')));
  assert.ok(result.errors.some((e) => e.includes('display_type')));
});

test('validateMetadata rejects bad background_color and decimals', () => {
  const meta = { name: 'n', description: 'd', image: 'i', background_color: 'zzz', decimals: 999 };
  const result = validateMetadata(meta);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('background_color')));
  assert.ok(result.errors.some((e) => e.includes('decimals')));
});

test('resolveIpfsUrl dispatches ipfs:// and ar:// to configured gateways', () => {
  assert.equal(resolveIpfsUrl('ipfs://QmABC'), 'https://ipfs.io/ipfs/QmABC');
  assert.equal(resolveIpfsUrl('ar://TXID'), 'https://arweave.net/TXID');
  assert.equal(resolveIpfsUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(resolveIpfsUrl(''), '');
});

test('resolveArweaveTxUrl builds the raw transaction URL', () => {
  assert.equal(resolveArweaveTxUrl('TXID'), 'https://arweave.net/tx/TXID');
  assert.equal(resolveArweaveTxUrl(''), '');
});

test('canonicalize produces stable JSON for unordered keys', () => {
  const a = canonicalize({ b: 1, a: 2 });
  const b = canonicalize({ a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1}');
});

test('createStubPinner returns a deterministic ipfs:// uri based on the hash', async () => {
  const ref = { value: null };
  const pinner = createStubPinner(ref);
  const metadata = buildMetadata({
    name: 'PinTest', symbol: 'PT', description: 'd', image: 'ipfs://x',
  });
  const receipt = await pinner.pin(metadata);
  assert.equal(receipt.provider, 'stub');
  assert.ok(receipt.uri.startsWith('ipfs://'));
  assert.ok(/^ipfs:\/\/[0-9a-f]{64}$/.test(receipt.uri));
  assert.equal(ref.value, metadata);
});
