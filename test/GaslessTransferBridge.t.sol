// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../contracts/GaslessTransferBridge.sol";
import "./mocks/MockERC20Permit.sol";

contract GaslessTransferBridgeTest is Test {
    GaslessTransferBridge public bridge;
    MockERC20Permit public token;

    // Test accounts
    uint256 public ownerPrivateKey = 0xA11CE;
    address public owner;
    address public recipient = address(0x2);
    address public relayer = address(0x3);

    // Initial configuration
    // 1 token = 10^14 Wei (meaning 10,000 tokens = 1 ETH)
    uint256 public constant INITIAL_TOKEN_PRICE = 1e14; 

    function setUp() public {
        owner = vm.addr(ownerPrivateKey);
        
        // Deploy Mock Token
        token = new MockERC20Permit("Mock ERC20 Permit", "MOCK");

        // Deploy GaslessTransferBridge
        bridge = new GaslessTransferBridge(address(this));

        // Set token price in the bridge
        bridge.setTokenPrice(address(token), INITIAL_TOKEN_PRICE);

        // Mint mock tokens to owner
        token.mint(owner, 10_000 * 1e18);
    }

    /**
     * @dev Test setting the token price by owner.
     */
    function testSetTokenPrice() public {
        bridge.setTokenPrice(address(token), 2e14);
        assertEq(bridge.tokenPricesInWei(address(token)), 2e14);
    }

    /**
     * @dev Test setting the token price by non-owner reverts.
     */
    function testSetTokenPrice_NotOwner_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", owner)
        );
        bridge.setTokenPrice(address(token), 2e14);
    }

    /**
     * @dev Helper to generate the token's Permit signature (EIP-2612)
     */
    function getTokenPermitSignature(
        address tokenOwner,
        address spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                tokenOwner,
                spender,
                value,
                nonce,
                deadline
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                structHash
            )
        );

        (v, r, s) = vm.sign(ownerPrivateKey, digest);
    }

    /**
     * @dev Helper to generate the bridge's execution signature (EIP-712)
     */
    function getBridgeTransferSignature(
        address tokenOwner,
        address to,
        uint256 amount,
        uint256 fee,
        uint256 gasLimit,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                bridge.GASLESS_TRANSFER_TYPEHASH(),
                address(token),
                tokenOwner,
                to,
                amount,
                fee,
                gasLimit,
                nonce,
                deadline
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                bridge.DOMAIN_SEPARATOR(),
                structHash
            )
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPrivateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /**
     * @dev Helper to generate the bridge's execution signature for bridging (EIP-712)
     */
    function getBridgeActionSignature(
        address tokenOwner,
        address to,
        uint256 amount,
        uint256 fee,
        uint256 destinationChainId,
        uint256 gasLimit,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                bridge.GASLESS_BRIDGE_TYPEHASH(),
                address(token),
                tokenOwner,
                to,
                amount,
                fee,
                destinationChainId,
                gasLimit,
                nonce,
                deadline
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                bridge.DOMAIN_SEPARATOR(),
                structHash
            )
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPrivateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /**
     * @dev Test successful gasless transfer
     */
    function testGaslessTransfer_Success() public {
        uint256 amount = 100 * 1e18;
        uint256 fee = 2 * 1e18; // 2 tokens fee
        uint256 gasLimit = 100_000;
        uint256 deadline = block.timestamp + 3600;
        
        uint256 permitNonce = token.nonces(owner);
        uint256 bridgeNonce = bridge.gaslessNonces(owner);

        // gasLimit * baseFee = 100,000 * 1 gwei = 1e14 Wei
        // minFeeRequired = (1e14 * 1e18) / 1e14 = 1 token
        // Since fee (2 tokens) >= minFeeRequired (1 token), this should succeed.
        vm.fee(1 gwei);

        // 1. Get permit signature (approving bridge contract to spend amount + fee)
        (uint8 permitV, bytes32 permitR, bytes32 permitS) = getTokenPermitSignature(
            owner,
            address(bridge),
            amount + fee,
            permitNonce,
            deadline
        );

        // 2. Get bridge transfer signature
        bytes memory bridgeSignature = getBridgeTransferSignature(
            owner,
            recipient,
            amount,
            fee,
            gasLimit,
            bridgeNonce,
            deadline
        );

        uint256 initialOwnerBalance = token.balanceOf(owner);
        uint256 initialRecipientBalance = token.balanceOf(recipient);
        uint256 initialRelayerBalance = token.balanceOf(relayer);

        // Execute gasless transfer as the relayer
        vm.prank(relayer);
        bridge.gaslessTransfer(
            address(token),
            owner,
            recipient,
            amount,
            fee,
            gasLimit,
            bridgeNonce,
            deadline,
            permitV,
            permitR,
            permitS,
            bridgeSignature
        );

        // Verifications
        assertEq(token.balanceOf(owner), initialOwnerBalance - amount - fee);
        assertEq(token.balanceOf(recipient), initialRecipientBalance + amount);
        assertEq(token.balanceOf(relayer), initialRelayerBalance + fee);
        assertEq(bridge.gaslessNonces(owner), bridgeNonce + 1);
        assertEq(token.allowance(owner, address(bridge)), 0); // Spends exactly amount + fee
    }

    /**
     * @dev Test gasless transfer fails when fee is too low for gas compensation
     */
    function testGaslessTransfer_FeeTooLow_Reverts() public {
        uint256 amount = 100 * 1e18;
        uint256 fee = 0.5 * 1e18; // 0.5 tokens fee (less than 1 required)
        uint256 gasLimit = 100_000;
        uint256 deadline = block.timestamp + 3600;

        uint256 permitNonce = token.nonces(owner);
        uint256 bridgeNonce = bridge.gaslessNonces(owner);

        // gasLimit * baseFee = 100,000 * 1 gwei = 1e14 Wei
        // minFeeRequired = 1 token. Since fee is 0.5 token, it should revert.
        vm.fee(1 gwei);

        (uint8 permitV, bytes32 permitR, bytes32 permitS) = getTokenPermitSignature(
            owner,
            address(bridge),
            amount + fee,
            permitNonce,
            deadline
        );

        bytes memory bridgeSignature = getBridgeTransferSignature(
            owner,
            recipient,
            amount,
            fee,
            gasLimit,
            bridgeNonce,
            deadline
        );

        vm.prank(relayer);
        vm.expectRevert("GaslessTransferBridge: fee too low for gas compensation");
        bridge.gaslessTransfer(
            address(token),
            owner,
            recipient,
            amount,
            fee,
            gasLimit,
            bridgeNonce,
            deadline,
            permitV,
            permitR,
            permitS,
            bridgeSignature
        );
    }

    /**
     * @dev Test gasless transfer fails if signature is replayed (bridge nonce mismatch)
     */
    function testGaslessTransfer_ReplayAttack_Reverts() public {
        uint256 amount = 100 * 1e18;
        uint256 fee = 2 * 1e18;
        uint256 gasLimit = 100_000;
        uint256 deadline = block.timestamp + 3600;

        uint256 permitNonce = token.nonces(owner);
        uint256 bridgeNonce = bridge.gaslessNonces(owner);

        vm.fee(1 gwei);

        (uint8 permitV, bytes32 permitR, bytes32 permitS) = getTokenPermitSignature(
            owner,
            address(bridge),
            amount + fee,
            permitNonce,
            deadline
        );

        bytes memory bridgeSignature = getBridgeTransferSignature(
            owner,
            recipient,
            amount,
            fee,
            gasLimit,
            bridgeNonce,
            deadline
        );

        // First execution (Success)
        vm.prank(relayer);
        bridge.gaslessTransfer(
            address(token),
            owner,
            recipient,
            amount,
            fee,
            gasLimit,
            bridgeNonce,
            deadline,
            permitV,
            permitR,
            permitS,
            bridgeSignature
        );

        // Second execution with same signatures (should fail due to nonce increment on both token permit and bridge)
        vm.prank(relayer);
        vm.expectRevert("GaslessTransferBridge: invalid nonce");
        bridge.gaslessTransfer(
            address(token),
            owner,
            recipient,
            amount,
            fee,
            gasLimit,
            bridgeNonce,
            deadline,
            permitV,
            permitR,
            permitS,
            bridgeSignature
        );
    }

    /**
     * @dev Test successful gasless bridge transaction (locks tokens in bridge)
     */
    function testGaslessBridge_Success() public {
        uint256 amount = 500 * 1e18;
        uint256 fee = 3 * 1e18;
        uint256 destinationChainId = 10; // Optimism
        uint256 gasLimit = 150_000;
        uint256 deadline = block.timestamp + 3600;

        uint256 permitNonce = token.nonces(owner);
        uint256 bridgeNonce = bridge.gaslessNonces(owner);

        // gasLimit * baseFee = 150,000 * 1 gwei = 1.5e14 Wei
        // minFeeRequired = (1.5e14 * 1e18) / 1e14 = 1.5 tokens
        // Since fee (3 tokens) >= minFeeRequired, this should succeed.
        vm.fee(1 gwei);

        (uint8 permitV, bytes32 permitR, bytes32 permitS) = getTokenPermitSignature(
            owner,
            address(bridge),
            amount + fee,
            permitNonce,
            deadline
        );

        bytes memory bridgeSignature = getBridgeActionSignature(
            owner,
            recipient,
            amount,
            fee,
            destinationChainId,
            gasLimit,
            bridgeNonce,
            deadline
        );

        uint256 initialOwnerBalance = token.balanceOf(owner);
        uint256 initialRelayerBalance = token.balanceOf(relayer);
        uint256 initialBridgeBalance = token.balanceOf(address(bridge));

        // Execute gasless bridge as the relayer
        vm.prank(relayer);
        bridge.gaslessBridge(
            address(token),
            owner,
            recipient,
            amount,
            fee,
            destinationChainId,
            gasLimit,
            bridgeNonce,
            deadline,
            permitV,
            permitR,
            permitS,
            bridgeSignature
        );

        // Verifications
        assertEq(token.balanceOf(owner), initialOwnerBalance - amount - fee);
        assertEq(token.balanceOf(relayer), initialRelayerBalance + fee);
        // Tokens should be locked in the bridge contract
        assertEq(token.balanceOf(address(bridge)), initialBridgeBalance + amount);
        assertEq(bridge.gaslessNonces(owner), bridgeNonce + 1);
    }

    /**
     * @dev Test that the owner can release locked tokens (bridge in)
     */
    function testRelease_Success() public {
        uint256 amount = 100 * 1e18;
        
        // Mint tokens directly to bridge to simulate locked tokens
        token.mint(address(bridge), amount);

        uint256 initialBridgeBalance = token.balanceOf(address(bridge));
        uint256 initialRecipientBalance = token.balanceOf(recipient);

        // Release locked tokens to recipient
        bridge.release(address(token), recipient, amount);

        assertEq(token.balanceOf(address(bridge)), initialBridgeBalance - amount);
        assertEq(token.balanceOf(recipient), initialRecipientBalance + amount);
    }

    /**
     * @dev Test that non-owner cannot release locked tokens
     */
    function testRelease_NotOwner_Reverts() public {
        uint256 amount = 100 * 1e18;

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", owner)
        );
        bridge.release(address(token), recipient, amount);
    }
}
