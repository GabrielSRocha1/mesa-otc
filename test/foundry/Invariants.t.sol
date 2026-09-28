// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {BaseTest, VerumOtcEscrow} from "./Base.t.sol";

/// @dev Handler: ações aleatórias (registrar, depositar, aprovar, liquidar, expirar, reembolsar, cancelar, pausar) sobre vários Deals.
contract Handler is BaseTest {
    string[] public ids; uint256 public settled; uint256 public refundedLegs; uint256 public depositedEth; uint256 public depositedUsdc; uint256 public paidOutEth; uint256 public paidOutUsdc;
    mapping(string => uint8) public approvalsAt; mapping(string => bool) public wasSettled; mapping(string => uint64) public expiryOf; mapping(string => uint256) public settledAt;
    function setUp() public override { BaseTest.setUp(); }
    function create(uint8 four) external { string memory id = string(abi.encodePacked("H-", vm.toString(ids.length))); VerumOtcEscrow.RegisterInput memory t = terms(id, four % 2 == 1); vm.prank(keeper); try escrow.register(t) { ids.push(id); expiryOf[id] = t.expiresAtMs; } catch {} }
    function depositBoth(uint256 i) external { if (ids.length == 0) return; string memory id = ids[i % ids.length]; vm.prank(seller); try escrow.deposit{ value: 1 ether }(id, 0) { depositedEth += 1 ether; } catch {} vm.prank(buyer); try escrow.deposit(id, 1) { depositedUsdc += 2_640e6; } catch {} }
    function approveOne(uint256 i, uint8 role) external { if (ids.length == 0) return; string memory id = ids[i % ids.length]; (,,,,,, uint8 req,,) = escrow.dealStatus(id); role = role % req; string memory n = string(abi.encodePacked("n", role, i)); try escrow.approve(id, n, sig(id, role, n)) { approvalsAt[id]++; } catch {} }
    function doSettle(uint256 i) external { if (ids.length == 0) return; string memory id = ids[i % ids.length]; uint256 e0 = address(escrow).balance; uint256 u0 = usdc.balanceOf(address(escrow)); try escrow.settle(id, bytes32(0)) { settled++; wasSettled[id] = true; settledAt[id] = block.timestamp; paidOutEth += e0 - address(escrow).balance; paidOutUsdc += u0 - usdc.balanceOf(address(escrow)); } catch {} }
    function doRefund(uint256 i, uint8 leg) external { if (ids.length == 0) return; string memory id = ids[i % ids.length]; uint256 e0 = address(escrow).balance; uint256 u0 = usdc.balanceOf(address(escrow)); try escrow.refund(id, leg % 2) { refundedLegs++; paidOutEth += e0 - address(escrow).balance; paidOutUsdc += u0 - usdc.balanceOf(address(escrow)); } catch {} }
    function doCancel(uint256 i) external { if (ids.length == 0) return; vm.prank(seller); try escrow.cancel(ids[i % ids.length]) {} catch {} }
    function warp(uint32 dt) external { vm.warp(block.timestamp + (dt % 7200)); }
    function togglePause(bool p) external { vm.prank(guardian); if (p && !escrow.paused()) escrow.pause(); else if (!p && escrow.paused()) escrow.unpause(); }
    function idCount() external view returns (uint256) { return ids.length; }
}

contract InvariantsTest is BaseTest {
    Handler h;
    function setUp() public override { h = new Handler(); h.setUp(); targetContract(address(h));
        bytes4[] memory sels = new bytes4[](8); sels[0] = Handler.create.selector; sels[1] = Handler.depositBoth.selector; sels[2] = Handler.approveOne.selector; sels[3] = Handler.doSettle.selector; sels[4] = Handler.doRefund.selector; sels[5] = Handler.doCancel.selector; sels[6] = Handler.warp.selector; sels[7] = Handler.togglePause.selector;
        targetSelector(FuzzSelector({ addr: address(h), selectors: sels })); }
    /// INV-1: custódia = depósitos − saídas (nada some, nada é criado)
    function invariant_custodyConservation() public view { assertEq(address(h.escrow()).balance, h.depositedEth() - h.paidOutEth()); assertEq(h.usdc().balanceOf(address(h.escrow())), h.depositedUsdc() - h.paidOutUsdc()); }
    /// INV-2: nunca SETTLED sem N/N aprovações; nunca SETTLED após a expiração (margem); SETTLED é terminal
    function invariant_settledOnlyWithAllSignaturesAndBeforeExpiry() public view {
        uint256 n = h.idCount();
        for (uint256 i = 0; i < n; i++) { string memory id = h.ids(i); (VerumOtcEscrow.Status s,,,,, uint8 approvals, uint8 required,,) = h.escrow().dealStatus(id);
            if (s == VerumOtcEscrow.Status.SETTLED) { assertEq(approvals, required, "settled sem N/N"); assertTrue(h.settledAt(id) * 1000 + 60_000 < h.expiryOf(id), "settled apos expiracao"); assertTrue(h.wasSettled(id)); }
            assertTrue(s != VerumOtcEscrow.Status.VALIDATING && s != VerumOtcEscrow.Status.SETTLING, "estado transitorio persistido");
        }
    }
    /// INV-3: fundos só saem para participantes/tesouraria (o handler só conhece esses endereços; qualquer outro saldo é zero)
    function invariant_noFundsToStrangers() public view { assertEq(h.outsider().balance, 10 ether); assertEq(h.usdc().balanceOf(h.outsider()), 0); assertEq(h.usdc().balanceOf(h.keeper()), 0); assertEq(h.usdc().balanceOf(h.admin()), 0); assertEq(h.usdc().balanceOf(h.guardian()), 0); assertEq(h.keeper().balance, 0); assertEq(h.admin().balance, 0); }
    /// INV-4: cada Deal liquida no máximo uma vez (contador de settle == número de Deals em SETTLED)
    function invariant_settleAtMostOnce() public view { uint256 c; for (uint256 i = 0; i < h.idCount(); i++) { (VerumOtcEscrow.Status s,,,,,,,,) = h.escrow().dealStatus(h.ids(i)); if (s == VerumOtcEscrow.Status.SETTLED) c++; } assertEq(c, h.settled()); }
}
