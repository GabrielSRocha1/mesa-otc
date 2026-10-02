// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/registry/src/registry.testnet.json
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
export default {
  "version": 1,
  "updatedAt": "2026-10-02",
  "_aviso": "Registry de TESTNET — nunca usar em mainnet. Endereços de mocks (anvil/Sepolia) e mints devnet são preenchidos pelos deploys locais (ver scripts/deploy). O USDT da Nile é o token de faucet amplamente usado; conferir decimals=6 on-chain antes de registrar. assertMainnetReady() deve continuar FALHANDO para este arquivo.",
  "tokens": [
    {
      "chainId": 31337,
      "address": "0x0000000000000000000000000000000000000000",
      "decimals": 6,
      "symbol": "tUSDT",
      "status": "ACTIVE",
      "registryVersion": 1,
      "activatedAt": 1790000000,
      "updatedAt": 1790000000,
      "verifiedAgainstIssuer": false,
      "_placeholder": "preenchido pelo deploy do MockERC20 no anvil"
    },
    {
      "chainId": 31337,
      "address": "0x0000000000000000000000000000000000000001",
      "decimals": 8,
      "symbol": "tBTC",
      "status": "ACTIVE",
      "registryVersion": 1,
      "activatedAt": 1790000000,
      "updatedAt": 1790000000,
      "verifiedAgainstIssuer": false,
      "_placeholder": "preenchido pelo deploy do MockERC20 no anvil"
    },
    {
      "chainId": 11155111,
      "address": "0x0000000000000000000000000000000000000000",
      "decimals": 6,
      "symbol": "tUSDT",
      "status": "ACTIVE",
      "registryVersion": 1,
      "activatedAt": 1790000000,
      "updatedAt": 1790000000,
      "verifiedAgainstIssuer": false,
      "_placeholder": "MockERC20 próprio em Sepolia — nunca usar 'test USDT' de terceiros"
    },
    {
      "chainId": 11155111,
      "address": "0x0000000000000000000000000000000000000001",
      "decimals": 8,
      "symbol": "tBTC",
      "status": "ACTIVE",
      "registryVersion": 1,
      "activatedAt": 1790000000,
      "updatedAt": 1790000000,
      "verifiedAgainstIssuer": false,
      "_placeholder": "MockERC20 próprio em Sepolia"
    },
    {
      "chainId": 103,
      "address": "11111111111111111111111111111111",
      "tokenProgram": "TOKEN",
      "decimals": 6,
      "symbol": "tUSDT",
      "status": "ACTIVE",
      "registryVersion": 1,
      "activatedAt": 1790000000,
      "updatedAt": 1790000000,
      "verifiedAgainstIssuer": false,
      "_placeholder": "mint devnet criado com spl-token create-token --decimals 6"
    },
    {
      "chainId": 103,
      "address": "11111111111111111111111111111112",
      "tokenProgram": "TOKEN",
      "decimals": 8,
      "symbol": "tBTC",
      "status": "ACTIVE",
      "registryVersion": 1,
      "activatedAt": 1790000000,
      "updatedAt": 1790000000,
      "verifiedAgainstIssuer": false,
      "_placeholder": "mint devnet criado com spl-token create-token --decimals 8"
    },
    {
      "chainId": 3448148188,
      "address": "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj",
      "decimals": 6,
      "symbol": "USDT",
      "status": "ACTIVE",
      "registryVersion": 1,
      "activatedAt": 1790000000,
      "updatedAt": 1790000000,
      "verifiedAgainstIssuer": false
    }
  ]
};
