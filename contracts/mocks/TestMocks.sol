// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
// Contratos auxiliares SOMENTE para testes (nunca em deploy): ERC-20 configurável, guarda de preço falsa, token reentrante.
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockERC20 is IERC20 {
    string public name; string public symbol; uint8 public immutable decimals;
    mapping(address => uint256) public override balanceOf; mapping(address => mapping(address => uint256)) public override allowance; uint256 public override totalSupply;
    uint256 public feeBps;            // simula token fee-on-transfer
    address public revertOnTransferTo; // simula destinatário que quebra a transferência (falha parcial)
    constructor(string memory n, string memory s, uint8 d) { name = n; symbol = s; decimals = d; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; totalSupply += amount; }
    function setFeeBps(uint256 bps) external { feeBps = bps; }
    function setRevertOnTransferTo(address who) external { revertOnTransferTo = who; }
    function approve(address spender, uint256 amount) external override returns (bool) { allowance[msg.sender][spender] = amount; emit Approval(msg.sender, spender, amount); return true; }
    function transfer(address to, uint256 amount) external override returns (bool) { _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external override returns (bool) { uint256 al = allowance[from][msg.sender]; require(al >= amount, "allowance"); allowance[from][msg.sender] = al - amount; _move(from, to, amount); return true; }
    function _move(address from, address to, uint256 amount) internal virtual { require(to != revertOnTransferTo, "recipient rejects"); require(balanceOf[from] >= amount, "balance"); uint256 fee = amount * feeBps / 10_000; balanceOf[from] -= amount; balanceOf[to] += amount - fee; totalSupply -= fee; emit Transfer(from, to, amount - fee); }
}

interface IEscrowLike { function refund(string calldata dealId, uint8 legPos) external; function settle(string calldata dealId, bytes32 preimage) external; }
/// @dev Token que tenta reentrar no escrow durante a transferência (ataque de reentrância via token malicioso na allowlist).
contract ReentrantERC20 is MockERC20 {
    IEscrowLike public escrow; string public targetDeal; uint8 public mode; // 1 = refund, 2 = settle
    bool public reentered; bool public reentryReverted;
    constructor() MockERC20("Evil", "EVIL", 6) {}
    function arm(address escrow_, string calldata dealId, uint8 mode_) external { escrow = IEscrowLike(escrow_); targetDeal = dealId; mode = mode_; }
    function _move(address from, address to, uint256 amount) internal override {
        super._move(from, to, amount);
        if (address(escrow) != address(0) && from == address(escrow) && !reentered) {
            reentered = true;
            if (mode == 1) { try escrow.refund(targetDeal, 0) { } catch { reentryReverted = true; } }
            else if (mode == 2) { try escrow.settle(targetDeal, bytes32(0)) { } catch { reentryReverted = true; } }
        }
    }
}

contract MockPriceGuard {
    bool public ok = true; uint256 public calls;
    function set(bool v) external { ok = v; }
    function validate(bytes32, bytes32, bytes32, uint256) external view returns (bool) { return ok; }
}
