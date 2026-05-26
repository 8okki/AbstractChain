const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { ethers } = require('ethers');

// Load environment variables
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5001;
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;

if (!CONTRACT_ADDRESS || !RELAYER_PRIVATE_KEY) {
    console.error("\x1b[31mError: CONTRACT_ADDRESS and RELAYER_PRIVATE_KEY must be set in the .env file.\x1b[0m");
    process.exit(1);
}

// Connect to Ethereum Provider & Relayer Wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const relayerWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);

// Load Contract ABI and Artifact
let contractAbi;
try {
    const contractJson = require('/Users/thomaslee/Documents/AbtstractChain/out/GaslessTransferBridge.sol/GaslessTransferBridge.json');
    contractAbi = contractJson.abi;
} catch (error) {
    console.error("\x1b[31mError loading contract JSON build artifact:\x1b[0m", error);
    process.exit(1);
}

const contract = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, relayerWallet);

// Minimal ERC20 ABI to query external token details
const ERC20_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)"
];

// Initialize server information console logs
console.log("\x1b[36m==================================================\x1b[0m");
console.log("\x1b[32m       Gas Relayer Server Initialization          \x1b[0m");
console.log("\x1b[36m==================================================\x1b[0m");
console.log(`[RPC URL]          : ${RPC_URL}`);
console.log(`[Contract Address] : ${CONTRACT_ADDRESS}`);
console.log(`[Relayer Address]  : ${relayerWallet.address}`);
console.log("\x1b[36m==================================================\x1b[0m");

// Safe BigInt parser
function safeBigInt(val, fieldName) {
    if (val === undefined || val === null || val === '') {
        throw new Error(`Field '${fieldName}' is missing.`);
    }
    try {
        return BigInt(val);
    } catch (err) {
        throw new Error(`Field '${fieldName}' must be a valid numeric/BigInt representation. Got: '${val}'`);
    }
}

// Request logger middleware
app.use((req, res, next) => {
    const now = new Date().toISOString();
    console.log(`[${now}] ${req.method} ${req.url}`);
    next();
});

/**
 * GET /api/info/:token
 * Returns contract details, current token price, and general configuration for the specific ERC20 token
 */
app.get('/api/info/:token', async (req, res) => {
    const { token } = req.params;

    if (!ethers.isAddress(token)) {
        return res.status(400).json({ error: "Invalid token address format" });
    }

    try {
        const tokenContract = new ethers.Contract(token, ERC20_ABI, provider);
        const [price, dec, name, symbol] = await Promise.all([
            contract.tokenPricesInWei(token),
            tokenContract.decimals(),
            tokenContract.name(),
            tokenContract.symbol()
        ]);

        return res.json({
            bridgeAddress: CONTRACT_ADDRESS,
            tokenAddress: token,
            tokenName: name,
            tokenSymbol: symbol,
            tokenDecimals: Number(dec),
            tokenPriceInWei: price.toString(),
            relayerAddress: relayerWallet.address
        });
    } catch (error) {
        console.error(`Error fetching info for token ${token}:`, error);
        return res.status(500).json({ error: "Failed to fetch token configuration details", message: error.message });
    }
});

/**
 * GET /api/nonce/:address
 * Calls the contract's gaslessNonces mapping to get the current nonce for the address
 */
app.get('/api/nonce/:address', async (req, res) => {
    const { address } = req.params;

    if (!ethers.isAddress(address)) {
        return res.status(400).json({ error: "Invalid Ethereum address format" });
    }

    try {
        const nonce = await contract.gaslessNonces(address);
        return res.json({
            address: address,
            nonce: nonce.toString()
        });
    } catch (error) {
        console.error(`Error fetching nonce for address ${address}:`, error);
        return res.status(500).json({ error: "Failed to fetch nonce from contract", message: error.message });
    }
});

/**
 * POST /api/transfer
 * Receives the parameters to execute gaslessTransfer on the contract
 */
app.post('/api/transfer', async (req, res) => {
    const {
        token,
        owner,
        recipient,
        amount,
        fee,
        gasLimit,
        nonce,
        deadline,
        permitV,
        permitR,
        permitS,
        signature // bridge signature
    } = req.body;

    // 1. Basic validation of inputs
    if (!token || !owner || !recipient || !signature) {
        return res.status(400).json({ error: "Missing required string/address/signature parameters." });
    }

    if (!ethers.isAddress(token) || !ethers.isAddress(owner) || !ethers.isAddress(recipient)) {
        return res.status(400).json({ error: "Token, owner and recipient must be valid Ethereum addresses." });
    }

    if (!signature.startsWith('0x') || signature.length < 130) {
        return res.status(400).json({ error: "Signature must be a valid hex string." });
    }

    if (permitR === undefined || permitS === undefined || permitV === undefined) {
        return res.status(400).json({ error: "Missing standard ERC20 permit signature parameters (permitV, permitR, permitS)." });
    }

    let parsedAmount, parsedFee, parsedGasLimit, parsedNonce, parsedDeadline, parsedPermitV;
    try {
        parsedAmount = safeBigInt(amount, 'amount');
        parsedFee = safeBigInt(fee, 'fee');
        parsedGasLimit = safeBigInt(gasLimit, 'gasLimit');
        parsedNonce = safeBigInt(nonce, 'nonce');
        parsedDeadline = safeBigInt(deadline, 'deadline');
        parsedPermitV = Number(permitV);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    // 2. Deadline check
    const currentTimestamp = BigInt(Math.floor(Date.now() / 1000));
    if (parsedDeadline < currentTimestamp) {
        return res.status(400).json({
            error: "Signature deadline has expired.",
            details: { deadline: parsedDeadline.toString(), currentTimestamp: currentTimestamp.toString() }
        });
    }

    try {
        // Fetch contract details dynamically for the target token
        const tokenContract = new ethers.Contract(token, ERC20_ABI, provider);
        const decimals = await tokenContract.decimals();
        const tokenPriceInWei = await contract.tokenPricesInWei(token);

        if (tokenPriceInWei === 0n) {
            return res.status(400).json({ error: `GaslessTransferBridge: token price in Wei for ${token} is not set on the contract` });
        }

        // 3. Backend fee sanity check based on current block baseFee (or gasPrice)
        const block = await provider.getBlock("latest");
        let baseFee = block ? block.baseFeePerGas : null;
        if (!baseFee || baseFee === 0n) {
            const feeData = await provider.getFeeData();
            baseFee = feeData.gasPrice || 0n;
        }

        const actualGasCostInWei = parsedGasLimit * baseFee;
        const minFeeRequired = (actualGasCostInWei * (10n ** BigInt(decimals))) / tokenPriceInWei;

        if (parsedFee < minFeeRequired) {
            console.log(`[Validation Failed] Fee too low. Provided: ${parsedFee}, Min required: ${minFeeRequired}`);
            return res.status(400).json({
                error: "Fee too low for gas compensation",
                details: {
                    providedFee: parsedFee.toString(),
                    minFeeRequired: minFeeRequired.toString(),
                    estimatedGasPrice: baseFee.toString(),
                    gasLimit: parsedGasLimit.toString()
                }
            });
        }

        // 4. Simulate the transaction using estimateGas (revert checks)
        console.log(`[Simulating] Simulating transfer of ${parsedAmount} ${token} from ${owner} to ${recipient}...`);
        try {
            await contract.gaslessTransfer.estimateGas(
                token,
                owner,
                recipient,
                parsedAmount,
                parsedFee,
                parsedGasLimit,
                parsedNonce,
                parsedDeadline,
                parsedPermitV,
                permitR,
                permitS,
                signature
            );
        } catch (simError) {
            console.error(`[Simulation Failed] gaslessTransfer simulation failed:`, simError.message);
            return res.status(400).json({
                error: "Transaction simulation failed. It will revert on-chain.",
                message: simError.message || simError.toString()
            });
        }

        // 5. Send transaction
        console.log(`[Executing] Sending gaslessTransfer on-chain...`);
        const tx = await contract.gaslessTransfer(
            token,
            owner,
            recipient,
            parsedAmount,
            parsedFee,
            parsedGasLimit,
            parsedNonce,
            parsedDeadline,
            parsedPermitV,
            permitR,
            permitS,
            signature
        );

        console.log(`[Success] Transaction sent: ${tx.hash}. Waiting for confirmation...`);
        const receipt = await tx.wait();
        console.log(`[Confirmed] Block: ${receipt.blockNumber}, Hash: ${receipt.hash}`);

        return res.json({
            success: true,
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString()
        });

    } catch (error) {
        console.error("Execution error in /api/transfer:", error);
        return res.status(500).json({
            error: "Failed to execute transfer transaction",
            message: error.message || error.toString()
        });
    }
});

/**
 * POST /api/bridge
 * Receives the parameters to execute gaslessBridge on the contract
 */
app.post('/api/bridge', async (req, res) => {
    const {
        token,
        owner,
        recipient,
        amount,
        fee,
        destinationChainId,
        gasLimit,
        nonce,
        deadline,
        permitV,
        permitR,
        permitS,
        signature // bridge signature
    } = req.body;

    // 1. Basic validation of inputs
    if (!token || !owner || !recipient || !signature) {
        return res.status(400).json({ error: "Missing required string/address/signature parameters." });
    }

    if (!ethers.isAddress(token) || !ethers.isAddress(owner) || !ethers.isAddress(recipient)) {
        return res.status(400).json({ error: "Token, owner and recipient must be valid Ethereum addresses." });
    }

    if (!signature.startsWith('0x') || signature.length < 130) {
        return res.status(400).json({ error: "Signature must be a valid hex string." });
    }

    if (permitR === undefined || permitS === undefined || permitV === undefined) {
        return res.status(400).json({ error: "Missing standard ERC20 permit signature parameters (permitV, permitR, permitS)." });
    }

    let parsedAmount, parsedFee, parsedDestinationChainId, parsedGasLimit, parsedNonce, parsedDeadline, parsedPermitV;
    try {
        parsedAmount = safeBigInt(amount, 'amount');
        parsedFee = safeBigInt(fee, 'fee');
        parsedDestinationChainId = safeBigInt(destinationChainId, 'destinationChainId');
        parsedGasLimit = safeBigInt(gasLimit, 'gasLimit');
        parsedNonce = safeBigInt(nonce, 'nonce');
        parsedDeadline = safeBigInt(deadline, 'deadline');
        parsedPermitV = Number(permitV);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    // 2. Deadline check
    const currentTimestamp = BigInt(Math.floor(Date.now() / 1000));
    if (parsedDeadline < currentTimestamp) {
        return res.status(400).json({
            error: "Signature deadline has expired.",
            details: { deadline: parsedDeadline.toString(), currentTimestamp: currentTimestamp.toString() }
        });
    }

    try {
        // Fetch contract details dynamically for the target token
        const tokenContract = new ethers.Contract(token, ERC20_ABI, provider);
        const decimals = await tokenContract.decimals();
        const tokenPriceInWei = await contract.tokenPricesInWei(token);

        if (tokenPriceInWei === 0n) {
            return res.status(400).json({ error: `GaslessTransferBridge: token price in Wei for ${token} is not set on the contract` });
        }

        // 3. Backend fee sanity check based on current block baseFee (or gasPrice)
        const block = await provider.getBlock("latest");
        let baseFee = block ? block.baseFeePerGas : null;
        if (!baseFee || baseFee === 0n) {
            const feeData = await provider.getFeeData();
            baseFee = feeData.gasPrice || 0n;
        }

        const actualGasCostInWei = parsedGasLimit * baseFee;
        const minFeeRequired = (actualGasCostInWei * (10n ** BigInt(decimals))) / tokenPriceInWei;

        if (parsedFee < minFeeRequired) {
            console.log(`[Validation Failed] Fee too low. Provided: ${parsedFee}, Min required: ${minFeeRequired}`);
            return res.status(400).json({
                error: "Fee too low for gas compensation",
                details: {
                    providedFee: parsedFee.toString(),
                    minFeeRequired: minFeeRequired.toString(),
                    estimatedGasPrice: baseFee.toString(),
                    gasLimit: parsedGasLimit.toString()
                }
            });
        }

        // 4. Simulate the transaction using estimateGas (revert checks)
        console.log(`[Simulating] Simulating bridge of ${parsedAmount} ${token} from ${owner} to chain ${parsedDestinationChainId}...`);
        try {
            await contract.gaslessBridge.estimateGas(
                token,
                owner,
                recipient,
                parsedAmount,
                parsedFee,
                parsedDestinationChainId,
                parsedGasLimit,
                parsedNonce,
                parsedDeadline,
                parsedPermitV,
                permitR,
                permitS,
                signature
            );
        } catch (simError) {
            console.error(`[Simulation Failed] gaslessBridge simulation failed:`, simError.message);
            return res.status(400).json({
                error: "Transaction simulation failed. It will revert on-chain.",
                message: simError.message || simError.toString()
            });
        }

        // 5. Send transaction
        console.log(`[Executing] Sending gaslessBridge on-chain...`);
        const tx = await contract.gaslessBridge(
            token,
            owner,
            recipient,
            parsedAmount,
            parsedFee,
            parsedDestinationChainId,
            parsedGasLimit,
            parsedNonce,
            parsedDeadline,
            parsedPermitV,
            permitR,
            permitS,
            signature
        );

        console.log(`[Success] Transaction sent: ${tx.hash}. Waiting for confirmation...`);
        const receipt = await tx.wait();
        console.log(`[Confirmed] Block: ${receipt.blockNumber}, Hash: ${receipt.hash}`);

        return res.json({
            success: true,
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString()
        });

    } catch (error) {
        console.error("Execution error in /api/bridge:", error);
        return res.status(500).json({
            error: "Failed to execute bridge transaction",
            message: error.message || error.toString()
        });
    }
});

// Start Express Application
app.listen(PORT, () => {
    console.log(`\n\x1b[32m[Server Online] Gas Relayer Server listening on port ${PORT}\x1b[0m`);
    console.log(`[URL]           : http://localhost:${PORT}`);
});
