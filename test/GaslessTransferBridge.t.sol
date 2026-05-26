// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../contracts/GaslessTransferBridge.sol";

contract GaslessTransferBridgeTest is Test {
    GaslessTransferBridge public bridge;

    // Test accounts
    uint256 public ownerPrivateKey = 0xA11CE;
    address public owner;
    address public recipient = address(0x2);
    address public relayer = address(0x3);

    // Initial configuration
    // 1 token = 10^14 Wei (meaning 10,000 tokens = 1 ETH)
    uint256 public constant INITIAL_TOKEN_PRICE = 1e14; 
    uint256 public constant INITIAL_SUPPLY = 1_000_000 * 1e18;

    function setUp() public {
        owner = vm.addr(ownerPrivateKey);
        
        // Deploy GaslessTransferBridge with initial settings
        bridge = new GaslessTransferBridge(
            "Gasless Transfer Bridge Token",
            "GTBT",
            address(this), // Test contract is owner
            INITIAL_TOKEN_PRICE
        );

        // Transfer some initial tokens to owner to test with
        bridge.transfer(owner, 10_000 * 1e18);
    }

    /**
     * @dev Test setting the token price by owner.
     */
    function testSetTokenPrice() public {
        bridge.setTokenPrice(2e14);
        assertEq(bridge.tokenPriceInWei(), 2e14);
    }

    /**
     * @dev Test setting the token price by non-owner reverts.
     */
    function testSetTokenPrice_NotOwner_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", owner)
        );
        bridge.setTokenPrice(2e14);
    }

    /**
     * @dev Helper to generate the signature for GaslessTransfer
     */
    function getTransferSignature(
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
     * @dev Helper to generate the signature for GaslessBridge
     */
    function getBridgeSignature(
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
        uint256 nonce = bridge.gaslessNonces(owner);
        uint256 deadline = block.timestamp + 3600;

        // Set base fee in test VM so the fee is validated
        // gasLimit * baseFee = 100,000 * 1 gwei = 1e14 Wei
        // minFeeRequired = (1e14 * 1e18) / 1e14 = 1e18 (1 token)
        // Since fee (2 tokens) >= minFeeRequired (1 token), this should succeed.
        vm.fee(1 gwei);

        bytes memory signature = getTransferSignature(
            owner,
            recipient,
            amount,
            fee,
            gasLimit,
            nonce,
            deadline
        );

        uint256 initialOwnerBalance = bridge.balanceOf(owner);
        uint256 initialRecipientBalance = bridge.balanceOf(recipient);
        uint256 initialRelayerBalance = bridge.balanceOf(relayer);

        // Execute gasless transfer as the relayer
        vm.prank(relayer);
        bridge.gaslessTransfer(
            owner,
            recipient,
            amount,
            fee,
            gasLimit,
            nonce,
            deadline,
            signature
        );

        // Verifications
        assertEq(bridge.balanceOf(owner), initialOwnerBalance - amount - fee);
        assertEq(bridge.balanceOf(recipient), initialRecipientBalance + amount);
        assertEq(bridge.balanceOf(relayer), initialRelayerBalance + fee);
        assertEq(bridge.gaslessNonces(owner), nonce + 1);
    }

    /**
     * @dev Test gasless transfer fails when fee is too low for gas compensation
     */
    function testGaslessTransfer_FeeTooLow_Reverts() public {
        uint256 amount = 100 * 1e18;
        uint256 fee = 0.5 * 1e18; // 0.5 tokens fee (less than 1 required)
        uint256 gasLimit = 100_000;
        uint256 nonce = bridge.gaslessNonces(owner);
        uint256 deadline = block.timestamp + 3600;

        // gasLimit * baseFee = 100,000 * 1 gwei = 1e14 Wei
        // minFeeRequired = 1 token. Since fee is 0.5 token, it should revert.
        vm.fee(1 gwei);

        bytes memory signature = getTransferSignature(
            owner,
            recipient,
            amount,
            fee,
            gasLimit,
            nonce,
            deadline
        );

        vm.prank(relayer);
        vm.expectRevert("GaslessTransferBridge: fee too low for gas compensation");
        bridge.gaslessTransfer(
            owner,
            recipient,
            amount,
            fee,
            gasLimit,
            nonce,
            deadline,
            signature
        );
    }

    /**
     * @dev Test gasless transfer fails if signature is expired
     */
    function testGaslessTransfer_ExpiredSignature_Reverts() public {
        uint256 amount = 100 * 1e18;
        uint256 fee = 2 * 1e18;
        uint256 gasLimit = 100_000;
        uint256 nonce = bridge.gaslessNonces(owner);
        uint256 deadline = block.timestamp - 1; // Expired

        vm.fee(1 gwei);

        bytes memory signature = getTransferSignature(
            owner,
            recipient,
            amount,
            fee,
            gasLimit,
            nonce,
            deadline
        );

        vm.prank(relayer);
        vm.expectRevert("GaslessTransferBridge: signature expired");
        bridge.gaslessTransfer(
            owner,
            recipient,
            amount,
            fee,
            gasLimit,
            nonce,
            deadline,
            signature
        );
    }

    /**
     * @dev Test gasless transfer fails if signature is replayed (nonce mismatch)
     */
    function testGaslessTransfer_ReplayAttack_Reverts() public {
        uint256 amount = 100 * 1e18;
        uint256 fee = 2 * 1e18;
        uint256 gasLimit = 100_000;
        uint256 nonce = bridge.gaslessNonces(owner);
        uint256 deadline = block.timestamp + 3600;

        vm.fee(1 gwei);

        bytes memory signature = getTransferSignature(
            owner,
            recipient,
            amount,
            fee,
            gasLimit,
            nonce,
            deadline
        );

        // First execution (Success)
        vm.prank(relayer);
        bridge.gaslessTransfer(
            owner,
            recipient,
            amount,
            fee,
            gasLimit,
            nonce,
            deadline,
            signature
        );

        // Second execution with same signature (should fail due to nonce increment)
        vm.prank(relayer);
        vm.expectRevert("GaslessTransferBridge: invalid nonce");
        bridge.gaslessTransfer(
            owner,
            recipient,
            amount,
            fee,
            gasLimit,
            nonce,
            deadline,
            signature
        );
    }

    /**
     * @dev Test successful gasless bridge transaction (burns tokens)
     */
    function testGaslessBridge_Success() public {
        uint256 amount = 500 * 1e18;
        uint256 fee = 3 * 1e18;
        uint256 destinationChainId = 10; // Optimism
        uint256 gasLimit = 150_000;
        uint256 nonce = bridge.gaslessNonces(owner);
        uint256 deadline = block.timestamp + 3600;

        // gasLimit * baseFee = 150,000 * 1 gwei = 1.5e14 Wei
        // minFeeRequired = (1.5e14 * 1e18) / 1e14 = 1.5 tokens
        // Since fee (3 tokens) >= minFeeRequired, this should succeed.
        vm.fee(1 gwei);

        bytes memory signature = getBridgeSignature(
            owner,
            recipient,
            amount,
            fee,
            destinationChainId,
            gasLimit,
            nonce,
            deadline
        );

        uint256 initialOwnerBalance = bridge.balanceOf(owner);
        uint256 initialRelayerBalance = bridge.balanceOf(relayer);
        uint256 initialTotalSupply = bridge.totalSupply();

        // Execute gasless bridge as the relayer
        vm.prank(relayer);
        bridge.gaslessBridge(
            owner,
            recipient,
            amount,
            fee,
            destinationChainId,
            gasLimit,
            nonce,
            deadline,
            signature
        );

        // Verifications
        assertEq(bridge.balanceOf(owner), initialOwnerBalance - amount - fee);
        assertEq(bridge.balanceOf(relayer), initialRelayerBalance + fee);
        // Tokens should be burned, so total supply decreases by `amount`
        assertEq(bridge.totalSupply(), initialTotalSupply - amount);
        assertEq(bridge.gaslessNonces(owner), nonce + 1);
    }

    /**
     * @dev Test standard ERC20Permit functionality (sanity check)
     */
    function testStandardERC20Permit() public {
        uint256 amount = 1000 * 1e18;
        uint256 deadline = block.timestamp + 3600;
        uint256 nonce = bridge.nonces(owner);

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                address(this),
                amount,
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

        // Execute permit
        bridge.permit(owner, address(this), amount, deadline, v, r, s);

        // Verify allowance was set
        assertEq(bridge.allowance(owner, address(this)), amount);
    }
}
