// GERADO por scripts/sync-onchain.mjs a partir de verum-otc-onchain/packages/router/src/abi/VerumOTCEscrowTron.abi.json
// NÃO EDITAR À MÃO — alterações devem ser feitas no repo de origem e re-sincronizadas.
export default [
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "tronChainId",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "owner_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "guardian_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "attestor_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "treasury_",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "ConfigNotPending",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint8",
        "name": "onchain",
        "type": "uint8"
      },
      {
        "internalType": "uint8",
        "name": "provided",
        "type": "uint8"
      }
    ],
    "name": "DecimalsMismatch",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "DuplicateWallet",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "Expired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "FeeTooHigh",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidAmount",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "wallet",
        "type": "address"
      }
    ],
    "name": "InvalidAttestation",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint16",
        "name": "provided",
        "type": "uint16"
      },
      {
        "internalType": "uint16",
        "name": "expected",
        "type": "uint16"
      }
    ],
    "name": "InvalidFee",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "enum VerumOTCEscrowBase.Role",
        "name": "role",
        "type": "uint8"
      }
    ],
    "name": "InvalidSignature",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "enum VerumOTCEscrowBase.State",
        "name": "current",
        "type": "uint8"
      },
      {
        "internalType": "enum VerumOTCEscrowBase.State",
        "name": "expected",
        "type": "uint8"
      }
    ],
    "name": "InvalidState",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidTermsVersion",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidTimestamps",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NonceAlreadyUsed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotExpired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotGuardian",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotOwner",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "enum VerumOTCEscrowBase.Role",
        "name": "expected",
        "type": "uint8"
      }
    ],
    "name": "NotParticipant",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotPaused",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PausedError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReentrancyGuardReentrantCall",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      }
    ],
    "name": "SafeERC20FailedOperation",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SameAsset",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TimelockNotElapsed",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      }
    ],
    "name": "TokenNotAuthorized",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TradeAlreadyExists",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TradeNotFound",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "expected",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "received",
        "type": "uint256"
      }
    ],
    "name": "TransferAmountMismatch",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "expected",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "actual",
        "type": "uint256"
      }
    ],
    "name": "WrongChain",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroAddress",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "buyer",
        "type": "address"
      }
    ],
    "name": "BuyerSigned",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint16",
        "name": "feeBps",
        "type": "uint16"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "treasury",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "attestor",
        "type": "address"
      }
    ],
    "name": "ConfigurationChanged",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint16",
        "name": "feeBps",
        "type": "uint16"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "treasury",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "attestor",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "executableAt",
        "type": "uint64"
      }
    ],
    "name": "ConfigurationProposed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "from",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "asset",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "enum VerumOTCEscrowBase.Role",
        "name": "role",
        "type": "uint8"
      }
    ],
    "name": "DepositReceived",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "by",
        "type": "address"
      }
    ],
    "name": "EmergencyPaused",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "by",
        "type": "address"
      }
    ],
    "name": "EmergencyUnpaused",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "asset",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "treasury",
        "type": "address"
      }
    ],
    "name": "FeeCollected",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "previousGuardian",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "newGuardian",
        "type": "address"
      }
    ],
    "name": "GuardianChanged",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "previousOwner",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "newOwner",
        "type": "address"
      }
    ],
    "name": "OwnershipTransferred",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "wallet",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "enum VerumOTCEscrowBase.Role",
        "name": "role",
        "type": "uint8"
      }
    ],
    "name": "ParticipantAuthorized",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "paymaster",
        "type": "address"
      }
    ],
    "name": "Paymaster01Signed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "paymaster",
        "type": "address"
      }
    ],
    "name": "Paymaster02Signed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "asset",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "RefundExecuted",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "seller",
        "type": "address"
      }
    ],
    "name": "SellerSigned",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      }
    ],
    "name": "SettlementReady",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "decimals",
        "type": "uint8"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "symbol",
        "type": "string"
      },
      {
        "indexed": false,
        "internalType": "uint32",
        "name": "registryVersion",
        "type": "uint32"
      }
    ],
    "name": "TokenAdded",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint32",
        "name": "registryVersion",
        "type": "uint32"
      }
    ],
    "name": "TokenRemoved",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint32",
        "name": "registryVersion",
        "type": "uint32"
      }
    ],
    "name": "TokenSuspended",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "seller",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "buyer",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "paymaster01",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "paymaster02",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "sellerAsset",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "sellerAmount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "buyerAsset",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "buyerAmount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "feeAmount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "createdAt",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "expiresAt",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "termsHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "nonce",
        "type": "uint256"
      }
    ],
    "name": "TradeCreated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "expiredAt",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "executor",
        "type": "address"
      }
    ],
    "name": "TradeExpired",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "settledAt",
        "type": "uint64"
      }
    ],
    "name": "TradeSettled",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "APPROVAL_TYPEHASH",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "BPS_DENOMINATOR",
    "outputs": [
      {
        "internalType": "uint16",
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "CONFIG_TIMELOCK",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "CREATION_WINDOW",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "DEFAULT_PLATFORM_FEE_BPS",
    "outputs": [
      {
        "internalType": "uint16",
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "EIP712_DOMAIN_TYPEHASH",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_PLATFORM_FEE_BPS",
    "outputs": [
      {
        "internalType": "uint16",
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "NAME",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "TERMS_TYPEHASH",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "TERMS_VERSION",
    "outputs": [
      {
        "internalType": "uint32",
        "name": "",
        "type": "uint32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "TRADE_DURATION",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "TRON_CHAIN_ID",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "VERSION",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "WALLET_ATTESTATION_TYPEHASH",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "internalType": "uint8",
        "name": "decimals_",
        "type": "uint8"
      },
      {
        "internalType": "string",
        "name": "symbol_",
        "type": "string"
      }
    ],
    "name": "addToken",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "applyConfig",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "termsHash",
        "type": "bytes32"
      },
      {
        "internalType": "enum VerumOTCEscrowBase.Role",
        "name": "role",
        "type": "uint8"
      },
      {
        "internalType": "uint64",
        "name": "deadline",
        "type": "uint64"
      }
    ],
    "name": "approvalDigest",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "wallet",
        "type": "address"
      },
      {
        "internalType": "uint64",
        "name": "validUntil",
        "type": "uint64"
      }
    ],
    "name": "attestationDigest",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "attestor",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "internalType": "uint64",
        "name": "deadline",
        "type": "uint64"
      },
      {
        "internalType": "bytes",
        "name": "signature",
        "type": "bytes"
      }
    ],
    "name": "buyerSign",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "internalType": "uint64",
        "name": "deadline",
        "type": "uint64"
      },
      {
        "internalType": "bytes",
        "name": "signature",
        "type": "bytes"
      }
    ],
    "name": "buyerSignAndSettle",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "cancelConfig",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "sellerAmount",
        "type": "uint256"
      },
      {
        "internalType": "uint16",
        "name": "feeBps",
        "type": "uint16"
      }
    ],
    "name": "computeFee",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "termsHash",
        "type": "bytes32"
      }
    ],
    "name": "computeTradeId",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "seller",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "buyer",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "paymaster01",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "paymaster02",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "sellerAsset",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "sellerAmount",
            "type": "uint256"
          },
          {
            "internalType": "address",
            "name": "buyerAsset",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "buyerAmount",
            "type": "uint256"
          },
          {
            "internalType": "uint16",
            "name": "platformFeeBps",
            "type": "uint16"
          },
          {
            "internalType": "uint16",
            "name": "commissionBps",
            "type": "uint16"
          },
          {
            "internalType": "uint16",
            "name": "discountBps",
            "type": "uint16"
          },
          {
            "internalType": "uint16",
            "name": "slippageBps",
            "type": "uint16"
          },
          {
            "internalType": "uint64",
            "name": "createdAt",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "expiresAt",
            "type": "uint64"
          },
          {
            "internalType": "uint32",
            "name": "termsVersion",
            "type": "uint32"
          },
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          }
        ],
        "internalType": "struct VerumOTCEscrowBase.Terms",
        "name": "t",
        "type": "tuple"
      },
      {
        "components": [
          {
            "internalType": "uint64",
            "name": "validUntil",
            "type": "uint64"
          },
          {
            "internalType": "bytes",
            "name": "signature",
            "type": "bytes"
          }
        ],
        "internalType": "struct VerumOTCEscrowBase.WalletAttestation[4]",
        "name": "attestations",
        "type": "tuple[4]"
      }
    ],
    "name": "createTrade",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "domainSeparator",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      }
    ],
    "name": "expireAndRefund",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      }
    ],
    "name": "expireTrade",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      }
    ],
    "name": "getState",
    "outputs": [
      {
        "internalType": "enum VerumOTCEscrowBase.State",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      }
    ],
    "name": "getToken",
    "outputs": [
      {
        "components": [
          {
            "internalType": "enum VerumOTCEscrowBase.TokenStatus",
            "name": "status",
            "type": "uint8"
          },
          {
            "internalType": "uint8",
            "name": "decimals",
            "type": "uint8"
          },
          {
            "internalType": "uint32",
            "name": "registryVersion",
            "type": "uint32"
          },
          {
            "internalType": "uint64",
            "name": "activatedAt",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "updatedAt",
            "type": "uint64"
          },
          {
            "internalType": "string",
            "name": "symbol",
            "type": "string"
          }
        ],
        "internalType": "struct VerumOTCEscrowBase.TokenInfo",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      }
    ],
    "name": "getTrade",
    "outputs": [
      {
        "components": [
          {
            "components": [
              {
                "internalType": "address",
                "name": "seller",
                "type": "address"
              },
              {
                "internalType": "address",
                "name": "buyer",
                "type": "address"
              },
              {
                "internalType": "address",
                "name": "paymaster01",
                "type": "address"
              },
              {
                "internalType": "address",
                "name": "paymaster02",
                "type": "address"
              },
              {
                "internalType": "address",
                "name": "sellerAsset",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "sellerAmount",
                "type": "uint256"
              },
              {
                "internalType": "address",
                "name": "buyerAsset",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "buyerAmount",
                "type": "uint256"
              },
              {
                "internalType": "uint16",
                "name": "platformFeeBps",
                "type": "uint16"
              },
              {
                "internalType": "uint16",
                "name": "commissionBps",
                "type": "uint16"
              },
              {
                "internalType": "uint16",
                "name": "discountBps",
                "type": "uint16"
              },
              {
                "internalType": "uint16",
                "name": "slippageBps",
                "type": "uint16"
              },
              {
                "internalType": "uint64",
                "name": "createdAt",
                "type": "uint64"
              },
              {
                "internalType": "uint64",
                "name": "expiresAt",
                "type": "uint64"
              },
              {
                "internalType": "uint32",
                "name": "termsVersion",
                "type": "uint32"
              },
              {
                "internalType": "uint256",
                "name": "nonce",
                "type": "uint256"
              }
            ],
            "internalType": "struct VerumOTCEscrowBase.Terms",
            "name": "terms",
            "type": "tuple"
          },
          {
            "internalType": "bytes32",
            "name": "termsHash",
            "type": "bytes32"
          },
          {
            "internalType": "enum VerumOTCEscrowBase.State",
            "name": "state",
            "type": "uint8"
          },
          {
            "internalType": "bool",
            "name": "sellerDeposited",
            "type": "bool"
          },
          {
            "internalType": "bool",
            "name": "buyerDeposited",
            "type": "bool"
          },
          {
            "internalType": "bool",
            "name": "feeCollected",
            "type": "bool"
          },
          {
            "internalType": "uint256",
            "name": "feeAmount",
            "type": "uint256"
          },
          {
            "internalType": "uint64",
            "name": "settledAt",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "expiredAt",
            "type": "uint64"
          }
        ],
        "internalType": "struct VerumOTCEscrowBase.Trade",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "guardian",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "seller",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "buyer",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "paymaster01",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "paymaster02",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "sellerAsset",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "sellerAmount",
            "type": "uint256"
          },
          {
            "internalType": "address",
            "name": "buyerAsset",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "buyerAmount",
            "type": "uint256"
          },
          {
            "internalType": "uint16",
            "name": "platformFeeBps",
            "type": "uint16"
          },
          {
            "internalType": "uint16",
            "name": "commissionBps",
            "type": "uint16"
          },
          {
            "internalType": "uint16",
            "name": "discountBps",
            "type": "uint16"
          },
          {
            "internalType": "uint16",
            "name": "slippageBps",
            "type": "uint16"
          },
          {
            "internalType": "uint64",
            "name": "createdAt",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "expiresAt",
            "type": "uint64"
          },
          {
            "internalType": "uint32",
            "name": "termsVersion",
            "type": "uint32"
          },
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          }
        ],
        "internalType": "struct VerumOTCEscrowBase.Terms",
        "name": "t",
        "type": "tuple"
      }
    ],
    "name": "hashTerms",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      }
    ],
    "name": "isTokenActive",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "name": "nonceUsed",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "owner",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "pause",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "paused",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "internalType": "uint64",
        "name": "deadline",
        "type": "uint64"
      },
      {
        "internalType": "bytes",
        "name": "signature",
        "type": "bytes"
      }
    ],
    "name": "paymaster01Sign",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "internalType": "uint64",
        "name": "deadline",
        "type": "uint64"
      },
      {
        "internalType": "bytes",
        "name": "signature",
        "type": "bytes"
      }
    ],
    "name": "paymaster02Sign",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "pendingConfig",
    "outputs": [
      {
        "internalType": "uint16",
        "name": "feeBps",
        "type": "uint16"
      },
      {
        "internalType": "address",
        "name": "treasury",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "attestor",
        "type": "address"
      },
      {
        "internalType": "uint64",
        "name": "executableAt",
        "type": "uint64"
      },
      {
        "internalType": "bool",
        "name": "exists",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "platformFeeBps",
    "outputs": [
      {
        "internalType": "uint16",
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint16",
        "name": "feeBps",
        "type": "uint16"
      },
      {
        "internalType": "address",
        "name": "treasury_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "attestor_",
        "type": "address"
      }
    ],
    "name": "proposeConfig",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      }
    ],
    "name": "refund",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "registryVersion",
    "outputs": [
      {
        "internalType": "uint32",
        "name": "",
        "type": "uint32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      }
    ],
    "name": "removeToken",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      },
      {
        "internalType": "uint64",
        "name": "deadline",
        "type": "uint64"
      },
      {
        "internalType": "bytes",
        "name": "signature",
        "type": "bytes"
      }
    ],
    "name": "sellerSign",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "newGuardian",
        "type": "address"
      }
    ],
    "name": "setGuardian",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "tradeId",
        "type": "bytes32"
      }
    ],
    "name": "settle",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      }
    ],
    "name": "suspendToken",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "newOwner",
        "type": "address"
      }
    ],
    "name": "transferOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "treasury",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "unpause",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];
