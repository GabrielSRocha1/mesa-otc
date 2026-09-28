// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Guarda de preço opcional (oráculo). Deve ser `view` e responder false para: stale, desvio, confiança baixa, fonte indisponível.
interface IPriceGuard { function validate(bytes32 dealIdHash, bytes32 assetInHash, bytes32 assetOutHash, uint256 referencePrice) external view returns (bool ok); }
interface IERC20Decimals { function decimals() external view returns (uint8); }

/**
 * @title VerumOtcEscrow v2 — Smart Contract Core do VERUM OTC (EVM)
 * @notice Escrow N-de-N para operações OTC. Princípio: FAIL CLOSED — qualquer condição obrigatória não satisfeita ⇒ revert, nunca liquida.
 *
 * Garantias (ver testes e invariantes):
 *  - Liquidação exige TODAS as assinaturas (3/3 ou 4/4) sobre o mesmo dealHash + termsHash, verificadas on-chain (EIP-712, domínio = chainId + este contrato).
 *  - Nenhum ator (backend, keeper, guardian, admin, Pay Master) move fundos para um destino que não seja o determinado pelos termos imutáveis do Deal.
 *  - Depois da primeira assinatura nada muda: participantes, valores, ativos, preço, rota, fees e expiração estão no termsHash assinado; alterar = novo Deal.
 *  - Um Deal liquida uma vez; nonce de Deal e nonces de assinatura são de uso único; expiração é absoluta.
 *  - Refund é permissionless, nunca pausável, e devolve ao depositante registrado. Pausa só interrompe entradas e liquidações.
 *  - Sem upgrade, sem withdraw/sweep/rescue, tesouraria de fee imutável.
 */
contract VerumOtcEscrow is EIP712, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ───────────────────────── papéis e constantes ───────────────────────── */
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE"); // keeper: register/supersede (nunca destinos/valores)
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");   // pausa de entrada/liquidação; nunca refund
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");         // registro de ativos, com timelock
    uint32 public constant CONTRACT_VERSION = 2;
    uint64 public constant EXEC_MARGIN_MS = 60_000;      // liquidação exige expiresAt − 60 s (evita liquidar no limite)
    uint64 public constant REGISTRY_TIMELOCK = 24 hours; // qualquer mudança no registro de ativos espera 24 h
    uint16 public constant MAX_FEE_BPS = 500;            // fee de protocolo ≤ 5 %
    uint16 public constant MAX_COMMISSION_BPS = 5_000;   // comissão dos Pay Masters ≤ 50 %
    uint8 public constant MAX_PARTICIPANTS = 4;
    address private constant NATIVE = address(0);

    /// @dev Mesmo struct do backend (src/engines/signature.ts EIP712_TYPES). termsHash vincula TODOS os termos críticos (§5).
    bytes32 private constant APPROVAL_TYPEHASH = keccak256(
        "DealApproval(bytes32 dealHash,bytes32 termsHash,string dealId,uint32 revision,uint8 role,address signer,string nonce,uint64 expiresAt,string assetIn,uint256 amountIn,string assetOut,uint256 amountOut,string counterparty)"
    );

    /* ───────────────────────── tipos ───────────────────────── */
    enum Status { NONE, CREATED, ASSETS_LOCKED, AWAITING_SIGNATURES, FULLY_SIGNED, VALIDATING, SETTLING, SETTLED, EXPIRED, REFUNDING, REFUNDED, CANCELLED, SUPERSEDED }

    struct AssetInfo { bool allowed; uint8 decimals; bytes32 canonicalId; }
    struct LegInput { uint8 index; address token; uint8 decimals; bytes32 canonicalId; uint256 amount; bool isPayment; }
    struct Leg { uint8 index; address token; uint256 amount; bool isPayment; bool deposited; bool settled; }
    struct RegisterInput {
        string dealId; uint32 revision; bytes32 dealHash; uint64 expiresAtMs;
        address[] participants;      // ordenados por papel: SELLER, BUYER, PAY_MASTER_1[, PAY_MASTER_2]
        LegInput[] legs;             // apenas legs desta cadeia (1 ou 2)
        bytes32 assetInHash; bytes32 assetOutHash; uint256 amountIn; uint256 amountOut; uint256 minAmountOut; uint256 referencePrice;
        uint16 discountBps; uint16 feeBps; uint16 commissionBps; uint16[2] commissionSplitBps; uint256 commissionAmount;
        bytes32 routeHash; bytes32 dealNonce; bytes32 htlcHash; bytes32 counterpartyHash; bytes32 sellerHash; // counterpartyHash = keccak(endereço do Comprador como string); sellerHash = keccak(endereço do Vendedor como string)
    }
    struct Deal {
        bytes32 dealIdHash; bytes32 dealHash; bytes32 termsHash; uint32 revision; uint64 expiresAtMs; uint64 createdAt; Status status;
        uint8 requiredSignatures; uint8 approvals; uint8 depositedCount;
        uint16 discountBps; uint16 feeBps; uint16 commissionBps; uint16[2] commissionSplitBps; uint256 commissionAmount;
        uint256 amountIn; uint256 amountOut; uint256 minAmountOut; uint256 referencePrice;
        bytes32 assetInHash; bytes32 assetOutHash; bytes32 routeHash; bytes32 dealNonce; bytes32 htlcHash; bytes32 counterpartyHash; bytes32 sellerHash;
        address[] participants; Leg[] legs; bool[4] approved;
    }

    /* ───────────────────────── estado ───────────────────────── */
    address public immutable treasury;       // fee de protocolo — fixa no deploy, ninguém altera
    IPriceGuard public immutable priceGuard; // opcional (address(0) = sem guarda on-chain; a guarda off-chain §7.3 permanece)
    mapping(bytes32 => Deal) private _deals;            // keccak256(dealId) → Deal
    mapping(bytes32 => bool) public nonceUsed;          // keccak256(dealIdHash ‖ nonce) → consumido
    mapping(bytes32 => bool) public dealNonceUsed;      // dealNonce → usado (nunca reutilizável, mesmo em outro dealId)
    mapping(address => AssetInfo) public assets;        // registro on-chain de ativos
    mapping(bytes32 => uint64) public registryEta;      // proposta → quando pode ser executada

    /* ───────────────────────── eventos (§30) ───────────────────────── */
    event DealCreated(bytes32 indexed dealIdHash, string dealId, uint32 revision, bytes32 dealHash, bytes32 termsHash, uint64 expiresAtMs, uint8 requiredSignatures);
    event ParticipantRegistered(bytes32 indexed dealIdHash, uint8 role, address indexed participant);
    event AssetLocked(bytes32 indexed dealIdHash, uint8 legIndex, address indexed from, address token, uint256 amount);
    event SignatureAdded(bytes32 indexed dealIdHash, uint8 role, address indexed signer, uint8 approvals, uint8 required);
    event FullySigned(bytes32 indexed dealIdHash);
    event ValidationStarted(bytes32 indexed dealIdHash);
    event ValidationFailed(bytes32 indexed dealIdHash, bytes32 reason);
    event SettlementStarted(bytes32 indexed dealIdHash);
    event SettlementCompleted(bytes32 indexed dealIdHash, uint32 revision, bytes32 dealHash);
    event FeeCollected(bytes32 indexed dealIdHash, address token, uint256 amount, address indexed to);
    event CommissionPaid(bytes32 indexed dealIdHash, uint8 role, address indexed payMaster, address token, uint256 amount);
    event PreimageRevealed(bytes32 indexed dealIdHash, bytes32 preimage);
    event DealExpired(bytes32 indexed dealIdHash);
    event RefundStarted(bytes32 indexed dealIdHash);
    event Refunded(bytes32 indexed dealIdHash, uint8 legIndex, address indexed to, address token, uint256 amount);
    event RefundCompleted(bytes32 indexed dealIdHash);
    event DealCancelled(bytes32 indexed dealIdHash, address indexed by);
    event DealSuperseded(bytes32 indexed dealIdHash, uint32 revision);
    event StateChanged(bytes32 indexed dealIdHash, Status from, Status to);
    event EmergencyPaused(address indexed by); event EmergencyUnpaused(address indexed by);
    event AssetScheduled(address indexed token, bool allowed, uint8 decimals, bytes32 canonicalId, uint64 eta);
    event AssetRegistered(address indexed token, bool allowed, uint8 decimals, bytes32 canonicalId);

    /* ───────────────────────── erros ───────────────────────── */
    error DealExists(); error DealNotFound(); error BadStatus(Status current); error Expired(); error NotExpired(); error NotDepositor(); error AlreadyDeposited();
    error AssetNotRegistered(address token); error AssetMismatch(address token); error BadNativeValue(); error TransferAmountMismatch(); error BadSignatureCount();
    error BadSigner(); error NonceAlreadyUsed(); error DealNonceAlreadyUsed(); error BadPreimage(); error FeeTooHigh(); error BadInput(); error TimelockPending(uint64 eta);
    error NothingToRefund(); error FundsStillEscrowed(); error BadLegParties(); error ParticipantMustBeEOA(address who); error NotParticipant(); error SignedAlready();
    error SlippageExceeded(); error PriceGuardRejected(); error AlreadyApproved(uint8 role); error NotFullySigned();

    constructor(address admin, address guardian, address registrar, address treasury_, address priceGuard_, bytes32 nativeCanonicalId) EIP712("VerumOTC", "1") {
        if (admin == address(0) || guardian == address(0) || registrar == address(0) || treasury_ == address(0)) revert BadInput();
        _grantRole(DEFAULT_ADMIN_ROLE, admin); _grantRole(ADMIN_ROLE, admin); _grantRole(GUARDIAN_ROLE, guardian); _grantRole(REGISTRAR_ROLE, registrar);
        treasury = treasury_; priceGuard = IPriceGuard(priceGuard_);
        assets[NATIVE] = AssetInfo({ allowed: true, decimals: 18, canonicalId: nativeCanonicalId });
        emit AssetRegistered(NATIVE, true, 18, nativeCanonicalId);
    }

    /* ═══════════════════════════ DealManager ═══════════════════════════ */
    /// @notice Registra os termos (keeper). O keeper não escolhe destinos: as partes das legs derivam dos papéis; fee vai à tesouraria imutável.
    function register(RegisterInput calldata inp) external whenNotPaused onlyRole(REGISTRAR_ROLE) {
        bytes32 key = keccak256(bytes(inp.dealId)); Deal storage d = _deals[key];
        if (d.status != Status.NONE) {
            if (d.status != Status.SUPERSEDED && d.status != Status.REFUNDED && d.status != Status.CANCELLED) revert DealExists();
            if (inp.revision <= d.revision) revert DealExists();
            if (d.depositedCount != 0) revert FundsStillEscrowed();
        }
        uint256 n = inp.participants.length; if (n < 3 || n > MAX_PARTICIPANTS) revert BadInput();
        if (inp.legs.length == 0 || inp.legs.length > 2) revert BadInput();
        if (inp.feeBps > MAX_FEE_BPS) revert FeeTooHigh(); if (inp.commissionBps > MAX_COMMISSION_BPS) revert FeeTooHigh();
        if (uint256(inp.discountBps) + inp.commissionBps > 10_000) revert BadInput();
        if (uint64(block.timestamp) * 1000 >= inp.expiresAtMs) revert Expired();
        if (inp.amountIn == 0 || inp.amountOut == 0 || inp.minAmountOut == 0 || inp.minAmountOut > inp.amountOut) revert BadInput();
        if (uint256(inp.commissionSplitBps[0]) + inp.commissionSplitBps[1] != inp.commissionBps) revert BadInput();
        if (n == 3 && inp.commissionSplitBps[1] != 0) revert BadInput();
        if ((inp.commissionBps == 0) != (inp.commissionAmount == 0)) revert BadInput();
        if (inp.dealNonce == bytes32(0) || dealNonceUsed[inp.dealNonce]) revert DealNonceAlreadyUsed();
        for (uint256 i = 0; i < n; i++) {
            address p = inp.participants[i]; if (p == address(0)) revert BadInput(); if (p.code.length != 0) revert ParticipantMustBeEOA(p);
            for (uint256 j = i + 1; j < n; j++) if (p == inp.participants[j]) revert BadInput();
        }
        dealNonceUsed[inp.dealNonce] = true;
        delete d.participants; delete d.legs; delete d.approved;
        d.dealIdHash = key; d.dealHash = inp.dealHash; d.revision = inp.revision; d.expiresAtMs = inp.expiresAtMs; d.createdAt = uint64(block.timestamp); d.status = Status.CREATED;
        d.requiredSignatures = uint8(n); d.approvals = 0; d.depositedCount = 0; // cast seguro: 3 <= n <= MAX_PARTICIPANTS (4), validado acima
        d.discountBps = inp.discountBps; d.feeBps = inp.feeBps; d.commissionBps = inp.commissionBps; d.commissionSplitBps = inp.commissionSplitBps; d.commissionAmount = inp.commissionAmount;
        d.amountIn = inp.amountIn; d.amountOut = inp.amountOut; d.minAmountOut = inp.minAmountOut; d.referencePrice = inp.referencePrice;
        d.assetInHash = inp.assetInHash; d.assetOutHash = inp.assetOutHash; d.routeHash = inp.routeHash; d.dealNonce = inp.dealNonce; d.htlcHash = inp.htlcHash; d.counterpartyHash = inp.counterpartyHash; d.sellerHash = inp.sellerHash;
        for (uint256 i = 0; i < n; i++) { d.participants.push(inp.participants[i]); emit ParticipantRegistered(key, uint8(i), inp.participants[i]); }
        bool payment = false; bool nonPayment = false;
        for (uint256 i = 0; i < inp.legs.length; i++) {
            LegInput calldata l = inp.legs[i]; AssetInfo storage a = assets[l.token];
            if (!a.allowed) revert AssetNotRegistered(l.token);
            if (a.decimals != l.decimals || a.canonicalId != l.canonicalId) revert AssetMismatch(l.token); // rede/contrato/decimals errados ⇒ REJECT
            if (l.isPayment) { if (payment || l.amount != inp.amountOut || a.canonicalId != inp.assetOutHash) revert BadLegParties(); payment = true; }
            else { if (nonPayment || l.amount != inp.amountIn || a.canonicalId != inp.assetInHash) revert BadLegParties(); nonPayment = true; }
            d.legs.push(Leg({ index: l.index, token: l.token, amount: l.amount, isPayment: l.isPayment, deposited: false, settled: false }));
        }
        d.termsHash = _termsHash(d);
        emit DealCreated(key, inp.dealId, inp.revision, inp.dealHash, d.termsHash, inp.expiresAtMs, uint8(n));
        emit StateChanged(key, Status.NONE, Status.CREATED);
    }

    /// @notice Invalida uma revisão antes de qualquer assinatura (o backend NÃO pode invalidar um Deal já assinado).
    function supersede(string calldata dealId, uint32 revision) external onlyRole(REGISTRAR_ROLE) {
        Deal storage d = _load(dealId); if (d.revision != revision) revert BadInput();
        if (d.status != Status.CREATED && d.status != Status.ASSETS_LOCKED) revert BadStatus(d.status);
        if (d.approvals != 0) revert SignedAlready();
        _setStatus(d, Status.SUPERSEDED); emit DealSuperseded(d.dealIdHash, revision);
    }

    /// @notice Cancelamento por um participante antes da primeira assinatura. Depois disso só expiração devolve fundos.
    function cancel(string calldata dealId) external {
        Deal storage d = _load(dealId); if (_roleOf(d, msg.sender) == type(uint8).max) revert NotParticipant();
        if (d.status != Status.CREATED && d.status != Status.ASSETS_LOCKED) revert BadStatus(d.status);
        if (d.approvals != 0) revert SignedAlready();
        _setStatus(d, Status.CANCELLED); emit DealCancelled(d.dealIdHash, msg.sender);
    }

    /* ═══════════════════════════ Escrow ═══════════════════════════ */
    /// @notice Depósito pela parte da leg (Vendedor na leg de entrega; Comprador na leg de pagamento + comissão). Valor exato, sem fee-on-transfer.
    function deposit(string calldata dealId, uint8 legPos) external payable whenNotPaused nonReentrant {
        Deal storage d = _load(dealId); if (d.status != Status.CREATED) revert BadStatus(d.status);
        if (uint64(block.timestamp) * 1000 >= d.expiresAtMs) revert Expired();
        if (legPos >= d.legs.length) revert BadInput(); Leg storage leg = d.legs[legPos];
        address from = _legFrom(d, leg); if (msg.sender != from) revert NotDepositor(); if (leg.deposited) revert AlreadyDeposited();
        uint256 due = _legDeposit(d, leg);
        if (leg.token == NATIVE) { if (msg.value != due) revert BadNativeValue(); }
        else { if (msg.value != 0) revert BadNativeValue(); uint256 before = IERC20(leg.token).balanceOf(address(this)); IERC20(leg.token).safeTransferFrom(msg.sender, address(this), due); if (IERC20(leg.token).balanceOf(address(this)) - before != due) revert TransferAmountMismatch(); }
        leg.deposited = true; d.depositedCount += 1;
        emit AssetLocked(d.dealIdHash, leg.index, msg.sender, leg.token, due);
        if (d.depositedCount == d.legs.length) _setStatus(d, Status.ASSETS_LOCKED);
    }

    /* ═══════════════════════════ SignatureValidator ═══════════════════════════ */
    /// @notice Registra a assinatura de um participante (qualquer um pode relayar; o signatário é recuperado da assinatura).
    function approve(string calldata dealId, string calldata nonce, bytes calldata signature) external whenNotPaused {
        Deal storage d = _load(dealId); _approve(d, nonce, signature);
    }
    function _approve(Deal storage d, string calldata nonce, bytes calldata signature) private {
        if (d.status != Status.ASSETS_LOCKED && d.status != Status.AWAITING_SIGNATURES) revert BadStatus(d.status);
        if (uint64(block.timestamp) * 1000 >= d.expiresAtMs) revert Expired();
        bytes32 nonceKey = keccak256(abi.encodePacked(d.dealIdHash, nonce)); if (nonceUsed[nonceKey]) revert NonceAlreadyUsed();
        uint8 role = _recoverRole(d, nonce, signature); if (role == type(uint8).max) revert BadSigner();
        if (d.approved[role]) revert AlreadyApproved(role);
        nonceUsed[nonceKey] = true; d.approved[role] = true; d.approvals += 1;
        emit SignatureAdded(d.dealIdHash, role, d.participants[role], d.approvals, d.requiredSignatures);
        if (d.status == Status.ASSETS_LOCKED) _setStatus(d, Status.AWAITING_SIGNATURES);
        if (d.approvals == d.requiredSignatures) { _setStatus(d, Status.FULLY_SIGNED); emit FullySigned(d.dealIdHash); }
    }
    /// @dev Reconstrói o struct EIP-712 a partir do STORAGE (nunca do chamador) para cada papel ainda não aprovado; devolve o papel que a assinatura prova.
    function _recoverRole(Deal storage d, string calldata nonce, bytes calldata signature) private view returns (uint8) {
        for (uint8 role = 0; role < d.requiredSignatures; role++) {
            if (d.approved[role]) continue;
            (address rec, ECDSA.RecoverError err, ) = ECDSA.tryRecover(_digestFor(d, role, nonce), signature);
            if (err == ECDSA.RecoverError.NoError && rec == d.participants[role]) return role;
        }
        return type(uint8).max;
    }
    function _digestFor(Deal storage d, uint8 role, string calldata nonce) private view returns (bytes32) {
        bytes32 structHash = keccak256(bytes.concat(
            abi.encode(APPROVAL_TYPEHASH, d.dealHash, d.termsHash, d.dealIdHash, d.revision, role, d.participants[role], keccak256(bytes(nonce))),
            abi.encode(d.expiresAtMs, d.assetInHash, d.amountIn, d.assetOutHash, d.amountOut, role == 0 ? d.counterpartyHash : d.sellerHash) // contraparte exibida: Vendedor vê o Comprador; os demais veem o Vendedor
        ));
        return _hashTypedDataV4(structHash);
    }
    /// @dev termsHash = keccak de TODOS os termos críticos (§5): id, versão, chainId, contrato, participantes, ativos, valores, preço, deságio, fees, comissão, rota, expiração, nonce, N.
    function _termsHash(Deal storage d) private view returns (bytes32) {
        address pm2 = d.participants.length == 4 ? d.participants[3] : address(0);
        bytes32 a = keccak256(abi.encode(d.dealIdHash, d.revision, block.chainid, address(this), d.participants[0], d.participants[1], d.participants[2], pm2, d.assetInHash, d.assetOutHash, d.amountIn));
        bytes32 b = keccak256(abi.encode(d.amountOut, d.minAmountOut, d.referencePrice, d.discountBps, d.feeBps, d.commissionBps, d.commissionSplitBps[0], d.commissionSplitBps[1], d.commissionAmount, d.routeHash, d.dealNonce, d.expiresAtMs, d.requiredSignatures));
        return keccak256(abi.encode(a, b));
    }

    /* ═══════════════════════════ SettlementEngine ═══════════════════════════ */
    /// @notice Liquidação atômica (permissionless). Exige FULLY_SIGNED, ativos travados, não expirada, guarda de preço e revalidação do registro.
    function settle(string calldata dealId, bytes32 preimage) external whenNotPaused nonReentrant { Deal storage d = _load(dealId); _settle(d, preimage); }
    /// @notice Conveniência para o relayer: registra as assinaturas que faltam e liquida na MESMA transação (tudo ou nada).
    function approveAndSettle(string calldata dealId, bytes[] calldata signatures, string[] calldata nonces, bytes32 preimage) external whenNotPaused nonReentrant {
        Deal storage d = _load(dealId); if (signatures.length != nonces.length) revert BadSignatureCount();
        for (uint256 i = 0; i < signatures.length; i++) _approve(d, nonces[i], signatures[i]);
        _settle(d, preimage);
    }
    function _settle(Deal storage d, bytes32 preimage) private {
        if (d.status != Status.FULLY_SIGNED) revert NotFullySigned();
        if (d.approvals != d.requiredSignatures) revert BadSignatureCount(); // redundante por desenho (defesa em profundidade)
        if (uint64(block.timestamp) * 1000 + EXEC_MARGIN_MS >= d.expiresAtMs) revert Expired();
        if (d.depositedCount != d.legs.length) revert BadStatus(d.status);
        _setStatus(d, Status.VALIDATING); emit ValidationStarted(d.dealIdHash);
        // revalidação FAIL CLOSED (qualquer falha reverte: não existe "continuar mesmo assim")
        for (uint256 i = 0; i < d.legs.length; i++) { if (!assets[d.legs[i].token].allowed) revert AssetNotRegistered(d.legs[i].token); }
        if (d.amountOut < d.minAmountOut) revert SlippageExceeded();
        if (address(priceGuard) != address(0) && !priceGuard.validate(d.dealIdHash, d.assetInHash, d.assetOutHash, d.referencePrice)) revert PriceGuardRejected();
        if (d.htlcHash != bytes32(0)) { if (sha256(abi.encodePacked(preimage)) != d.htlcHash) revert BadPreimage(); emit PreimageRevealed(d.dealIdHash, preimage); }
        _setStatus(d, Status.SETTLING); emit SettlementStarted(d.dealIdHash);
        _setStatus(d, Status.SETTLED); // efeito antes de qualquer interação (CEI)
        for (uint256 i = 0; i < d.legs.length; i++) {
            Leg storage leg = d.legs[i]; leg.settled = true;
            if (leg.isPayment) {
                uint256 fee = (leg.amount * d.feeBps) / 10_000;
                _pay(leg.token, d.participants[0], leg.amount - fee);
                if (fee > 0) { _pay(leg.token, treasury, fee); emit FeeCollected(d.dealIdHash, leg.token, fee, treasury); }
                if (d.commissionAmount > 0) {
                    uint256 pm2Share = d.participants.length == 4 ? (d.commissionAmount * d.commissionSplitBps[1]) / d.commissionBps : 0;
                    uint256 pm1Share = d.commissionAmount - pm2Share; // resíduo de arredondamento fica com o Pay Master 1
                    _pay(leg.token, d.participants[2], pm1Share); emit CommissionPaid(d.dealIdHash, 2, d.participants[2], leg.token, pm1Share);
                    if (pm2Share > 0) { _pay(leg.token, d.participants[3], pm2Share); emit CommissionPaid(d.dealIdHash, 3, d.participants[3], leg.token, pm2Share); }
                }
            } else {
                _pay(leg.token, d.participants[1], leg.amount);
            }
        }
        emit SettlementCompleted(d.dealIdHash, d.revision, d.dealHash);
    }

    /* ═══════════════════════════ Refund (nunca pausável) ═══════════════════════════ */
    /// @notice Devolve a leg ao depositante determinado pelos termos. Permitido após expiração, cancelamento ou supersede. Nunca após SETTLED.
    function refund(string calldata dealId, uint8 legPos) external nonReentrant {
        Deal storage d = _load(dealId);
        if (d.status == Status.SETTLED || d.status == Status.VALIDATING || d.status == Status.SETTLING) revert BadStatus(d.status);
        bool expired = uint64(block.timestamp) * 1000 >= d.expiresAtMs;
        bool terminal = d.status == Status.CANCELLED || d.status == Status.SUPERSEDED;
        if (!expired && !terminal) revert NotExpired();
        if (legPos >= d.legs.length) revert BadInput(); Leg storage leg = d.legs[legPos]; if (!leg.deposited) revert NothingToRefund();
        if (!terminal && d.status != Status.REFUNDING) { if (d.status != Status.EXPIRED) { _setStatus(d, Status.EXPIRED); emit DealExpired(d.dealIdHash); } _setStatus(d, Status.REFUNDING); emit RefundStarted(d.dealIdHash); }
        leg.deposited = false; d.depositedCount -= 1;
        address to = _legFrom(d, leg); uint256 amount = _legDeposit(d, leg);
        _pay(leg.token, to, amount); emit Refunded(d.dealIdHash, leg.index, to, leg.token, amount);
        if (d.depositedCount == 0 && d.status == Status.REFUNDING) { _setStatus(d, Status.REFUNDED); emit RefundCompleted(d.dealIdHash); }
    }

    /* ═══════════════════════════ AssetRegistry (timelock) ═══════════════════════════ */
    function scheduleAsset(address token, bool allowed, uint8 decimals_, bytes32 canonicalId) external onlyRole(ADMIN_ROLE) {
        bytes32 k = keccak256(abi.encode(token, allowed, decimals_, canonicalId)); uint64 eta = uint64(block.timestamp) + REGISTRY_TIMELOCK; registryEta[k] = eta;
        emit AssetScheduled(token, allowed, decimals_, canonicalId, eta);
    }
    function executeAsset(address token, bool allowed, uint8 decimals_, bytes32 canonicalId) external onlyRole(ADMIN_ROLE) {
        bytes32 k = keccak256(abi.encode(token, allowed, decimals_, canonicalId)); uint64 eta = registryEta[k]; if (eta == 0 || block.timestamp < eta) revert TimelockPending(eta);
        delete registryEta[k];
        if (allowed && token != NATIVE) { if (token.code.length == 0) revert AssetMismatch(token); if (IERC20Decimals(token).decimals() != decimals_) revert AssetMismatch(token); } // registro só se o contrato existe e os decimais batem
        assets[token] = AssetInfo({ allowed: allowed, decimals: decimals_, canonicalId: canonicalId });
        emit AssetRegistered(token, allowed, decimals_, canonicalId);
    }
    /// @dev Compatibilidade: consulta simples de allowlist.
    function tokenAllowed(address token) external view returns (bool) { return assets[token].allowed; }

    /* ═══════════════════════════ EmergencyControls ═══════════════════════════ */
    /// @notice Pausa register/deposit/approve/settle. NÃO pausa refund nem cancel. Não move fundos.
    function pause() external onlyRole(GUARDIAN_ROLE) { _pause(); emit EmergencyPaused(msg.sender); }
    function unpause() external onlyRole(GUARDIAN_ROLE) { _unpause(); emit EmergencyUnpaused(msg.sender); }

    /* ═══════════════════════════ Views ═══════════════════════════ */
    function dealStatus(string calldata dealId) external view returns (Status status, uint32 revision, bytes32 dealHash, bytes32 termsHash, uint64 expiresAtMs, uint8 approvals, uint8 requiredSignatures, uint8 depositedCount, uint8 legCount) {
        Deal storage d = _deals[keccak256(bytes(dealId))];
        return (d.status, d.revision, d.dealHash, d.termsHash, d.expiresAtMs, d.approvals, d.requiredSignatures, d.depositedCount, uint8(d.legs.length));
    }
    function legOf(string calldata dealId, uint8 legPos) external view returns (Leg memory) { return _deals[keccak256(bytes(dealId))].legs[legPos]; }
    function participantsOf(string calldata dealId) external view returns (address[] memory) { return _deals[keccak256(bytes(dealId))].participants; }
    function approvedOf(string calldata dealId) external view returns (bool[4] memory) { return _deals[keccak256(bytes(dealId))].approved; }
    function economicsOf(string calldata dealId) external view returns (uint256 amountIn, uint256 amountOut, uint256 minAmountOut, uint256 referencePrice, uint16 discountBps, uint16 feeBps, uint16 commissionBps, uint16[2] memory split, uint256 commissionAmount, bytes32 routeHash, bytes32 dealNonce) {
        Deal storage d = _deals[keccak256(bytes(dealId))];
        return (d.amountIn, d.amountOut, d.minAmountOut, d.referencePrice, d.discountBps, d.feeBps, d.commissionBps, d.commissionSplitBps, d.commissionAmount, d.routeHash, d.dealNonce);
    }
    function domainSeparator() external view returns (bytes32) { return _domainSeparatorV4(); }
    /// @notice Pré-verificação off-chain (sem estado): devolve o motivo pelo qual `settle` reverteria agora (bytes32(0) = liquidável). Observabilidade §31.
    function settlementCheck(string calldata dealId) external view returns (bytes32 reason) {
        Deal storage d = _deals[keccak256(bytes(dealId))];
        if (d.status == Status.NONE) return "DEAL_NOT_FOUND";
        if (d.status == Status.SETTLED) return "ALREADY_SETTLED";
        if (uint64(block.timestamp) * 1000 + EXEC_MARGIN_MS >= d.expiresAtMs) return "EXPIRED";
        if (d.depositedCount != d.legs.length) return "ASSETS_NOT_LOCKED";
        if (d.status != Status.FULLY_SIGNED || d.approvals != d.requiredSignatures) return "NOT_FULLY_SIGNED";
        for (uint256 i = 0; i < d.legs.length; i++) if (!assets[d.legs[i].token].allowed) return "ASSET_NOT_REGISTERED";
        if (address(priceGuard) != address(0) && !priceGuard.validate(d.dealIdHash, d.assetInHash, d.assetOutHash, d.referencePrice)) return "PRICE_GUARD";
        if (paused()) return "PAUSED";
        return bytes32(0);
    }
    /// @notice Marca explicitamente a expiração (permissionless) para auditoria; sem efeito sobre fundos (refund continua leg a leg).
    function expire(string calldata dealId) external {
        Deal storage d = _load(dealId);
        if (d.status == Status.SETTLED || d.status == Status.EXPIRED || d.status == Status.REFUNDING || d.status == Status.REFUNDED || d.status == Status.CANCELLED || d.status == Status.SUPERSEDED) revert BadStatus(d.status);
        if (uint64(block.timestamp) * 1000 < d.expiresAtMs) revert NotExpired();
        _setStatus(d, Status.EXPIRED); emit DealExpired(d.dealIdHash);
    }
    /// @notice Digest EIP-712 que o participante `role` deve assinar (ferramentas/carteiras podem conferir antes de assinar).
    function approvalDigest(string calldata dealId, uint8 role, string calldata nonce) external view returns (bytes32) { Deal storage d = _load(dealId); if (role >= d.requiredSignatures) revert BadInput(); return _digestFor(d, role, nonce); }

    /* ═══════════════════════════ internos ═══════════════════════════ */
    function _load(string calldata dealId) private view returns (Deal storage d) { d = _deals[keccak256(bytes(dealId))]; if (d.status == Status.NONE) revert DealNotFound(); }
    function _setStatus(Deal storage d, Status to) private { Status from = d.status; d.status = to; emit StateChanged(d.dealIdHash, from, to); }
    function _roleOf(Deal storage d, address who) private view returns (uint8) { for (uint8 i = 0; i < d.participants.length; i++) if (d.participants[i] == who) return i; return type(uint8).max; }
    /// @dev A parte que deposita cada leg é determinada pelos papéis (Comprador paga; Vendedor entrega) — nunca por parâmetro.
    function _legFrom(Deal storage d, Leg storage leg) private view returns (address) { return leg.isPayment ? d.participants[1] : d.participants[0]; }
    function _legDeposit(Deal storage d, Leg storage leg) private view returns (uint256) { return leg.isPayment ? leg.amount + d.commissionAmount : leg.amount; }
    function _pay(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        if (token == NATIVE) { (bool ok, ) = payable(to).call{value: amount}(""); if (!ok) revert TransferAmountMismatch(); }
        else IERC20(token).safeTransfer(to, amount);
    }
}
