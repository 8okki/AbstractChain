import React, { useState, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import './App.css';

// Minimal ERC20 ABI for interacting with external ERC20 tokens
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function nonces(address owner) view returns (uint256)"
];

// ABI for interacting with GaslessTransferBridge.sol
const BRIDGE_ABI = [
  "function gaslessNonces(address owner) view returns (uint256)",
  "function tokenPricesInWei(address token) view returns (uint256)"
];

const PRESET_TOKENS = [
  { name: "Mock Gasless Token A", symbol: "GTBA", address: "0x5FbDB2315678afecb367f032d93F642f64180aa3" },
  { name: "Mock Gasless Token B", symbol: "GTBB", address: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" }
];

const PRESET_CHAINS = [
  { name: "Local Anvil (31337)", chainId: "31337" },
  { name: "Optimism (10)", chainId: "10" },
  { name: "Arbitrum One (42161)", chainId: "42161" },
  { name: "Base (8453)", chainId: "8453" },
  { name: "Polygon Mainnet (137)", chainId: "137" }
];

function App() {
  // Connection states
  const [account, setAccount] = useState('');
  const [chainId, setChainId] = useState(null);
  const [isConnected, setIsConnected] = useState(false);

  // Configuration states
  const [contractAddress, setContractAddress] = useState('0xCf7Ed3ACCA5a467e9e704C703E8D87F634fB0Fc9');
  const [relayerUrl, setRelayerUrl] = useState('http://localhost:5001/api');

  // Token Selection states
  const [selectedToken, setSelectedToken] = useState(PRESET_TOKENS[0].address);
  const [customTokenAddress, setCustomTokenAddress] = useState('');

  // Chain Selection states
  const [selectedChain, setSelectedChain] = useState(PRESET_CHAINS[0].chainId);
  const [customChainId, setCustomChainId] = useState('');

  // Dynamic Token metadata & balances
  const [tokenName, setTokenName] = useState('Mock Gasless Token A');
  const [tokenSymbol, setTokenSymbol] = useState('GTBA');
  const [tokenDecimals, setTokenDecimals] = useState(18);
  const [tokenBalance, setTokenBalance] = useState('0.0');
  const [tokenPermitNonce, setTokenPermitNonce] = useState('0');
  const [gaslessNonce, setGaslessNonce] = useState('0');
  const [tokenPrice, setTokenPrice] = useState('0');

  // Form states (Transfer Tab)
  const [transferRecipient, setTransferRecipient] = useState('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  const [transferAmount, setTransferAmount] = useState('100.0');
  const [transferFee, setTransferFee] = useState('5.0');
  const [transferGasLimit, setTransferGasLimit] = useState('200000');
  const [transferDeadline, setTransferDeadline] = useState('60'); // minutes

  // Form states (Bridge Tab)
  const [bridgeRecipient, setBridgeRecipient] = useState('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  const [bridgeAmount, setBridgeAmount] = useState('500.0');
  const [bridgeFee, setBridgeFee] = useState('10.0');
  const [bridgeGasLimit, setBridgeGasLimit] = useState('250000');
  const [bridgeDeadline, setBridgeDeadline] = useState('60'); // minutes

  // UI state
  const [activeTab, setActiveTab] = useState('transfer'); // 'transfer' | 'bridge'
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [signingStep, setSigningStep] = useState(null); // null | 'permit' | 'action' | 'submitting'
  const [previewType, setPreviewType] = useState('action'); // 'permit' | 'action'
  const [relayerReachable, setRelayerReachable] = useState(null); // null | true | false

  // Log terminal console state
  const [logs, setLogs] = useState([
    { time: new Date().toLocaleTimeString(), message: "Abstract Gasless Hub initialized.", type: 'info' }
  ]);
  
  const consoleEndRef = useRef(null);

  // Helper: Append log
  const addLog = (message, type = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, { time, message, type }]);
  };

  // Scroll to bottom of terminal when logs update
  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // Connect wallet
  const connectWallet = async () => {
    if (!window.ethereum) {
      addLog("MetaMask not detected! Please install browser extension.", "error");
      alert("MetaMask is required to sign typed data.");
      return;
    }

    try {
      addLog("Requesting account connection from MetaMask...", "interactive");
      const provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send("eth_requestAccounts", []);
      const network = await provider.getNetwork();
      
      setAccount(accounts[0]);
      setChainId(Number(network.chainId));
      setIsConnected(true);
      
      addLog(`Wallet connected: ${accounts[0]}`, "success");
      addLog(`Network Detected: Chain ID ${network.chainId}`, "info");

      checkRelayerHealth();
    } catch (error) {
      console.error(error);
      addLog(`Connection failed: ${error.message}`, "error");
    }
  };

  // Check Relayer Health
  const checkRelayerHealth = async () => {
    try {
      addLog(`Checking relayer status at: ${relayerUrl}...`, "info");
      const response = await fetch(relayerUrl.endsWith('/') ? relayerUrl : `${relayerUrl}/info/0x0000000000000000000000000000000000000000`);
      if (response.ok || response.status === 400 || response.status === 404) {
        setRelayerReachable(true);
        addLog("Relayer server is reachable and active.", "success");
      } else {
        setRelayerReachable(false);
        addLog(`Relayer returned status ${response.status}.`, "warning");
      }
    } catch (e) {
      setRelayerReachable(false);
      addLog(`Relayer connection failed: ${e.message}. Ensure relayer is running at ${relayerUrl}`, "warning");
    }
  };

  // Helper getters
  const getTokenAddress = () => {
    return selectedToken === 'custom' ? customTokenAddress : selectedToken;
  };

  const getTargetChainId = () => {
    return selectedChain === 'custom' ? customChainId : selectedChain;
  };

  // Fetch token and user data from contracts
  const fetchContractData = async () => {
    const tokenAddress = getTokenAddress();
    if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
      addLog("Invalid token address configured.", "warning");
      return;
    }
    if (!contractAddress || !ethers.isAddress(contractAddress)) {
      addLog("Invalid bridge contract address configured.", "warning");
      return;
    }

    try {
      addLog(`Fetching details for token: ${tokenAddress} and bridge: ${contractAddress}...`, "info");
      
      let provider;
      if (window.ethereum) {
        provider = new ethers.BrowserProvider(window.ethereum);
      } else {
        addLog("Wallet not connected. Connect wallet to read contract state.", "warning");
        return;
      }

      const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      const bridgeContract = new ethers.Contract(contractAddress, BRIDGE_ABI, provider);

      // Fetch metadata
      const [name, symbol, decimals, price] = await Promise.all([
        tokenContract.name().catch(() => "Unknown Token"),
        tokenContract.symbol().catch(() => "???"),
        tokenContract.decimals().catch(() => 18),
        bridgeContract.tokenPricesInWei(tokenAddress).catch(() => 0n)
      ]);

      setTokenName(name);
      setTokenSymbol(symbol);
      setTokenDecimals(Number(decimals));
      setTokenPrice(price.toString());

      addLog(`Token Loaded: ${name} (${symbol}), Decimals: ${decimals}`, "success");
      addLog(`Current base token price in Wei: ${price.toString()}`, "info");

      // Fetch user specific data
      if (account) {
        const balance = await tokenContract.balanceOf(account).catch(() => 0n);
        const tNonce = await tokenContract.nonces(account).catch(() => 0n);
        const bNonce = await bridgeContract.gaslessNonces(account).catch(() => 0n);
        
        const formattedBalance = ethers.formatUnits(balance, Number(decimals));
        setTokenBalance(formattedBalance);
        setTokenPermitNonce(tNonce.toString());
        setGaslessNonce(bNonce.toString());
        
        addLog(`User balance: ${formattedBalance} ${symbol}`, "info");
        addLog(`User ERC20 permit nonce: ${tNonce.toString()}`, "info");
        addLog(`User gasless bridge nonce: ${bNonce.toString()}`, "info");
      }
    } catch (error) {
      console.error(error);
      addLog(`Failed to query contracts: ${error.message}`, "error");
    }
  };

  // Trigger fetch contract data on changes
  useEffect(() => {
    if (isConnected && account) {
      fetchContractData();
    }
  }, [isConnected, account, contractAddress, selectedToken, customTokenAddress]);

  // Listen to MetaMask changes
  useEffect(() => {
    if (window.ethereum) {
      const handleAccounts = (accounts) => {
        if (accounts.length > 0) {
          setAccount(accounts[0]);
          addLog(`MetaMask account switched to: ${accounts[0]}`, "interactive");
        } else {
          setAccount('');
          setIsConnected(false);
          addLog("Wallet disconnected from MetaMask.", "warning");
        }
      };

      const handleChain = (hexChainId) => {
        const id = Number(hexChainId);
        setChainId(id);
        addLog(`MetaMask chain changed to ID: ${id}`, "interactive");
      };

      window.ethereum.on('accountsChanged', handleAccounts);
      window.ethereum.on('chainChanged', handleChain);

      return () => {
        window.ethereum.removeListener('accountsChanged', handleAccounts);
        window.ethereum.removeListener('chainChanged', handleChain);
      };
    }
  }, []);

  // Compute Permit domain and message
  const getPermitDomainAndMessage = () => {
    const tokenAddress = getTokenAddress();
    const domain = {
      name: tokenName,
      version: "1",
      chainId: chainId || 31337,
      verifyingContract: tokenAddress
    };

    const parsedAmount = ethers.parseUnits((activeTab === 'transfer' ? transferAmount : bridgeAmount) || '0', tokenDecimals);
    const parsedFee = ethers.parseUnits((activeTab === 'transfer' ? transferFee : bridgeFee) || '0', tokenDecimals);
    const totalValue = parsedAmount + parsedFee;
    const minutes = activeTab === 'transfer' ? transferDeadline : bridgeDeadline;
    const deadlineTimestamp = Math.floor(Date.now() / 1000) + (Number(minutes) * 60);

    const message = {
      owner: account || ethers.ZeroAddress,
      spender: contractAddress,
      value: totalValue.toString(),
      nonce: tokenPermitNonce,
      deadline: deadlineTimestamp.toString()
    };

    return {
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' }
        ]
      },
      domain,
      message
    };
  };

  // Compute Bridge / Transfer domain and message
  const getActionDomainAndMessage = () => {
    const domain = {
      name: "GaslessTransferBridge",
      version: "1",
      chainId: chainId || 31337,
      verifyingContract: contractAddress
    };

    const tokenAddress = getTokenAddress();
    if (activeTab === 'transfer') {
      const parsedAmount = ethers.parseUnits(transferAmount || '0', tokenDecimals);
      const parsedFee = ethers.parseUnits(transferFee || '0', tokenDecimals);
      const deadlineTimestamp = Math.floor(Date.now() / 1000) + (Number(transferDeadline) * 60);

      const message = {
        token: tokenAddress,
        owner: account || ethers.ZeroAddress,
        recipient: transferRecipient || ethers.ZeroAddress,
        amount: parsedAmount.toString(),
        fee: parsedFee.toString(),
        gasLimit: transferGasLimit || '200000',
        nonce: gaslessNonce,
        deadline: deadlineTimestamp.toString()
      };

      return {
        types: {
          GaslessTransfer: [
            { name: 'token', type: 'address' },
            { name: 'owner', type: 'address' },
            { name: 'recipient', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'fee', type: 'uint256' },
            { name: 'gasLimit', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' }
          ]
        },
        domain,
        message
      };
    } else {
      const parsedAmount = ethers.parseUnits(bridgeAmount || '0', tokenDecimals);
      const parsedFee = ethers.parseUnits(bridgeFee || '0', tokenDecimals);
      const deadlineTimestamp = Math.floor(Date.now() / 1000) + (Number(bridgeDeadline) * 60);

      const message = {
        token: tokenAddress,
        owner: account || ethers.ZeroAddress,
        recipient: bridgeRecipient || ethers.ZeroAddress,
        amount: parsedAmount.toString(),
        fee: parsedFee.toString(),
        destinationChainId: getTargetChainId() || '31337',
        gasLimit: bridgeGasLimit || '250000',
        nonce: gaslessNonce,
        deadline: deadlineTimestamp.toString()
      };

      return {
        types: {
          GaslessBridge: [
            { name: 'token', type: 'address' },
            { name: 'owner', type: 'address' },
            { name: 'recipient', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'fee', type: 'uint256' },
            { name: 'destinationChainId', type: 'uint256' },
            { name: 'gasLimit', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' }
          ]
        },
        domain,
        message
      };
    }
  };

  const getLivePreviewJSON = () => {
    return previewType === 'permit' ? getPermitDomainAndMessage() : getActionDomainAndMessage();
  };

  // Form submit handler: Sequential 2-step signature EIP-712 & Relayer post
  const handleSignAndSubmit = async (e) => {
    e.preventDefault();
    if (!isConnected || !account) {
      addLog("Cannot sign. Wallet not connected.", "error");
      alert("Please connect MetaMask first.");
      return;
    }

    const tokenAddress = getTokenAddress();
    if (!ethers.isAddress(tokenAddress)) {
      addLog("Invalid token address.", "error");
      alert("Please enter a valid token address.");
      return;
    }

    setIsSubmitting(true);
    
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      // ==========================================
      // STEP 1: Sign Token Permit
      // ==========================================
      setSigningStep('permit');
      addLog("[STEP 1/2] Initiating ERC20 Permit (EIP-2612) signature request in MetaMask...", "interactive");
      
      const permitData = getPermitDomainAndMessage();
      const permitValueBigInt = { ...permitData.message };
      permitValueBigInt.value = BigInt(permitValueBigInt.value);
      permitValueBigInt.nonce = BigInt(permitValueBigInt.nonce);
      permitValueBigInt.deadline = BigInt(permitValueBigInt.deadline);

      const permitSignature = await signer.signTypedData(
        permitData.domain,
        permitData.types,
        permitValueBigInt
      );

      const parsedPermitSig = ethers.Signature.from(permitSignature);
      addLog(`[STEP 1/2 COMPLETE] Token Permit signed successfully!`, "success");
      addLog(`Permit signature v: ${parsedPermitSig.v}, r: ${parsedPermitSig.r.slice(0, 10)}..., s: ${parsedPermitSig.s.slice(0, 10)}...`, "info");

      // ==========================================
      // STEP 2: Sign Custom Gasless Action
      // ==========================================
      setSigningStep('action');
      addLog(`[STEP 2/2] Initiating custom ${activeTab === 'transfer' ? 'Transfer' : 'Bridge'} action signature request in MetaMask...`, "interactive");

      const actionData = getActionDomainAndMessage();
      const actionValueBigInt = { ...actionData.message };
      actionValueBigInt.amount = BigInt(actionValueBigInt.amount);
      actionValueBigInt.fee = BigInt(actionValueBigInt.fee);
      actionValueBigInt.gasLimit = BigInt(actionValueBigInt.gasLimit);
      actionValueBigInt.nonce = BigInt(actionValueBigInt.nonce);
      actionValueBigInt.deadline = BigInt(actionValueBigInt.deadline);
      if (activeTab === 'bridge') {
        actionValueBigInt.destinationChainId = BigInt(actionValueBigInt.destinationChainId);
      }

      const actionSignature = await signer.signTypedData(
        actionData.domain,
        actionData.types,
        actionValueBigInt
      );

      addLog(`[STEP 2/2 COMPLETE] Action signed successfully!`, "success");
      addLog(`Action Signature Hash: ${actionSignature}`, "info");

      // ==========================================
      // STEP 3: Dispatch Payload to Relayer
      // ==========================================
      setSigningStep('submitting');
      const endpoint = `${relayerUrl}/${activeTab}`;
      const payload = {
        ...actionData.message,
        permitV: parsedPermitSig.v,
        permitR: parsedPermitSig.r,
        permitS: parsedPermitSig.s,
        signature: actionSignature
      };

      addLog(`Submitting payload to Relayer API at: ${endpoint}...`, "interactive");
      
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const responseJson = await response.json();

      if (response.ok) {
        addLog(`Relayer successfully forwarded and executed transaction!`, "success");
        if (responseJson.txHash) {
          addLog(`Tx Hash: ${responseJson.txHash}`, "success");
        } else {
          addLog(`Relayer response: ${JSON.stringify(responseJson)}`, "info");
        }
        setTimeout(fetchContractData, 3000);
      } else {
        addLog(`Relayer execution failed: ${responseJson.error || responseJson.message || 'Unknown error'}`, "error");
        if (responseJson.details) {
          addLog(`Details: ${JSON.stringify(responseJson.details)}`, "error");
        }
      }

    } catch (err) {
      console.error(err);
      if (err.code === 4001) {
        addLog("Signature request rejected by user in MetaMask.", "warning");
      } else {
        addLog(`Error executing action: ${err.message}`, "error");
      }
    } finally {
      setIsSubmitting(false);
      setSigningStep(null);
    }
  };

  const previewData = getLivePreviewJSON();
  const currentPreviewKey = previewType === 'permit' ? 'Permit' : (activeTab === 'transfer' ? 'GaslessTransfer' : 'GaslessBridge');

  return (
    <div className="app-container animate-slide-up">
      {/* Header */}
      <header className="app-header">
        <div className="brand">
          <svg className="brand-logo" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="50" cy="50" r="45" stroke="url(#logoGrad)" strokeWidth="6" />
            <path d="M30 50L45 65L70 35" stroke="url(#logoGrad)" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
            <defs>
              <linearGradient id="logoGrad" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
                <stop stopColor="#a855f7" />
                <stop offset="1" stopColor="#3b82f6" />
              </linearGradient>
            </defs>
          </svg>
          <h1>ABSTRACT GASLESS HUB</h1>
        </div>

        <div className="wallet-widget">
          {isConnected && chainId && (
            <span className="chain-badge">
              <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#60a5fa' }} />
              Chain ID: {chainId}
            </span>
          )}
          
          {isConnected ? (
            <div className="wallet-badge">
              <span className="wallet-indicator" />
              <span>{account.slice(0, 6)}...{account.slice(-4)}</span>
            </div>
          ) : (
            <button className="connect-btn" onClick={connectWallet}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M16 12h4" />
                <path d="M12 12h.01" />
                <path d="M12 4v4" />
              </svg>
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      {/* Config setup panel */}
      <section className="setup-panel">
        <div className="setup-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          System Configuration
        </div>
        <div className="setup-grid">
          <div className="input-container">
            <label>Bridge Gateway Contract Address</label>
            <input 
              type="text" 
              className="input-field" 
              value={contractAddress} 
              onChange={(e) => setContractAddress(e.target.value)} 
              placeholder="0x..."
            />
          </div>
          <div className="input-container">
            <label>Relayer Server Base API</label>
            <input 
              type="text" 
              className="input-field" 
              value={relayerUrl} 
              onChange={(e) => setRelayerUrl(e.target.value)} 
              placeholder="http://localhost:5001/api"
            />
          </div>
          <button className="action-btn" onClick={() => { fetchContractData(); checkRelayerHealth(); }}>
            Load Config
          </button>
        </div>
      </section>

      {/* Dashboard state Grid */}
      <section className="dashboard-grid">
        <div className="dash-card">
          <span className="card-label">Active Token</span>
          <span className="card-value">{tokenSymbol}</span>
          <span className="card-subtext">{tokenName.slice(0, 24)}{tokenName.length > 24 ? '...' : ''}</span>
        </div>
        <div className="dash-card">
          <span className="card-label">Token Decimals</span>
          <span className="card-value">{tokenDecimals}</span>
          <span className="card-subtext">Scale: 10^{tokenDecimals}</span>
        </div>
        <div className="dash-card">
          <span className="card-label">Your Balance</span>
          <span className="card-value">{Number(tokenBalance).toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
          <span className="card-subtext">{tokenSymbol} Balance</span>
        </div>
        <div className="dash-card">
          <span className="card-label">Bridge / Permit Nonce</span>
          <span className="card-value">{gaslessNonce} / {tokenPermitNonce}</span>
          <span className="card-subtext">Custom / EIP-2612 Nonce</span>
        </div>
      </section>

      {/* Tab Selectors */}
      <div className="tabs-container">
        <button 
          className={`tab-btn ${activeTab === 'transfer' ? 'active' : ''}`}
          onClick={() => { setActiveTab('transfer'); setPreviewType('action'); }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M17 3L21 7L17 11" />
            <path d="M3 17L7 21L3 17Z" />
            <path d="M21 7H9" />
            <path d="M3 17H15" />
            <path d="M17 13L21 17L17 21" strokeLinecap="round" />
            <path d="M3 7L7 3L3 7Z" />
            <path d="M21 17H9" />
            <path d="M3 7H15" />
          </svg>
          Gasless Transfer
        </button>
        <button 
          className={`tab-btn ${activeTab === 'bridge' ? 'active' : ''}`}
          onClick={() => { setActiveTab('bridge'); setPreviewType('action'); }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" />
            <path d="M8 12H16" />
            <path d="M12 8V16" />
          </svg>
          Gasless Bridge
        </button>
      </div>

      {/* Workspace Area */}
      <main className="main-workspace">
        
        {/* Left side: Interactive Forms */}
        <div className="workspace-left">
          
          {/* Universal Token Selector Panel */}
          <div className="form-panel" style={{ marginBottom: '1.5rem', paddingBottom: '1.5rem' }}>
            <div className="panel-header">
              <h2>Select Token to Use</h2>
              <p>Configure which ERC20 Permit token you wish to use for the gasless transaction.</p>
            </div>
            <div className="form-grid">
              <div className="input-container full-width">
                <label>Token Select</label>
                <select 
                  className="input-field" 
                  style={{ background: 'var(--bg-card)', color: 'var(--text-main)', border: '1px solid var(--border-color)', cursor: 'pointer' }}
                  value={selectedToken}
                  onChange={(e) => setSelectedToken(e.target.value)}
                >
                  {PRESET_TOKENS.map((t, idx) => (
                    <option key={idx} value={t.address}>{t.name} ({t.symbol})</option>
                  ))}
                  <option value="custom">Custom Token Contract Address...</option>
                </select>
              </div>

              {selectedToken === 'custom' && (
                <div className="input-container full-width">
                  <label>Custom ERC20 Permit Address</label>
                  <input 
                    type="text"
                    className="input-field"
                    value={customTokenAddress}
                    onChange={(e) => setCustomTokenAddress(e.target.value)}
                    placeholder="0x..."
                  />
                </div>
              )}
            </div>
          </div>

          {activeTab === 'transfer' ? (
            <form className="form-panel" onSubmit={handleSignAndSubmit}>
              <div className="panel-header">
                <h2>Transfer Tokens Gaslessly</h2>
                <p>Submit standard ERC20 Permit and custom GaslessTransfer signatures sequentially. Relayer pays the gas; you pay the fee in tokens.</p>
              </div>

              <div className="form-grid">
                <div className="input-container full-width">
                  <label>Recipient Address</label>
                  <input 
                    type="text" 
                    className="input-field"
                    value={transferRecipient}
                    onChange={(e) => setTransferRecipient(e.target.value)}
                    placeholder="0x..."
                    required
                  />
                </div>

                <div className="input-container">
                  <label>Transfer Amount ({tokenSymbol})</label>
                  <input 
                    type="number" 
                    step="any"
                    className="input-field"
                    value={transferAmount}
                    onChange={(e) => setTransferAmount(e.target.value)}
                    placeholder="0.0"
                    required
                  />
                </div>

                <div className="input-container">
                  <label>Relayer Fee ({tokenSymbol})</label>
                  <input 
                    type="number" 
                    step="any"
                    className="input-field"
                    value={transferFee}
                    onChange={(e) => setTransferFee(e.target.value)}
                    placeholder="0.0"
                    required
                  />
                </div>

                <div className="input-container">
                  <label>Gas Limit Parameter</label>
                  <input 
                    type="number" 
                    className="input-field"
                    value={transferGasLimit}
                    onChange={(e) => setTransferGasLimit(e.target.value)}
                    placeholder="200000"
                    required
                  />
                </div>

                <div className="input-container">
                  <label>Signature Expiration (Minutes)</label>
                  <input 
                    type="number" 
                    className="input-field"
                    value={transferDeadline}
                    onChange={(e) => setTransferDeadline(e.target.value)}
                    placeholder="60"
                    required
                  />
                </div>
              </div>

              <button type="submit" className="submit-btn" disabled={isSubmitting || !isConnected}>
                {isSubmitting ? (
                  <>
                    <span className="spinner" />
                    <span>
                      {signingStep === 'permit' && "1/3: Signing Token Permit..."}
                      {signingStep === 'action' && "2/3: Signing Transfer Action..."}
                      {signingStep === 'submitting' && "3/3: Dispatched to Relayer..."}
                    </span>
                  </>
                ) : (
                  <>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M12 20h9M3 20v-8c0-2.2 1.8-4 4-4h10c2.2 0 4 1.8 4 4v8M3 12h18" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    <span>Sign & Submit Transfer (2-Steps)</span>
                  </>
                )}
              </button>
            </form>
          ) : (
            <form className="form-panel" onSubmit={handleSignAndSubmit}>
              <div className="panel-header">
                <h2>Bridge Tokens Gaslessly</h2>
                <p>Bridge tokens to another chain. Tokens are locked in the gateway, and a fee is paid to the relayer in tokens.</p>
              </div>

              <div className="form-grid">
                <div className="input-container full-width">
                  <label>Destination Chain Selector</label>
                  <select 
                    className="input-field"
                    style={{ background: 'var(--bg-card)', color: 'var(--text-main)', border: '1px solid var(--border-color)', cursor: 'pointer' }}
                    value={selectedChain}
                    onChange={(e) => setSelectedChain(e.target.value)}
                  >
                    {PRESET_CHAINS.map((c, idx) => (
                      <option key={idx} value={c.chainId}>{c.name}</option>
                    ))}
                    <option value="custom">Custom Chain ID...</option>
                  </select>
                </div>

                {selectedChain === 'custom' && (
                  <div className="input-container full-width">
                    <label>Custom Destination Chain ID</label>
                    <input 
                      type="number"
                      className="input-field"
                      value={customChainId}
                      onChange={(e) => setCustomChainId(e.target.value)}
                      placeholder="10"
                      required
                    />
                  </div>
                )}

                <div className="input-container full-width">
                  <label>Recipient Address (Destination Chain)</label>
                  <input 
                    type="text" 
                    className="input-field"
                    value={bridgeRecipient}
                    onChange={(e) => setBridgeRecipient(e.target.value)}
                    placeholder="0x..."
                    required
                  />
                </div>

                <div className="input-container">
                  <label>Bridge Amount ({tokenSymbol})</label>
                  <input 
                    type="number" 
                    step="any"
                    className="input-field"
                    value={bridgeAmount}
                    onChange={(e) => setBridgeAmount(e.target.value)}
                    placeholder="0.0"
                    required
                  />
                </div>

                <div className="input-container">
                  <label>Relayer Fee ({tokenSymbol})</label>
                  <input 
                    type="number" 
                    step="any"
                    className="input-field"
                    value={bridgeFee}
                    onChange={(e) => setBridgeFee(e.target.value)}
                    placeholder="0.0"
                    required
                  />
                </div>

                <div className="input-container">
                  <label>Gas Limit Parameter</label>
                  <input 
                    type="number" 
                    className="input-field"
                    value={bridgeGasLimit}
                    onChange={(e) => setBridgeGasLimit(e.target.value)}
                    placeholder="250000"
                    required
                  />
                </div>

                <div className="input-container">
                  <label>Signature Expiration (Minutes)</label>
                  <input 
                    type="number" 
                    className="input-field"
                    value={bridgeDeadline}
                    onChange={(e) => setBridgeDeadline(e.target.value)}
                    placeholder="60"
                    required
                  />
                </div>
              </div>

              <button type="submit" className="submit-btn" disabled={isSubmitting || !isConnected}>
                {isSubmitting ? (
                  <>
                    <span className="spinner" />
                    <span>
                      {signingStep === 'permit' && "1/3: Signing Token Permit..."}
                      {signingStep === 'action' && "2/3: Signing Bridge Action..."}
                      {signingStep === 'submitting' && "3/3: Dispatched to Relayer..."}
                    </span>
                  </>
                ) : (
                  <>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                    </svg>
                    <span>Sign & Submit Bridge (2-Steps)</span>
                  </>
                )}
              </button>
            </form>
          )}
        </div>

        {/* Right side: Live EIP-712 Typed Data Preview */}
        <div className="workspace-right">
          <section className="preview-panel">
            <div className="preview-header-switch" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
              <div className="preview-title" style={{ margin: 0 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
                EIP-712 Structural Preview
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button 
                  type="button"
                  className={`tab-btn`} 
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', background: previewType === 'permit' ? 'var(--accent-purple)' : 'transparent' }}
                  onClick={() => setPreviewType('permit')}
                >
                  Permit Struct
                </button>
                <button 
                  type="button"
                  className={`tab-btn`} 
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', background: previewType === 'action' ? 'var(--accent-blue)' : 'transparent' }}
                  onClick={() => setPreviewType('action')}
                >
                  Action Struct
                </button>
              </div>
            </div>

            <div className="preview-content">
              <div>
                <span className="json-key">"types"</span>: &#123;
                <div style={{ paddingLeft: '1rem' }}>
                  <span className="json-key">"{currentPreviewKey}"</span>: [
                  {previewData.types[currentPreviewKey].map((t, idx) => (
                    <div key={idx} style={{ paddingLeft: '1rem' }}>
                      &#123; <span className="json-key">"name"</span>: <span className="json-val-str">"{t.name}"</span>, <span className="json-key">"type"</span>: <span className="json-val-str">"{t.type}"</span> &#125;
                      {idx < previewData.types[currentPreviewKey].length - 1 ? ',' : ''}
                    </div>
                  ))}
                  ]
                </div>
                &#125;,
              </div>

              <div style={{ marginTop: '0.75rem' }}>
                <span className="json-key">"domain"</span>: &#123;
                <div style={{ paddingLeft: '1rem' }}>
                  <span className="json-key">"name"</span>: <span className="json-val-str">"{previewData.domain.name}"</span>,<br />
                  <span className="json-key">"version"</span>: <span className="json-val-str">"{previewData.domain.version}"</span>,<br />
                  <span className="json-key">"chainId"</span>: <span className="json-val-num">{previewData.domain.chainId}</span>,<br />
                  <span className="json-key">"verifyingContract"</span>: <span className="json-val-str">"{previewData.domain.verifyingContract}"</span>
                </div>
                &#125;,
              </div>

              <div style={{ marginTop: '0.75rem' }}>
                <span className="json-key">"message"</span>: &#123;
                <div style={{ paddingLeft: '1rem' }}>
                  {Object.entries(previewData.message).map(([k, v], idx, arr) => (
                    <div key={k}>
                      <span className="json-key">"{k}"</span>: {
                        typeof v === 'string' && v.startsWith('0x') 
                          ? <span className="json-val-str">"{v}"</span> 
                          : typeof v === 'string' 
                            ? <span className="json-val-num">{v}</span> 
                            : <span className="json-val-num">{String(v)}</span>
                      }
                      {idx < arr.length - 1 ? ',' : ''}
                    </div>
                  ))}
                </div>
                &#125;
              </div>
            </div>
          </section>
        </div>

      </main>

      {/* Terminal log panel */}
      <section className="terminal-panel">
        <div className="terminal-header">
          <div className="terminal-indicator-group">
            <span className="terminal-dot red" />
            <span className="terminal-dot yellow" />
            <span className="terminal-dot green" />
          </div>
          <span className="terminal-title">System Logs & Relayer Output Console</span>
          <button className="terminal-clear" onClick={() => setLogs([])}>Clear</button>
        </div>

        <div className="terminal-console">
          {logs.map((log, idx) => (
            <div key={idx} className={`terminal-line ${log.type}`}>
              <span style={{ color: 'var(--text-muted)', marginRight: '0.5rem' }}>[{log.time}]</span>
              {log.type === 'error' && <span style={{ color: '#f87171', marginRight: '0.25rem' }}>[ERROR]</span>}
              {log.type === 'warning' && <span style={{ color: '#fbbf24', marginRight: '0.25rem' }}>[WARN]</span>}
              {log.type === 'success' && <span style={{ color: '#34d399', marginRight: '0.25rem' }}>[OK]</span>}
              {log.type === 'interactive' && <span style={{ color: '#c084fc', marginRight: '0.25rem' }}>[PENDING]</span>}
              <span>{log.message}</span>
            </div>
          ))}
          <div ref={consoleEndRef} />
        </div>
      </section>
    </div>
  );
}

export default App;
