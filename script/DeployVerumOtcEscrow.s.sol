// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VerumOtcEscrow} from "../contracts/VerumOtcEscrow.sol";

/// @notice Deploy determinístico por ambiente. Chaves NUNCA no código: `--account`/`--ledger` do forge ou signer externo.
/// Uso: forge script script/DeployVerumOtcEscrow.s.sol --rpc-url $RPC --account deployer --broadcast --verify
/// Variáveis: OTC_ADMIN (multisig), OTC_GUARDIAN (multisig), OTC_REGISTRAR (chave KMS do keeper), OTC_TREASURY, OTC_PRICE_GUARD (0x0 = sem guarda), OTC_NATIVE_ID (keccak do id canônico do ativo nativo)
contract DeployVerumOtcEscrow is Script {
    function run() external returns (VerumOtcEscrow escrow) {
        address admin = vm.envAddress("OTC_ADMIN"); address guardian = vm.envAddress("OTC_GUARDIAN"); address registrar = vm.envAddress("OTC_REGISTRAR");
        address treasury = vm.envAddress("OTC_TREASURY"); address guard = vm.envOr("OTC_PRICE_GUARD", address(0)); bytes32 nativeId = vm.envBytes32("OTC_NATIVE_ID");
        require(admin.code.length != 0 && guardian.code.length != 0, "admin/guardian devem ser multisig (contrato)"); // produção: Safe; em testnet use --sig com override
        vm.startBroadcast();
        escrow = new VerumOtcEscrow(admin, guardian, registrar, treasury, guard, nativeId);
        vm.stopBroadcast();
        console2.log("VerumOtcEscrow:", address(escrow)); console2.log("domainSeparator:"); console2.logBytes32(escrow.domainSeparator());
    }
}
