const crypto = require('crypto');

const METADATA_STANDARD_VERSION = '1.0.0';
const IPFS_GATEWAY = process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/';
const ARWEAVE_GATEWAY = process.env.ARWEAVE_GATEWAY || 'https://arweave.net/';

const buildMetadata = (token) => ({
  name: token.name || token.symbol,
  symbol: token.symbol,
  description: token.description || '',
  image: token.image || '',
  external_url: token.externalUrl || (process.env.BASE_URL + '/tokens/' + token.symbol),
  attributes: [
    { trait_type: 'Property Type', value: token.propertyType || 'Commercial' },
    { trait_type: 'Location', value: token.location || 'Singapore' },
    { trait_type: 'Total Supply', value: String(token.totalSupply || 0) },
    { trait_type: 'Price per Token', value: (token.pricePerToken || 0) + ' SGD' },
  ],
  background_color: token.backgroundColor || '000000',
  animation_url: token.animationUrl || '',
  youtube_url: token.youtubeUrl || '',
});

const generateMetadataHash = (metadata) => {
  const sorted = JSON.stringify(metadata, Object.keys(metadata).sort());
  return '0x' + crypto.createHash('sha256').update(sorted).digest('hex');
};

const validateMetadata = (metadata) => {
  const required = ['name', 'description', 'image'];
  const missing = required.filter(k => !metadata[k]);
  if (missing.length) return { valid: false, errors: ['Missing: ' + missing.join(', ')] };
  return { valid: true };
};

const resolveIpfsUrl = (uri) => {
  if (!uri) return '';
  if (uri.startsWith('ipfs://')) return IPFS_GATEWAY + uri.slice(7);
  if (uri.startsWith('ar://')) return ARWEAVE_GATEWAY + uri.slice(5);
  return uri;
};

module.exports = { buildMetadata, generateMetadataHash, validateMetadata, resolveIpfsUrl, METADATA_STANDARD_VERSION };
