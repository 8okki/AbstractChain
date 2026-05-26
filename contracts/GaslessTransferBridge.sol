// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title GaslessTransferBridge
 * @dev A smart contract that enables gasless transfers and bridging of external ERC20Permit tokens.
 * Users sign a standard ERC20 permit signature and a custom bridge action signature.
 * The relayer submits both to execute the transfer/bridge and receive a fee in the token.
 */
contract GaslessTransferBridge is EIP712, Ownable {
    using SafeERC20 for IERC20;

    // EIP-712 Type Hashes for gasless actions
    bytes32 public constant GASLESS_TRANSFER_TYPEHASH = keccak256(
        "GaslessTransfer(address token,address owner,address recipient,uint256 amount,uint256 fee,uint256 gasLimit,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant GASLESS_BRIDGE_TYPEHASH = keccak256(
        "GaslessBridge(address token,address owner,address recipient,uint256 amount,uint256 fee,uint256 destinationChainId,uint256 gasLimit,uint256 nonce,uint256 deadline)"
    );

    // Mappings for replay protection on custom gasless operations
    mapping(address => uint256) public gaslessNonces;

    // Price of 1 token (scaled by 10**decimals) in Wei.
    // Maps token address to its price in Wei.
    mapping(address => uint256) public tokenPricesInWei;

    // Events
    event GaslessTransferExecuted(
        address indexed token,
        address indexed owner,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        address relayer,
        uint256 nonce
    );

    event GaslessBridgeExecuted(
        address indexed token,
        address indexed owner,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        uint256 destinationChainId,
        address relayer,
        uint256 nonce
    );

    event TokenPriceUpdated(address indexed token, uint256 oldPrice, uint256 newPrice);
    event TokensReleased(address indexed token, address indexed recipient, uint256 amount);

    /**
     * @dev Validate that the fee token paid by the user covers the relayer's gas cost.
     * Guideline: "유저가 지불한 `fee` 토큰이 릴레이어가 실제로 소모한 가스비(Gas Limit * Base Fee)보다 큰지 검증"
     */
    modifier validateGasFee(address token, uint256 fee, uint256 gasLimit) {
        uint256 baseFee = block.basefee;
        // Fallback to tx.gasprice if block.basefee is 0 (common in local test environments or certain chains)
        if (baseFee == 0) {
            baseFee = tx.gasprice;
        }

        uint256 actualGasCostInWei = gasLimit * baseFee;
        uint256 tokenPriceInWei = tokenPricesInWei[token];
        require(tokenPriceInWei > 0, "GaslessTransferBridge: token price in Wei not set");

        uint8 decimals = IERC20Metadata(token).decimals();
        uint256 minFeeRequired = (actualGasCostInWei * 10**decimals) / tokenPriceInWei;
        require(fee >= minFeeRequired, "GaslessTransferBridge: fee too low for gas compensation");
        _;
    }

    /**
     * @dev Constructor initializing EIP-712 domain separator and initial owner.
     * @param initialOwner Address of the owner who controls configuration
     */
    constructor(address initialOwner) 
        EIP712("GaslessTransferBridge", "1") 
        Ownable(initialOwner) 
    {}

    /**
     * @dev Set the token price in Wei. Only callable by the owner.
     * @param token Address of the ERC20 token
     * @param _tokenPriceInWei New price of 1 token (scaled by 10**decimals) in Wei
     */
    function setTokenPrice(address token, uint256 _tokenPriceInWei) external onlyOwner {
        uint256 oldPrice = tokenPricesInWei[token];
        tokenPricesInWei[token] = _tokenPriceInWei;
        emit TokenPriceUpdated(token, oldPrice, _tokenPriceInWei);
    }

    /**
     * @dev Exposes the contract's domain separator.
     */
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /**
     * @dev Performs a gasless transfer of external tokens using a Permit signature and a Bridge signature.
     * @param token Address of the ERC20 token to transfer
     * @param owner Address of the token owner signing the transfer
     * @param recipient Address of the recipient
     * @param amount Amount of tokens to transfer
     * @param fee Gas fee in tokens paid to the relayer
     * @param gasLimit Gas limit configured for the transaction (signed by the user)
     * @param nonce Nonce of the owner, must match gaslessNonces[owner]
     * @param deadline Expiration timestamp of the signature
     * @param permitV v parameter of the token permit signature
     * @param permitR r parameter of the token permit signature
     * @param permitS s parameter of the token permit signature
     * @param bridgeSignature The EIP-712 signature of the GaslessTransfer struct
     */
    function gaslessTransfer(
        address token,
        address owner,
        address recipient,
        uint256 amount,
        uint256 fee,
        uint256 gasLimit,
        uint256 nonce,
        uint256 deadline,
        uint8 permitV,
        bytes32 permitR,
        bytes32 permitS,
        bytes calldata bridgeSignature
    ) external validateGasFee(token, fee, gasLimit) {
        require(block.timestamp <= deadline, "GaslessTransferBridge: signature expired");
        require(recipient != address(0), "GaslessTransferBridge: invalid recipient");
        require(gaslessNonces[owner] == nonce, "GaslessTransferBridge: invalid nonce");

        // Increment nonce to prevent replay attacks
        gaslessNonces[owner]++;

        // 1. Execute standard ERC20 Permit to grant allowance to the bridge contract
        IERC20Permit(token).permit(owner, address(this), amount + fee, deadline, permitV, permitR, permitS);

        // 2. Verify custom EIP-712 bridge signature
        bytes32 structHash = keccak256(
            abi.encode(
                GASLESS_TRANSFER_TYPEHASH,
                token,
                owner,
                recipient,
                amount,
                fee,
                gasLimit,
                nonce,
                deadline
            )
        );
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(hash, bridgeSignature);
        require(signer == owner, "GaslessTransferBridge: invalid signature");

        // 3. Execute transfers: pay fee to relayer and send amount to recipient
        IERC20(token).safeTransferFrom(owner, msg.sender, fee);
        IERC20(token).safeTransferFrom(owner, recipient, amount);

        emit GaslessTransferExecuted(token, owner, recipient, amount, fee, msg.sender, nonce);
    }

    /**
     * @dev Performs a gasless bridge transfer of external tokens.
     * Tokens are locked in this contract, and a fee is paid to the relayer.
     * @param token Address of the ERC20 token to bridge
     * @param owner Address of the token owner signing the bridge transaction
     * @param recipient Address of the recipient on the destination chain
     * @param amount Amount of tokens to bridge
     * @param fee Gas fee in tokens paid to the relayer
     * @param destinationChainId Chain ID of the destination network
     * @param gasLimit Gas limit configured for the transaction (signed by the user)
     * @param nonce Nonce of the owner, must match gaslessNonces[owner]
     * @param deadline Expiration timestamp of the signature
     * @param permitV v parameter of the token permit signature
     * @param permitR r parameter of the token permit signature
     * @param permitS s parameter of the token permit signature
     * @param bridgeSignature The EIP-712 signature of the GaslessBridge struct
     */
    function gaslessBridge(
        address token,
        address owner,
        address recipient,
        uint256 amount,
        uint256 fee,
        uint256 destinationChainId,
        uint256 gasLimit,
        uint256 nonce,
        uint256 deadline,
        uint8 permitV,
        bytes32 permitR,
        bytes32 permitS,
        bytes calldata bridgeSignature
    ) external validateGasFee(token, fee, gasLimit) {
        require(block.timestamp <= deadline, "GaslessTransferBridge: signature expired");
        require(recipient != address(0), "GaslessTransferBridge: invalid recipient");
        require(gaslessNonces[owner] == nonce, "GaslessTransferBridge: invalid nonce");

        // Increment nonce to prevent replay attacks
        gaslessNonces[owner]++;

        // 1. Execute standard ERC20 Permit to grant allowance to the bridge contract
        IERC20Permit(token).permit(owner, address(this), amount + fee, deadline, permitV, permitR, permitS);

        // 2. Verify custom EIP-712 bridge signature
        bytes32 structHash = keccak256(
            abi.encode(
                GASLESS_BRIDGE_TYPEHASH,
                token,
                owner,
                recipient,
                amount,
                fee,
                destinationChainId,
                gasLimit,
                nonce,
                deadline
            )
        );
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(hash, bridgeSignature);
        require(signer == owner, "GaslessTransferBridge: invalid signature");

        // 3. Execute transfers: pay fee to relayer, lock bridged amount in contract
        IERC20(token).safeTransferFrom(owner, msg.sender, fee);
        IERC20(token).safeTransferFrom(owner, address(this), amount);

        emit GaslessBridgeExecuted(token, owner, recipient, amount, fee, destinationChainId, msg.sender, nonce);
    }

    /**
     * @dev Release locked tokens (bridge in / unlock). Only callable by the owner (bridge validators).
     * @param token Address of the ERC20 token to release
     * @param recipient Address of the recipient
     * @param amount Amount of tokens to release
     */
    function release(
        address token,
        address recipient,
        uint256 amount
    ) external onlyOwner {
        IERC20(token).safeTransfer(recipient, amount);
        emit TokensReleased(token, recipient, amount);
    }
}
