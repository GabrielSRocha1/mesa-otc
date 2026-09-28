// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VerumOtcEscrow} from "../../contracts/VerumOtcEscrow.sol";
import {MockERC20, MockPriceGuard, ReentrantERC20} from "../../contracts/mocks/TestMocks.sol";

/// @dev Base compartilhada: deploy, registro de ativos (timelock), participantes, construção de termos e assinaturas EIP-712 idênticas ao contrato.
abstract contract BaseTest is Test {
    bytes32 constant APPROVAL_TYPEHASH = keccak256(
        "DealApproval(bytes32 dealHash,bytes32 termsHash,string dealId,uint32 revision,uint8 role,address signer,string nonce,uint64 expiresAt,string assetIn,uint256 amountIn,string assetOut,uint256 amountOut,string counterparty)"
    );
    bytes32 constant NATIVE_ID = keccak256("eip155:31337/slip44:60");
    bytes32 constant USDC_ID = keccak256("eip155:31337/erc20:usdc");

    VerumOtcEscrow public escrow; MockERC20 public usdc; MockPriceGuard public guard;
    address public admin = makeAddr("admin"); address public guardian = makeAddr("guardian"); address public keeper = makeAddr("keeper"); address public treasury = makeAddr("treasury");
    uint256 sellerPk = 0xA11CE; uint256 buyerPk = 0xB0B; uint256 pm1Pk = 0xC0FFEE; uint256 pm2Pk = 0xD00D; uint256 outsiderPk = 0xE7E7;
    address public seller; address public buyer; address public pm1; address public pm2; address public outsider;
    uint256 nonceSeq;

    function setUp() public virtual {
        seller = vm.addr(sellerPk); buyer = vm.addr(buyerPk); pm1 = vm.addr(pm1Pk); pm2 = vm.addr(pm2Pk); outsider = vm.addr(outsiderPk);
        vm.warp(1_800_000_000);
        guard = new MockPriceGuard(); guard.set(true);
        escrow = new VerumOtcEscrow(admin, guardian, keeper, treasury, address(guard), NATIVE_ID);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        listAsset(address(usdc), 6, USDC_ID);
        vm.deal(seller, 1_000 ether); vm.deal(buyer, 1_000 ether); vm.deal(outsider, 10 ether);
        usdc.mint(buyer, 1e15); usdc.mint(seller, 1e15); vm.prank(buyer); usdc.approve(address(escrow), type(uint256).max); vm.prank(seller); usdc.approve(address(escrow), type(uint256).max);
    }
    function listAsset(address token, uint8 dec, bytes32 id) internal { vm.prank(admin); escrow.scheduleAsset(token, true, dec, id); vm.warp(block.timestamp + 24 hours + 1); vm.prank(admin); escrow.executeAsset(token, true, dec, id); }
    function delistAsset(address token, uint8 dec, bytes32 id) internal { vm.prank(admin); escrow.scheduleAsset(token, false, dec, id); vm.warp(block.timestamp + 24 hours + 1); vm.prank(admin); escrow.executeAsset(token, false, dec, id); }

    /// termos padrão: Vendedor entrega 1 ETH (nativo), Comprador paga 2.400 USDC; fee 25 bps; comissão 10% (240 USDC) dividida 6/4 quando há 2 PMs.
    function terms(string memory dealId, bool fourParties) internal returns (VerumOtcEscrow.RegisterInput memory inp) {
        address[] memory parts = new address[](fourParties ? 4 : 3); parts[0] = seller; parts[1] = buyer; parts[2] = pm1; if (fourParties) parts[3] = pm2;
        VerumOtcEscrow.LegInput[] memory legs = new VerumOtcEscrow.LegInput[](2);
        legs[0] = VerumOtcEscrow.LegInput({ index: 0, token: address(0), decimals: 18, canonicalId: NATIVE_ID, amount: 1 ether, isPayment: false });
        legs[1] = VerumOtcEscrow.LegInput({ index: 1, token: address(usdc), decimals: 6, canonicalId: USDC_ID, amount: 2_400e6, isPayment: true });
        nonceSeq++;
        inp = VerumOtcEscrow.RegisterInput({ dealId: dealId, revision: 1, dealHash: keccak256(abi.encode("dealhash", dealId)), expiresAtMs: (uint64(block.timestamp) + 3600) * 1000, participants: parts, legs: legs,
            assetInHash: NATIVE_ID, assetOutHash: USDC_ID, amountIn: 1 ether, amountOut: 2_400e6, minAmountOut: 2_394e6, referencePrice: 2_666e18, discountBps: 1000, feeBps: 25,
            commissionBps: 1000, commissionSplitBps: fourParties ? [uint16(600), uint16(400)] : [uint16(1000), uint16(0)], commissionAmount: 240e6, routeHash: keccak256("RT-ESCROW_NN"), dealNonce: keccak256(abi.encode("nonce", dealId, nonceSeq)), htlcHash: bytes32(0),
            counterpartyHash: keccak256(bytes(vm.toString(buyer))), sellerHash: keccak256(bytes(vm.toString(seller))) });
    }
    function register(VerumOtcEscrow.RegisterInput memory inp) internal { vm.prank(keeper); escrow.register(inp); }
    function deposits(string memory dealId) internal { vm.prank(seller); escrow.deposit{ value: 1 ether }(dealId, 0); vm.prank(buyer); escrow.deposit(dealId, 1); }
    function pkOf(uint8 role) internal view returns (uint256) { return role == 0 ? sellerPk : role == 1 ? buyerPk : role == 2 ? pm1Pk : pm2Pk; }
    function digest(string memory dealId, uint8 role, address signer, string memory nonce) internal view returns (bytes32) {
        (, uint32 revision, bytes32 dealHash, bytes32 termsHash, uint64 expiresAtMs,,,,) = escrow.dealStatus(dealId);
        (uint256 amountIn, uint256 amountOut,,,,,,,,,) = escrow.economicsOf(dealId);
        bytes32 structHash = keccak256(bytes.concat(
            abi.encode(APPROVAL_TYPEHASH, dealHash, termsHash, keccak256(bytes(dealId)), revision, role, signer, keccak256(bytes(nonce))),
            abi.encode(expiresAtMs, NATIVE_ID, amountIn, USDC_ID, amountOut, role == 0 ? keccak256(bytes(vm.toString(buyer))) : keccak256(bytes(vm.toString(seller))))));
        return keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), structHash));
    }
    function sig(string memory dealId, uint8 role, string memory nonce) internal view returns (bytes memory) { return sigBy(dealId, role, pkOf(role), nonce); }
    function sigBy(string memory dealId, uint8 role, uint256 pk, string memory nonce) internal view returns (bytes memory) { (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest(dealId, role, vm.addr(pk), nonce)); return abi.encodePacked(r, s, v); }
    function approveAll(string memory dealId, uint8 n) internal { for (uint8 r = 0; r < n; r++) escrow.approve(dealId, string(abi.encodePacked("n", r)), sig(dealId, r, string(abi.encodePacked("n", r)))); }
    function statusOf(string memory dealId) internal view returns (VerumOtcEscrow.Status s) { (s,,,,,,,,) = escrow.dealStatus(dealId); }
}
