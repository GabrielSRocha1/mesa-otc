// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {BaseTest, VerumOtcEscrow, MockERC20, ReentrantERC20} from "./Base.t.sol";

contract VerumOtcEscrowTest is BaseTest {
    string constant D = "OTC-F-1";

    /* ─────────────── assinaturas: 3/3, 4/4, 2/3, 3/4, inválida, duplicada, errada, externa ─────────────── */
    function test_settle_3of3_paysExactly() public {
        register(terms(D, false)); deposits(D); approveAll(D, 3);
        assertEq(uint8(statusOf(D)), uint8(VerumOtcEscrow.Status.FULLY_SIGNED));
        uint256 b0 = buyer.balance; uint256 s0 = usdc.balanceOf(seller); uint256 t0 = usdc.balanceOf(treasury); uint256 p0 = usdc.balanceOf(pm1);
        vm.prank(outsider); escrow.settle(D, bytes32(0));
        assertEq(uint8(statusOf(D)), uint8(VerumOtcEscrow.Status.SETTLED));
        assertEq(buyer.balance - b0, 1 ether); uint256 fee = 2_400e6 * 25 / 10_000; assertEq(usdc.balanceOf(seller) - s0, 2_400e6 - fee); assertEq(usdc.balanceOf(treasury) - t0, fee); assertEq(usdc.balanceOf(pm1) - p0, 240e6);
        assertEq(address(escrow).balance, 0); assertEq(usdc.balanceOf(address(escrow)), 0);
    }
    function test_settle_4of4_splitsCommission() public {
        register(terms(D, true)); deposits(D); approveAll(D, 4); uint256 p1 = usdc.balanceOf(pm1); uint256 p2 = usdc.balanceOf(pm2);
        escrow.settle(D, bytes32(0)); assertEq(usdc.balanceOf(pm1) - p1, 144e6); assertEq(usdc.balanceOf(pm2) - p2, 96e6);
    }
    function test_2of3_and_3of4_neverSettle() public {
        register(terms(D, false)); deposits(D); approveAll(D, 2);
        vm.expectRevert(VerumOtcEscrow.NotFullySigned.selector); escrow.settle(D, bytes32(0));
        register(terms("OTC-F-2", true)); deposits("OTC-F-2"); approveAll("OTC-F-2", 3);
        vm.expectRevert(VerumOtcEscrow.NotFullySigned.selector); escrow.settle("OTC-F-2", bytes32(0));
        assertEq(address(escrow).balance, 2 ether);
    }
    function test_invalidDuplicateWrongAndOutsiderSignatures() public {
        register(terms(D, false)); deposits(D);
        bytes memory sOut = sigBy(D, 0, outsiderPk, "x"); bytes memory sWrongRole = sigBy(D, 0, buyerPk, "x"); bytes memory s0 = sig(D, 0, "n0"); bytes memory s0b = sig(D, 0, "n0b");
        vm.expectRevert(VerumOtcEscrow.BadSigner.selector); escrow.approve(D, "x", hex"deadbeef");
        vm.expectRevert(VerumOtcEscrow.BadSigner.selector); escrow.approve(D, "x", sOut);       // participante externo
        vm.expectRevert(VerumOtcEscrow.BadSigner.selector); escrow.approve(D, "x", sWrongRole); // papel errado (Comprador assinando como Vendedor)
        escrow.approve(D, "n0", s0);
        vm.expectRevert(VerumOtcEscrow.NonceAlreadyUsed.selector); escrow.approve(D, "n0", s0);   // duplicada (mesmo nonce)
        vm.expectRevert(VerumOtcEscrow.BadSigner.selector); escrow.approve(D, "n0b", s0b); // já aprovado: papel fechado, assinatura extra não é aceita
        // assinatura de outro Deal (termos idênticos, id diferente) não vale aqui
        register(terms("OTC-F-3", false)); deposits("OTC-F-3"); bytes memory sOther = sig("OTC-F-3", 1, "n1");
        vm.expectRevert(VerumOtcEscrow.BadSigner.selector); escrow.approve(D, "n1", sOther);
        // assinatura sobre chain/contrato diferentes: domínio distinto ⇒ inválida
        VerumOtcEscrow other = new VerumOtcEscrow(admin, guardian, keeper, treasury, address(0), NATIVE_ID); bytes memory sHere = sig(D, 1, "n1");
        vm.expectRevert(); other.approve(D, "n1", sHere);
    }
    function test_cannotSignBeforeDeposits() public { register(terms(D, false)); bytes memory s0 = sig(D, 0, "n0"); vm.expectRevert(abi.encodeWithSelector(VerumOtcEscrow.BadStatus.selector, VerumOtcEscrow.Status.CREATED)); escrow.approve(D, "n0", s0); }

    /* ─────────────── expiração, alteração, nonce, double settlement ─────────────── */
    function test_expiredDeal_noSignatures_noSettle_refundOnly() public {
        register(terms(D, false)); deposits(D); approveAll(D, 2); bytes memory s2 = sig(D, 2, "n2"); vm.warp(block.timestamp + 3601);
        vm.expectRevert(VerumOtcEscrow.Expired.selector); escrow.approve(D, "n2", s2);
        vm.expectRevert(VerumOtcEscrow.NotFullySigned.selector); escrow.settle(D, bytes32(0));
        uint256 s0 = seller.balance; uint256 b0 = usdc.balanceOf(buyer); vm.prank(outsider); escrow.refund(D, 0); vm.prank(outsider); escrow.refund(D, 1);
        assertEq(seller.balance - s0, 1 ether); assertEq(usdc.balanceOf(buyer) - b0, 2_640e6); assertEq(uint8(statusOf(D)), uint8(VerumOtcEscrow.Status.REFUNDED));
    }
    function test_fullySignedButExpiresBeforeExecution() public { register(terms(D, false)); deposits(D); approveAll(D, 3); vm.warp(block.timestamp + 3600 - 30); vm.expectRevert(VerumOtcEscrow.Expired.selector); escrow.settle(D, bytes32(0)); }
    function test_alteredDealRequiresNewRevision_andSignaturesDoNotCarry() public {
        register(terms(D, false)); deposits(D); escrow.approve(D, "n0", sig(D, 0, "n0"));
        vm.prank(keeper); vm.expectRevert(abi.encodeWithSelector(VerumOtcEscrow.BadStatus.selector, VerumOtcEscrow.Status.AWAITING_SIGNATURES)); escrow.supersede(D, 1); // depois da primeira assinatura: imutável
        vm.prank(seller); vm.expectRevert(abi.encodeWithSelector(VerumOtcEscrow.BadStatus.selector, VerumOtcEscrow.Status.AWAITING_SIGNATURES)); escrow.cancel(D);
        VerumOtcEscrow.RegisterInput memory v2 = terms(D, false); v2.revision = 2; v2.amountOut = 2_500e6; v2.legs[1].amount = 2_500e6;
        vm.prank(keeper); vm.expectRevert(VerumOtcEscrow.DealExists.selector); escrow.register(v2);
    }
    function test_nonceAndDealNonceReuseRejected() public {
        VerumOtcEscrow.RegisterInput memory a = terms(D, false); register(a);
        VerumOtcEscrow.RegisterInput memory b = terms("OTC-F-9", false); b.dealNonce = a.dealNonce;
        vm.prank(keeper); vm.expectRevert(VerumOtcEscrow.DealNonceAlreadyUsed.selector); escrow.register(b);
    }
    function test_doubleSettlementImpossible() public {
        register(terms(D, false)); deposits(D); approveAll(D, 3); escrow.settle(D, bytes32(0));
        vm.expectRevert(VerumOtcEscrow.NotFullySigned.selector); escrow.settle(D, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(VerumOtcEscrow.BadStatus.selector, VerumOtcEscrow.Status.SETTLED)); escrow.refund(D, 0);
        bytes memory sz = sig(D, 0, "z"); vm.expectRevert(abi.encodeWithSelector(VerumOtcEscrow.BadStatus.selector, VerumOtcEscrow.Status.SETTLED)); escrow.approve(D, "z", sz);
    }

    /* ─────────────── ativos: fake, contrato/rede/decimais errados, amount/price/route/slippage ─────────────── */
    function test_fakeToken_wrongContract_wrongDecimals_wrongNetwork_rejected() public {
        MockERC20 fake = new MockERC20("Tether USD", "USDT", 6);
        VerumOtcEscrow.RegisterInput memory t = terms(D, false); t.legs[1].token = address(fake);
        vm.prank(keeper); vm.expectRevert(abi.encodeWithSelector(VerumOtcEscrow.AssetNotRegistered.selector, address(fake))); escrow.register(t);
        t = terms(D, false); t.legs[1].decimals = 18; vm.prank(keeper); vm.expectRevert(abi.encodeWithSelector(VerumOtcEscrow.AssetMismatch.selector, address(usdc))); escrow.register(t);
        t = terms(D, false); t.legs[1].canonicalId = keccak256("eip155:1/erc20:usdc"); vm.prank(keeper); vm.expectRevert(abi.encodeWithSelector(VerumOtcEscrow.AssetMismatch.selector, address(usdc))); escrow.register(t);
        MockERC20 wrongDec = new MockERC20("USD Coin", "USDC", 18); vm.prank(admin); escrow.scheduleAsset(address(wrongDec), true, 6, keccak256("x")); vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(admin); vm.expectRevert(abi.encodeWithSelector(VerumOtcEscrow.AssetMismatch.selector, address(wrongDec))); escrow.executeAsset(address(wrongDec), true, 6, keccak256("x")); // registro exige decimais reais
    }
    function test_wrongAmountPriceRoute_changeTermsHash_signaturesInvalid() public {
        register(terms(D, false)); deposits(D); bytes memory good = sig(D, 0, "n0");
        (,,, bytes32 th1,,,,,) = escrow.dealStatus(D);
        VerumOtcEscrow.RegisterInput memory t2 = terms("OTC-F-4", false); t2.amountOut = 2_401e6; t2.legs[1].amount = 2_401e6; register(t2); deposits("OTC-F-4"); (,,, bytes32 th2,,,,,) = escrow.dealStatus("OTC-F-4");
        assertTrue(th1 != th2, "amountOut altera termsHash"); vm.expectRevert(VerumOtcEscrow.BadSigner.selector); escrow.approve("OTC-F-4", "n0", good);
        VerumOtcEscrow.RegisterInput memory t3 = terms("OTC-F-5", false); t3.routeHash = keccak256("RT-OTHER"); register(t3); (,,, bytes32 th3,,,,,) = escrow.dealStatus("OTC-F-5"); assertTrue(th3 != th1, "rota altera termsHash");
        VerumOtcEscrow.RegisterInput memory t4 = terms("OTC-F-6", false); t4.referencePrice = 1; register(t4); (,,, bytes32 th4,,,,,) = escrow.dealStatus("OTC-F-6"); assertTrue(th4 != th1, "preco altera termsHash");
        VerumOtcEscrow.RegisterInput memory t5 = terms("OTC-F-7", false); t5.feeBps = 26; register(t5); (,,, bytes32 th5,,,,,) = escrow.dealStatus("OTC-F-7"); assertTrue(th5 != th1, "fee altera termsHash");
    }
    function test_slippageAndAmountsRejectedAtRegister() public {
        VerumOtcEscrow.RegisterInput memory t = terms(D, false); t.minAmountOut = 2_401e6; vm.prank(keeper); vm.expectRevert(VerumOtcEscrow.BadInput.selector); escrow.register(t);
        t = terms(D, false); t.legs[1].amount = 2_399e6; vm.prank(keeper); vm.expectRevert(VerumOtcEscrow.BadLegParties.selector); escrow.register(t);
        t = terms(D, false); t.feeBps = 501; vm.prank(keeper); vm.expectRevert(VerumOtcEscrow.FeeTooHigh.selector); escrow.register(t);
        t = terms(D, false); t.commissionSplitBps = [uint16(700), uint16(300)]; vm.prank(keeper); vm.expectRevert(VerumOtcEscrow.BadInput.selector); escrow.register(t); // 3 partes: PM2 não pode ter share
    }
    function test_oracleGuardStaleOrUnavailable_blocksSettlement() public {
        register(terms(D, false)); deposits(D); approveAll(D, 3); guard.set(false);
        vm.expectRevert(VerumOtcEscrow.PriceGuardRejected.selector); escrow.settle(D, bytes32(0));
        guard.set(true); escrow.settle(D, bytes32(0)); assertEq(uint8(statusOf(D)), uint8(VerumOtcEscrow.Status.SETTLED));
    }
    function test_assetDelistedAfterSigning_failsClosed() public {
        VerumOtcEscrow.RegisterInput memory t = terms(D, false); t.expiresAtMs = (uint64(block.timestamp) + 48 hours) * 1000; register(t); deposits(D); approveAll(D, 3); delistAsset(address(usdc), 6, USDC_ID);
        vm.expectRevert(abi.encodeWithSelector(VerumOtcEscrow.AssetNotRegistered.selector, address(usdc))); escrow.settle(D, bytes32(0));
        vm.warp(block.timestamp + 48 hours); escrow.refund(D, 0); escrow.refund(D, 1); assertEq(usdc.balanceOf(address(escrow)), 0); // reembolso continua
    }

    /* ─────────────── depósito, fee-on-transfer, reentrância, pausa, admin ─────────────── */
    function test_depositOnlyByPartyExactValue_feeOnTransferRejected() public {
        register(terms(D, false));
        vm.prank(buyer); vm.expectRevert(VerumOtcEscrow.NotDepositor.selector); escrow.deposit{ value: 1 ether }(D, 0);
        vm.prank(seller); vm.expectRevert(VerumOtcEscrow.BadNativeValue.selector); escrow.deposit{ value: 0.5 ether }(D, 0);
        usdc.setFeeBps(10); vm.prank(buyer); vm.expectRevert(VerumOtcEscrow.TransferAmountMismatch.selector); escrow.deposit(D, 1); usdc.setFeeBps(0);
    }
    function test_reentrancyOnSettleAndRefund() public {
        ReentrantERC20 evil = new ReentrantERC20(); listAsset(address(evil), 6, keccak256("evil"));
        VerumOtcEscrow.RegisterInput memory t = terms(D, false); t.legs[1].token = address(evil); t.legs[1].canonicalId = keccak256("evil"); t.assetOutHash = keccak256("evil"); register(t);
        evil.mint(buyer, 1e12); vm.prank(buyer); evil.approve(address(escrow), type(uint256).max); vm.prank(seller); escrow.deposit{ value: 1 ether }(D, 0); vm.prank(buyer); escrow.deposit(D, 1);
        // assinaturas usam assetOutHash = keccak("evil") ⇒ recomputa digest com esse hash
        for (uint8 r = 0; r < 3; r++) { string memory n = string(abi.encodePacked("n", r)); (,uint32 rev, bytes32 dh, bytes32 th, uint64 exp,,,,) = escrow.dealStatus(D);
            bytes32 sh = keccak256(bytes.concat(abi.encode(APPROVAL_TYPEHASH, dh, th, keccak256(bytes(D)), rev, r, vm.addr(pkOf(r)), keccak256(bytes(n))), abi.encode(exp, NATIVE_ID, uint256(1 ether), keccak256("evil"), uint256(2_400e6), r == 0 ? keccak256(bytes(vm.toString(buyer))) : keccak256(bytes(vm.toString(seller))))));
            (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(pkOf(r), keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), sh))); escrow.approve(D, n, abi.encodePacked(rr, ss, v)); }
        evil.arm(address(escrow), D, 2); // tenta re-entrar em settle durante a transferência de saída
        uint256 s0 = evil.balanceOf(seller); uint256 e0 = address(escrow).balance;
        escrow.settle(D, bytes32(0));
        assertTrue(evil.reentered() && evil.reentryReverted(), "reentrada em settle foi bloqueada");
        assertEq(uint8(statusOf(D)), uint8(VerumOtcEscrow.Status.SETTLED)); assertEq(evil.balanceOf(seller) - s0, 2_400e6 - 2_400e6 * 25 / 10_000); assertEq(evil.balanceOf(address(escrow)), 0); assertEq(e0 - address(escrow).balance, 1 ether);
        // reentrada em refund durante um reembolso
        VerumOtcEscrow.RegisterInput memory t2 = terms("OTC-F-R", false); t2.legs[1].token = address(evil); t2.legs[1].canonicalId = keccak256("evil"); t2.assetOutHash = keccak256("evil"); register(t2);
        vm.prank(seller); escrow.deposit{ value: 1 ether }("OTC-F-R", 0); vm.prank(buyer); escrow.deposit("OTC-F-R", 1); vm.warp(block.timestamp + 3601);
        evil.arm(address(escrow), "OTC-F-R", 1);
        escrow.refund("OTC-F-R", 1); escrow.refund("OTC-F-R", 0); assertEq(uint8(statusOf("OTC-F-R")), uint8(VerumOtcEscrow.Status.REFUNDED)); assertEq(evil.balanceOf(address(escrow)), 0);
    }
    function test_pauseBlocksEntriesNotRefunds_andAdminCannotSteal() public {
        register(terms(D, false)); deposits(D); bytes memory s0 = sig(D, 0, "n0"); vm.prank(guardian); escrow.pause();
        vm.expectRevert(); escrow.approve(D, "n0", s0);
        vm.prank(keeper); vm.expectRevert(); escrow.register(terms("OTC-F-8", false));
        vm.warp(block.timestamp + 3601); escrow.refund(D, 0); escrow.refund(D, 1); // reembolso funciona pausado
        vm.prank(guardian); escrow.unpause();
        vm.prank(outsider); vm.expectRevert(); escrow.pause(); // só guardian
        vm.prank(admin); vm.expectRevert(); escrow.executeAsset(address(usdc), false, 6, USDC_ID); // sem timelock
        vm.prank(outsider); vm.expectRevert(); escrow.supersede(D, 1); // só keeper, e mesmo ele não move fundos
        assertEq(address(escrow).balance, 0);
    }
    function test_cancelBeforeSignatureRefundsBoth() public {
        register(terms(D, false)); deposits(D); vm.prank(buyer); escrow.cancel(D); escrow.refund(D, 0); escrow.refund(D, 1);
        assertEq(uint8(statusOf(D)), uint8(VerumOtcEscrow.Status.CANCELLED)); assertEq(address(escrow).balance, 0); assertEq(usdc.balanceOf(address(escrow)), 0);
    }
    function test_htlcPreimage() public {
        VerumOtcEscrow.RegisterInput memory t = terms(D, false); bytes32 pre = keccak256("secret"); t.htlcHash = sha256(abi.encodePacked(pre)); register(t); deposits(D); approveAll(D, 3);
        vm.expectRevert(VerumOtcEscrow.BadPreimage.selector); escrow.settle(D, bytes32(0)); escrow.settle(D, pre); assertEq(uint8(statusOf(D)), uint8(VerumOtcEscrow.Status.SETTLED));
    }

    /* ─────────────── fuzz ─────────────── */
    function testFuzz_feesAndCommissionNeverExceedDeposits(uint256 amountOut, uint16 feeBps, uint16 commissionBps, uint16 split0) public {
        amountOut = bound(amountOut, 1, 1e30); feeBps = uint16(bound(feeBps, 0, 500)); commissionBps = uint16(bound(commissionBps, 0, 5000)); split0 = uint16(bound(split0, 0, commissionBps));
        uint256 commissionAmount = amountOut * commissionBps / 10_000; if (commissionBps > 0 && commissionAmount == 0) return;
        VerumOtcEscrow.RegisterInput memory t = terms(D, true); t.amountOut = amountOut; t.legs[1].amount = amountOut; t.minAmountOut = amountOut; t.feeBps = feeBps; t.commissionBps = commissionBps; t.commissionSplitBps = [split0, uint16(commissionBps - split0)]; t.commissionAmount = commissionAmount;
        usdc.mint(buyer, amountOut + commissionAmount); register(t); deposits(D); approveAll(D, 4);
        uint256 s0 = usdc.balanceOf(seller); uint256 t0 = usdc.balanceOf(treasury); uint256 p10 = usdc.balanceOf(pm1); uint256 p20 = usdc.balanceOf(pm2);
        escrow.settle(D, bytes32(0));
        uint256 paid = (usdc.balanceOf(seller) - s0) + (usdc.balanceOf(treasury) - t0) + (usdc.balanceOf(pm1) - p10) + (usdc.balanceOf(pm2) - p20);
        assertEq(paid, amountOut + commissionAmount, "conservacao"); assertGe(usdc.balanceOf(seller) - s0, amountOut - amountOut * feeBps / 10_000); assertEq(usdc.balanceOf(address(escrow)), 0);
    }
    function testFuzz_neverSettlesAfterExpiration(uint64 dt) public {
        register(terms(D, false)); deposits(D); approveAll(D, 3); dt = uint64(bound(dt, 3600 - 60, 10 * 365 days)); vm.warp(block.timestamp + dt);
        vm.expectRevert(VerumOtcEscrow.Expired.selector); escrow.settle(D, bytes32(0));
    }
    function testFuzz_wrongKeyNeverApproves(uint256 pk) public {
        pk = bound(pk, 1, 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140); vm.assume(pk != sellerPk && pk != buyerPk && pk != pm1Pk);
        register(terms(D, false)); deposits(D); bytes memory sx = sigBy(D, 0, pk, "n"); vm.expectRevert(VerumOtcEscrow.BadSigner.selector); escrow.approve(D, "n", sx);
    }
}
