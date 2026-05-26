// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title GaslessTransferBridge
 * @dev An ERC20Permit token that acts as a gasless bridge and transfer hub.
 * Users can sign EIP-712 messages to transfer or bridge tokens gaslessly,
 * and relayers execute the transactions, receiving a fee in the token.
 */
contract GaslessTransferBridge is ERC20Permit, Ownable {
    // EIP-712 Type Hashes for gasless actions
    bytes32 public constant GASLESS_TRANSFER_TYPEHASH = keccak256(
        "GaslessTransfer(address owner,address recipient,uint256 amount,uint256 fee,uint256 gasLimit,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant GASLESS_BRIDGE_TYPEHASH = keccak256(
        "GaslessBridge(address owner,address recipient,uint256 amount,uint256 fee,uint256 destinationChainId,uint256 gasLimit,uint256 nonce,uint256 deadline)"
    );

    // Mappings for replay protection on custom gasless operations
    mapping(address => uint256) public gaslessNonces;

    // Price of 1 token (scaled by 10**decimals) in Wei.
    // Used to verify that the fee paid by the user in tokens covers the relayer's gas cost.
    uint256 public tokenPriceInWei;

    // Events
    event GaslessTransferExecuted(
        address indexed owner,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        address relayer,
        uint256 nonce
    );

    event GaslessBridgeExecuted(
        address indexed owner,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        uint256 indexed destinationChainId,
        address relayer,
        uint256 nonce
    );

    event TokenPriceUpdated(uint256 oldPrice, uint256 newPrice);

    /**
     * @dev Validate that the fee token paid by the user covers the relayer's gas cost.
     * Guideline: "유저가 지불한 `fee` 토큰이 릴레이어가 실제로 소모한 가스비(Gas Limit * Base Fee)보다 큰지 검증"
     */
    modifier validateGasFee(uint256 fee, uint256 gasLimit) {
        uint256 baseFee = block.basefee;
        // Fallback to tx.gasprice if block.basefee is 0 (common in local test environments or certain chains)
        if (baseFee == 0) {
            baseFee = tx.gasprice;
        }

        uint256 actualGasCostInWei = gasLimit * baseFee;

        // Calculate minimum fee required in tokens based on the token price:
        // actualGasCostInWei (Wei) = fee (Tokens) * tokenPriceInWei / 10**decimals
        // Therefore: fee >= actualGasCostInWei * 10**decimals / tokenPriceInWei
        require(tokenPriceInWei > 0, "GaslessTransferBridge: token price in Wei not set");
        
        uint256 minFeeRequired = (actualGasCostInWei * 10**decimals()) / tokenPriceInWei;
        require(fee >= minFeeRequired, "GaslessTransferBridge: fee too low for gas compensation");
        _;
    }

    /**
     * @dev Constructor initializing the ERC20 token, ERC20Permit domain separator, and initial owner.
     * @param name Name of the token
     * @param symbol Symbol of the token
     * @param initialOwner Address of the owner who receives the initial supply and controls configuration
     * @param _tokenPriceInWei Initial price of the token in Wei
     */
    constructor(
        string memory name,
        string memory symbol,
        address initialOwner,
        uint256 _tokenPriceInWei
    ) 
        ERC20(name, symbol) 
        ERC20Permit(name) 
        Ownable(initialOwner) 
    {
        tokenPriceInWei = _tokenPriceInWei;
        // Mint initial supply of 1,000,000 tokens to the owner
        _mint(initialOwner, 1_000_000 * 10**decimals());
    }

    /**
     * @dev Set the token price in Wei. Only callable by the owner.
     * @param _tokenPriceInWei New price of 1 token in Wei
     */
    function setTokenPrice(uint256 _tokenPriceInWei) external onlyOwner {
        uint256 oldPrice = tokenPriceInWei;
        tokenPriceInWei = _tokenPriceInWei;
        emit TokenPriceUpdated(oldPrice, _tokenPriceInWei);
    }

    /**
     * @dev Mint new tokens. Only callable by the owner (typically the bridge or validators).
     * @param to Address to mint tokens to
     * @param amount Amount of tokens to mint
     */
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /**
     * @dev Performs a gasless transfer of tokens using EIP-712 signature verification.
     * @param owner Address of the token owner signing the transfer
     * @param recipient Address of the recipient
     * @param amount Amount of tokens to transfer
     * @param fee Gas fee in tokens paid to the relayer
     * @param gasLimit Gas limit configured for the transaction (signed by the user)
     * @param nonce Nonce of the owner, must match gaslessNonces[owner]
     * @param deadline Expiration timestamp of the signature
     * @param signature The EIP-712 signature of the GaslessTransfer struct
     */
    function gaslessTransfer(
        address owner,
        address recipient,
        uint256 amount,
        uint256 fee,
        uint256 gasLimit,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external validateGasFee(fee, gasLimit) {
        require(block.timestamp <= deadline, "GaslessTransferBridge: signature expired");
        require(recipient != address(0), "GaslessTransferBridge: invalid recipient");
        require(gaslessNonces[owner] == nonce, "GaslessTransferBridge: invalid nonce");

        // Increment nonce to prevent replay attacks
        gaslessNonces[owner]++;

        // Compute struct hash and build typed data hash
        bytes32 structHash = keccak256(
            abi.encode(
                GASLESS_TRANSFER_TYPEHASH,
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

        // Recover signer and verify ownership
        address signer = ECDSA.recover(hash, signature);
        require(signer == owner, "GaslessTransferBridge: invalid signature");

        // Transfer fee to relayer (msg.sender)
        _transfer(owner, msg.sender, fee);

        // Transfer amount to recipient
        _transfer(owner, recipient, amount);

        emit GaslessTransferExecuted(owner, recipient, amount, fee, msg.sender, nonce);
    }

    /**
     * @dev Performs a gasless bridge out (burn) of tokens using EIP-712 signature verification.
     * @param owner Address of the token owner signing the bridge transaction
     * @param recipient Address of the recipient on the destination chain
     * @param amount Amount of tokens to bridge
     * @param fee Gas fee in tokens paid to the relayer
     * @param destinationChainId Chain ID of the destination network
     * @param gasLimit Gas limit configured for the transaction (signed by the user)
     * @param nonce Nonce of the owner, must match gaslessNonces[owner]
     * @param deadline Expiration timestamp of the signature
     * @param signature The EIP-712 signature of the GaslessBridge struct
     */
    function gaslessBridge(
        address owner,
        address recipient,
        uint256 amount,
        uint256 fee,
        uint256 destinationChainId,
        uint256 gasLimit,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external validateGasFee(fee, gasLimit) {
        require(block.timestamp <= deadline, "GaslessTransferBridge: signature expired");
        require(recipient != address(0), "GaslessTransferBridge: invalid recipient");
        require(gaslessNonces[owner] == nonce, "GaslessTransferBridge: invalid nonce");

        // Increment nonce to prevent replay attacks
        gaslessNonces[owner]++;

        // Compute struct hash and build typed data hash
        bytes32 structHash = keccak256(
            abi.encode(
                GASLESS_BRIDGE_TYPEHASH,
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

        // Recover signer and verify ownership
        address signer = ECDSA.recover(hash, signature);
        require(signer == owner, "GaslessTransferBridge: invalid signature");

        // Transfer fee to relayer (msg.sender)
        _transfer(owner, msg.sender, fee);

        // Burn the bridged tokens from the owner
        _burn(owner, amount);

        emit GaslessBridgeExecuted(owner, recipient, amount, fee, destinationChainId, msg.sender, nonce);
    }
}
