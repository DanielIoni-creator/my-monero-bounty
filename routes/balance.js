const express = require('express');
const router = express.Router();
const { ethers } = require('ethers');

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
];

const DEFAULT_TOKENS = [
  { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000', decimals: 18 },
  { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
  { symbol: 'WXMR', address: '0x4A5DF63a0C37B3850e7b8D0c8cC6F4Bf0eDd5C41', decimals: 18 },
];

const getProvider = () => new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://eth.llamarpc.com');

const getPrice = async (symbol) => {
  try {
    const ids = { ETH: 'ethereum', USDC: 'usd-coin', USDT: 'tether', WXMR: 'wrapped-xmr' };
    const id = ids[symbol] || symbol.toLowerCase();
    const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=' + id + '&vs_currencies=usd');
    const data = await resp.json();
    return data[id]?.usd || 0;
  } catch { return 0; }
};

router.get('/:walletAddress', async (req, res) => {
  try {
    const provider = getProvider();
    const results = [];
    for (const token of DEFAULT_TOKENS) {
      try {
        if (token.address === '0x0000000000000000000000000000000000000000') {
          const bal = await provider.getBalance(req.params.walletAddress);
          const eth = Number(ethers.formatEther(bal));
          const price = await getPrice('ETH');
          results.push({ symbol: 'ETH', name: 'Ethereum', balance: eth.toFixed(6), priceUSD: price, valueUSD: (eth * price).toFixed(2) });
        } else {
          const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
          const [bal, dec, sym, nam] = await Promise.all([contract.balanceOf(req.params.walletAddress), contract.decimals(), contract.symbol(), contract.name()]);
          const formatted = Number(ethers.formatUnits(bal, dec));
          const price = await getPrice(sym);
          results.push({ symbol: sym, name: nam, balance: formatted.toFixed(6), priceUSD: price, valueUSD: (formatted * price).toFixed(2) });
        }
      } catch { results.push({ symbol: token.symbol, error: 'Failed to fetch' }); }
    }
    res.json({ wallet: req.params.walletAddress, tokens: results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
