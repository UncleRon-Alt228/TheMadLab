let poolPrice = 0;
let userBalance1 = 0;
let userBalance2 = 0;
let userLPBalance = 0;
let poolReserve1 = 0;
let poolReserve2 = 0;
let totalLPTokens = 0;
let isPoolDataLoaded = false;
let lpTokenCurrency = "";
let lpTokenIssuer = "";
let cachedAccountLines = null;
let lastAccountLinesFetch = 0;

const requestQueue = [];
let isProcessingRequests = false;

async function throttleRequest(requestFn) {
    return new Promise((resolve, reject) => {
        requestQueue.push({ fn: requestFn, resolve, reject });
        processRequestQueue();
    });
}

async function processRequestQueue() {
    if (isProcessingRequests || requestQueue.length === 0) return;
    isProcessingRequests = true;

    while (requestQueue.length > 0) {
        const { fn, resolve, reject } = requestQueue.shift();
        try {
            const result = await fn();
            resolve(result);
            await new Promise(resolve => setTimeout(resolve, 1000)); // 1000ms delay (1 request/second)
        } catch (error) {
            reject(error);
        }
    }

    isProcessingRequests = false;
}

function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

async function checkLPPool() {
    log('checkLPPool() triggered');
    const lpInfo = document.getElementById('lp-info');
    if (!lpInfo) {
        log('Error: #lp-info not found');
        return;
    }
    try {
        isPoolDataLoaded = false;
        userLPBalance = 0;
        lpTokenCurrency = "";
        lpTokenIssuer = "";

        const address = globalAddress;
        if (!contentCache || !displayTimer) {
            log('Error: No wallet loaded');
            lpInfo.innerHTML = '<p>Pool Status: No wallet loaded</p>';
            return;
        }
        if (!xrpl.isValidAddress(address)) {
            log('Error: Invalid address');
            lpInfo.innerHTML = '<p>Pool Status: Invalid address</p>';
            return;
        }

        await ensureConnected();
        const asset1 = document.getElementById('lp-asset1').value;
        const asset2 = document.getElementById('lp-asset2').value;
        if (!asset1 || !asset2) {
            log('Error: Asset dropdowns not populated');
            lpInfo.innerHTML = '<p>Pool Status: Asset selection missing</p>';
            return;
        }

        const asset1Data = asset1 === "XRP" ? { currency: "XRP" } : getAssetByName(asset1);
        const asset2Data = asset2 === "XRP" ? { currency: "XRP" } : getAssetByName(asset2);
        if (!asset1Data || !asset2Data) {
            log('Error: Invalid asset pair');
            lpInfo.innerHTML = '<p>Pool Status: Invalid asset pair</p>';
            return;
        }

        log(`Checking pool for ${asset1}/${asset2}`);
        const ammInfo = await throttleRequest(() => client.request({
            command: "amm_info",
            asset: asset1 === "XRP" ? { currency: "XRP" } : { currency: asset1Data.hex, issuer: asset1Data.issuer },
            asset2: asset2 === "XRP" ? { currency: "XRP" } : { currency: asset2Data.hex, issuer: asset2Data.issuer },
            ledger_index: "current"
        }));

        if (!ammInfo.result.amm) {
            log(`Error: AMM pool not found for ${asset1}/${asset2}`);
            lpInfo.innerHTML = '<p>Pool Status: Not Created</p>';
            isPoolDataLoaded = false;
            return;
        }

        const poolXrpDrops = parseFloat(ammInfo.result.amm.amount);
        poolReserve1 = asset1 === "XRP" ? parseFloat(xrpl.dropsToXrp(poolXrpDrops)) : parseFloat(ammInfo.result.amm.amount?.value || "0");
        poolReserve2 = asset2 === "XRP" ? parseFloat(xrpl.dropsToXrp(parseFloat(ammInfo.result.amm.amount2))) : parseFloat(ammInfo.result.amm.amount2?.value || "0");
        log(`Pool reserves calculated: poolReserve1=${poolReserve1} (${asset1}), poolReserve2=${poolReserve2} (${asset2})`);

        lpTokenIssuer = ammInfo.result.amm.account;
        lpTokenCurrency = ammInfo.result.amm.lptoken?.currency || "";
        const expectedLPName = `${asset1}/${asset2} LP`;
        let lpTokenData = globalLPTokens.find(token => token.lpName === expectedLPName && token.issuer === lpTokenIssuer);

        if (!lpTokenData) {
            log(`LP token not found in globalLPTokens for pair ${asset1}/${asset2} with issuer ${lpTokenIssuer} - assuming balance is 0`);
            userLPBalance = 0;
        } else {
            lpTokenCurrency = lpTokenData.currency;
            userLPBalance = lpTokenData.balance || 0;
            log(`Fetched LP balance from globalLPTokens: ${userLPBalance} for currency=${lpTokenCurrency}, issuer=${lpTokenIssuer}`);
        }

        const ammTrustlines = await throttleRequest(() => client.request({
            command: "account_lines",
            account: lpTokenIssuer,
            ledger_index: "current"
        }));
        const lpIssuerLine = ammTrustlines.result.lines.find(line => line.currency === lpTokenCurrency && line.account === lpTokenIssuer);
        totalLPTokens = lpIssuerLine ? Math.abs(parseFloat(lpIssuerLine.balance)) : userLPBalance * 10 || 1;

        const accountInfo = await throttleRequest(() => client.request({
            command: "account_info",
            account: address,
            ledger_index: "current"
        }));
        const xrpBalance = parseFloat(xrpl.dropsToXrp(accountInfo.result.account_data.Balance));
        const now = Date.now();
        if (!cachedAccountLines || (now - lastAccountLinesFetch) > 60000) {
            log('Fetching account_lines for user balances...');
            cachedAccountLines = await throttleRequest(() => client.request({
                command: "account_lines",
                account: address,
                ledger_index: "current"
            }));
            lastAccountLinesFetch = now;
        }
        userBalance1 = asset1 === "XRP" ? xrpBalance : (cachedAccountLines.result.lines.find(line => line.currency === asset1Data?.hex)?.balance || "0");
        userBalance2 = asset2 === "XRP" ? xrpBalance : (cachedAccountLines.result.lines.find(line => line.currency === asset2Data?.hex)?.balance || "0");
        poolPrice = poolReserve2 / poolReserve1 || 0;
        log(`User balances: userBalance1=${userBalance1} (${asset1}), userBalance2=${userBalance2} (${asset2}), poolPrice=${poolPrice}`);

        isPoolDataLoaded = true;

        const tradingFeeBasisPoints = ammInfo.result.amm.trading_fee || 0;
        const tradingFeePercent = (tradingFeeBasisPoints / 1000).toFixed(3);

        log('Setting lpInfo.innerHTML...');
        lpInfo.innerHTML = `
            <p>Pool Status: Active</p>
            <p>Your LP Tokens: ${formatBalance(userLPBalance)}</p>
            <p>Pool Reserves: ${formatBalance(poolReserve1)} ${asset1}, ${formatBalance(poolReserve2)} ${asset2}</p>
            <p>Pool Price: 1 ${asset1} = ${(poolPrice || 0).toFixed(6)} ${asset2}, 1 ${asset2} = ${(1 / poolPrice || 0).toFixed(6)} ${asset1}</p>
            <p>Pool Fee: ${tradingFeePercent}%</p>
        `;
        log('lpInfo.innerHTML set to:', lpInfo.innerHTML);

        log(`Pool checked successfully: ${asset1}/${asset2} - LP: ${userLPBalance}`);
        updateDepositSlider('asset1', 'deposit');
        updateWithdrawSlider();
        updateVoteFeeSlider();
    } catch (error) {
        log(`checkLPPool error: ${error.message}`);
        lpInfo.innerHTML = `<p>Pool Status: ${error.message.includes("ammNotFound") ? "Not Created" : "Error"}</p>`;
        isPoolDataLoaded = false;
    }
}

const debouncedCheckLPPool = debounce(checkLPPool, 2000);

document.addEventListener('DOMContentLoaded', function() {
    const lpSection = document.getElementById('amm-swap');
    let hasInitializedLP = false;

    const initLP = function() {
        if (!hasInitializedLP && !lpSection.classList.contains('minimized')) {
            
            populateAssetDropdowns();
            setupLPSliders();
            document.getElementById('lp-asset1').addEventListener('change', updateLPAssetPair);
            document.getElementById('lp-asset2').addEventListener('change', updateLPAssetPair);
            document.querySelector('.lp-asset-selection .red-black-btn').addEventListener('click', debouncedCheckLPPool);
            hasInitializedLP = true;
        }
    };

    lpSection.querySelector('.section-header').addEventListener('click', initLP);
    document.querySelector('a[href="#amm-swap"]').addEventListener('click', initLP);
});

document.addEventListener('DOMContentLoaded', function() {
    const lpSection = document.getElementById('amm-swap');
    let hasInitializedLP = false;

    const initLP = function() {
        if (!hasInitializedLP && !lpSection.classList.contains('minimized')) {
            
            populateAssetDropdowns();
            setupLPSliders();
            document.getElementById('lp-asset1').addEventListener('change', updateLPAssetPair);
            document.getElementById('lp-asset2').addEventListener('change', updateLPAssetPair);
            document.querySelector('.lp-asset-selection .red-black-btn').addEventListener('click', debouncedCheckLPPool);
            hasInitializedLP = true;
        }
    };

    lpSection.querySelector('.section-header').addEventListener('click', initLP);
    document.querySelector('a[href="#amm-swap"]').addEventListener('click', initLP);
});

document.addEventListener('DOMContentLoaded', function() {
    const lpSection = document.getElementById('amm-swap');
    let hasInitializedLP = false;

    const initLP = function() {
        if (!hasInitializedLP && !lpSection.classList.contains('minimized')) {
            
            populateAssetDropdowns();
            setupLPSliders();
            document.getElementById('lp-asset1').addEventListener('change', updateLPAssetPair);
            document.getElementById('lp-asset2').addEventListener('change', updateLPAssetPair);
            document.querySelector('.lp-asset-selection .red-black-btn').addEventListener('click', debouncedCheckLPPool);
            hasInitializedLP = true;
        }
    };

    lpSection.querySelector('.section-header').addEventListener('click', initLP);
    document.querySelector('a[href="#amm-swap"]').addEventListener('click', initLP);
});



function toggleLPSection(sectionId) {
    const section = document.getElementById(sectionId);
    section.classList.toggle("minimized");
    const toggleBtn = section.querySelector(".toggle-btn");
    toggleBtn.textContent = section.classList.contains("minimized") ? "▶" : "▼";
}

function updateLPAssetPair() {
    const asset1Select = document.getElementById('lp-asset1');
    const asset2Select = document.getElementById('lp-asset2');
    if (asset1Select.value === asset2Select.value) {
        const availableAssets = ['XRP', ...prefabAssets.map(a => a.name), ...dynamicAssets.map(a => a.name)];
        asset2Select.value = availableAssets.find(a => a !== asset1Select.value) || 'XRP';
    }
    checkLPPool();
}

function populateLPAssetDropdowns() {
    const asset1Select = document.getElementById('lp-asset1');
    const asset2Select = document.getElementById('lp-asset2');
    if (!asset1Select || !asset2Select) {
        log('Error: LP asset dropdowns not found in DOM.');
        return;
    }

    const currentAsset1 = asset1Select.value || "XRP";
    const currentAsset2 = asset2Select.value || (prefabAssets.length > 0 ? prefabAssets[0].name : "XRP");

    const combinedAssets = [...prefabAssets, ...dynamicAssets.filter(da => !prefabAssets.some(pa => pa.hex === da.hex))];
    combinedAssets.sort((a, b) => a.name.localeCompare(b.name));

    asset1Select.innerHTML = asset2Select.innerHTML = '';
    const xrpOption = document.createElement('option');
    xrpOption.value = "XRP";
    xrpOption.textContent = "XRP";
    asset1Select.appendChild(xrpOption.cloneNode(true));
    asset2Select.appendChild(xrpOption.cloneNode(true));

    combinedAssets.forEach(asset => {
        const option = document.createElement('option');
        option.value = asset.name;
        option.textContent = asset.name;
        asset1Select.appendChild(option.cloneNode(true));
        asset2Select.appendChild(option.cloneNode(true));
    });

    asset1Select.value = combinedAssets.some(a => a.name === currentAsset1) || currentAsset1 === "XRP" ? currentAsset1 : "XRP";
    asset2Select.value = combinedAssets.some(a => a.name === currentAsset2) || currentAsset2 === "XRP" ? currentAsset2 : (combinedAssets.length > 0 ? combinedAssets[0].name : "XRP");
}

function updateDepositSlider(asset, context) {
    const amount1Input = document.getElementById(`lp-amount1-${context}`);
    const amount2Input = document.getElementById(`lp-amount2-${context}`);
    const slider1 = document.getElementById(`lp-amount1-slider-${context}`);
    const slider2 = document.getElementById(`lp-amount2-slider-${context}`);
    const percentage1 = document.getElementById(`lp-amount1-percentage-${context}`);
    const percentage2 = document.getElementById(`lp-amount2-percentage-${context}`);

    if (!isPoolDataLoaded) {
        log('Error: Pool data not loaded. Please check pool first.');
        amount1Input.value = amount2Input.value = '';
        slider1.value = slider2.value = 0;
        percentage1.textContent = percentage2.textContent = '0%';
        return;
    }

    if (!userBalance1 || !userBalance2 || userBalance1 <= 0 || userBalance2 <= 0) {
        log('Error: Insufficient balance for deposit.');
        amount1Input.value = amount2Input.value = '';
        slider1.value = slider2.value = 0;
        percentage1.textContent = percentage2.textContent = '0%';
        return;
    }

    if (!poolPrice || poolPrice <= 0) {
        log('Error: Invalid pool price for deposit calculation.');
        amount1Input.value = amount2Input.value = '';
        slider1.value = slider2.value = 0;
        percentage1.textContent = percentage2.textContent = '0%';
        return;
    }

    const maxAsset1FromBalance1 = userBalance1;
    const maxAsset1FromBalance2 = userBalance2 / poolPrice;
    const limitingAsset1 = Math.min(maxAsset1FromBalance1, maxAsset1FromBalance2);
    const maxAsset2 = limitingAsset1 * poolPrice;

    if (asset === 'asset1') {
        const percentage = parseFloat(slider1.value);
        const amount1 = (percentage / 100) * limitingAsset1;
        const amount2 = amount1 * poolPrice;

        if (!isFinite(amount1) || !isFinite(amount2)) {
            log('Error: Calculated deposit amounts are invalid.');
            amount1Input.value = amount2Input.value = '';
            slider1.value = slider2.value = 0;
            percentage1.textContent = percentage2.textContent = '0%';
            return;
        }

        amount1Input.value = amount1.toFixed(6);
        amount2Input.value = amount2.toFixed(6);
        percentage1.textContent = `${percentage.toFixed(2)}%`;

        const asset2Percentage = (amount2 / userBalance2) * 100;
        slider2.value = Math.min(asset2Percentage, 100);
        percentage2.textContent = `${Math.min(asset2Percentage, 100).toFixed(2)}%`;
        log(`Deposit slider (asset1): amount1=${amount1}, amount2=${amount2}, percentage=${percentage}%`);
    } else {
        const percentage = parseFloat(slider2.value);
        const amount2 = (percentage / 100) * maxAsset2;
        const amount1 = amount2 / poolPrice;

        if (!isFinite(amount1) || !isFinite(amount2)) {
            log('Error: Calculated deposit amounts are invalid.');
            amount1Input.value = amount2Input.value = '';
            slider1.value = slider2.value = 0;
            percentage1.textContent = percentage2.textContent = '0%';
            return;
        }

        amount2Input.value = amount2.toFixed(6);
        amount1Input.value = amount1.toFixed(6);
        percentage2.textContent = `${percentage.toFixed(2)}%`;

        const asset1Percentage = (amount1 / userBalance1) * 100;
        slider1.value = Math.min(asset1Percentage, 100);
        percentage1.textContent = `${Math.min(asset1Percentage, 100).toFixed(2)}%`;
        log(`Deposit slider (asset2): amount1=${amount1}, amount2=${amount2}, percentage=${percentage}%`);
    }
}

function updateWithdrawSlider() {
    const lpAmountInput = document.getElementById('lp-amount-withdraw');
    const lpSlider = document.getElementById('lp-withdraw-slider');
    const lpPercentage = document.getElementById('lp-withdraw-percentage');

    let currentLPBalance = userLPBalance;
    if (!isPoolDataLoaded) {
        const asset1 = document.getElementById('lp-asset1').value;
        const asset2 = document.getElementById('lp-asset2').value;
        const expectedLPName = `${asset1}/${asset2} LP`;
        const lpTokenData = globalLPTokens.find(token => token.lpName === expectedLPName);
        currentLPBalance = lpTokenData ? lpTokenData.balance : 0;
        log(`Fetched LP balance from globalLPTokens for withdraw: ${currentLPBalance} for pair ${asset1}/${asset2}`);
    }

    if (!currentLPBalance || currentLPBalance <= 0) {
        log('Error: No LP tokens available to withdraw.');
        lpAmountInput.value = '';
        lpSlider.value = 0;
        lpPercentage.textContent = '0%';
        return;
    }

    const percentage = parseFloat(lpSlider.value);
    const lpAmount = (percentage / 100) * currentLPBalance;
    log(`LP Amount to withdraw: ${lpAmount}, userLPBalance: ${currentLPBalance}, percentage: ${percentage}%`);

    lpAmountInput.value = lpAmount.toFixed(6);
    lpPercentage.textContent = `${percentage.toFixed(2)}%`;
}
async function queueLPDeposit() {
    try {
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-lp');
        if (!contentCache || !displayTimer) {
            log('Error: No wallet loaded.');
            errorElement.textContent = 'No wallet loaded.';
            return;
        }

        const asset1 = document.getElementById('lp-asset1').value;
        const asset2 = document.getElementById('lp-asset2').value;
        const amount1 = document.getElementById('lp-amount1-deposit').value.trim();
        const amount2 = document.getElementById('lp-amount2-deposit').value.trim();

        if (!amount1 || isNaN(amount1) || parseFloat(amount1) <= 0) {
            log('Error: Invalid Amount 1.');
            errorElement.textContent = 'Invalid Amount 1.';
            return;
        }

        await ensureConnected();
        const seed = await fetchRenderContent();
        const wallet = xrpl.Wallet.fromSeed(seed);
        const asset1Data = asset1 === "XRP" ? { currency: "XRP" } : { currency: getAssetByName(asset1).hex, issuer: getAssetByName(asset1).issuer };
        const asset2Data = asset2 === "XRP" ? { currency: "XRP" } : { currency: getAssetByName(asset2).hex, issuer: getAssetByName(asset2).issuer };

        const tx = {
            TransactionType: "AMMDeposit",
            Account: address,
            Asset: asset1Data,
            Asset2: asset2Data,
            Amount: asset1 === "XRP" ? xrpl.xrpToDrops(amount1) : { currency: asset1Data.currency, issuer: asset1Data.issuer, value: amount1 },
            Fee: TRANSACTION_FEE_DROPS,
            Flags: amount2 ? 1048576 : 65536
        };

        if (amount2 && !isNaN(amount2) && parseFloat(amount2) > 0) {
            tx.Amount2 = asset2 === "XRP" ? xrpl.xrpToDrops(amount2) : { currency: asset2Data.currency, issuer: asset2Data.issuer, value: amount2 };
        }

        const txEntry = {
            tx: tx,
            wallet: wallet,
            description: `Deposit ${amount1} ${asset1}${amount2 ? ` and ${amount2} ${asset2}` : ''} to ${asset1}/${asset2} AMM`,
            delayMs: 0,
            type: "ammdeposit",
            queueElementId: "lp-queue"
        };

        transactionQueue.push(txEntry);
        log(`LP Deposit queued: ${txEntry.description}`);
        updateTransactionQueueDisplay();
        if (!isProcessingQueue) processLPTransactionQueue();
    } catch (error) {
        log(`LP Deposit error: ${error.message}`);
    }
}

async function queueLPWithdraw() {
    try {
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-lp');
        if (!contentCache || !displayTimer) {
            log('Error: No wallet loaded.');
            errorElement.textContent = 'No wallet loaded.';
            return;
        }

        const asset1 = document.getElementById('lp-asset1').value;
        const asset2 = document.getElementById('lp-asset2').value;
        const lpSlider = document.getElementById('lp-withdraw-slider');
        const percentage = parseFloat(lpSlider.value);

        if (!isPoolDataLoaded) {
            log('Error: Pool data not loaded. Please check pool first.');
            errorElement.textContent = 'Pool data not loaded.';
            return;
        }

        if (!userLPBalance || userLPBalance <= 0) {
            log('Error: No LP tokens available to withdraw.');
            errorElement.textContent = 'No LP tokens available.';
            return;
        }

        const lpAmount = (percentage / 100) * userLPBalance;
        if (!isFinite(lpAmount) || lpAmount <= 0) {
            log('Error: Invalid withdrawal amount. Please select a valid percentage.');
            errorElement.textContent = 'Invalid withdrawal amount.';
            return;
        }

        await ensureConnected();
        const seed = await fetchRenderContent();
        const wallet = xrpl.Wallet.fromSeed(seed);
        const asset1Data = asset1 === "XRP" ? { currency: "XRP" } : { currency: getAssetByName(asset1).hex, issuer: getAssetByName(asset1).issuer };
        const asset2Data = asset2 === "XRP" ? { currency: "XRP" } : { currency: getAssetByName(asset2).hex, issuer: getAssetByName(asset2).issuer };

        if (!lpTokenCurrency || !lpTokenIssuer) {
            log('Error: LP token details not available. Please check pool first.');
            errorElement.textContent = 'LP token details missing.';
            return;
        }

        const lpTokenIn = {
            currency: lpTokenCurrency,
            issuer: lpTokenIssuer,
            value: lpAmount.toFixed(6)
        };
        log(`Submitting withdrawal: ${lpAmount} LP tokens (${lpTokenCurrency})`);

        const tx = {
            TransactionType: "AMMWithdraw",
            Account: address,
            Asset: asset1Data,
            Asset2: asset2Data,
            LPTokenIn: lpTokenIn,
            Fee: TRANSACTION_FEE_DROPS,
            Flags: xrpl.AMMWithdrawFlags.tfLPToken
        };

        const txEntry = {
            tx: tx,
            wallet: wallet,
            description: `Withdraw ${lpAmount.toFixed(6)} LP tokens from ${asset1}/${asset2} AMM`,
            delayMs: 0,
            type: "ammwithdraw",
            queueElementId: "lp-queue",
            asset1: asset1,
            asset2: asset2
        };

        transactionQueue.push(txEntry);
        log(`LP Withdraw queued: ${txEntry.description}`);
        updateTransactionQueueDisplay();
        if (!isProcessingQueue) processLPTransactionQueue();
    } catch (error) {
        log(`LP Withdraw error: ${error.message}`);
        errorElement.textContent = `Error: ${error.message}`;
    }
}
async function queueLPVote() {
    try {
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-lp');
        if (!contentCache || !displayTimer) {
            log('Error: No wallet loaded.');
            errorElement.textContent = 'No wallet loaded.';
            return;
        }

        const asset1 = document.getElementById('lp-asset1').value;
        const asset2 = document.getElementById('lp-asset2').value;
        const feeInput = document.getElementById('lp-vote-fee').value.trim();
        const feePercent = parseFloat(feeInput);

        if (isNaN(feePercent) || feePercent < 0.01 || feePercent > 1) {
            log('Error: Fee must be between 0.01% and 1%.');
            errorElement.textContent = 'Fee must be between 0.01% and 1%.';
            return;
        }

        await ensureConnected();
        const seed = await fetchRenderContent();
        const wallet = xrpl.Wallet.fromSeed(seed);
        const asset1Data = asset1 === "XRP" ? { currency: "XRP" } : { currency: getAssetByName(asset1).hex, issuer: getAssetByName(asset1).issuer };
        const asset2Data = asset2 === "XRP" ? { currency: "XRP" } : { currency: getAssetByName(asset2).hex, issuer: getAssetByName(asset2).issuer };

        const tradingFee = Math.round(feePercent * 1000);
        log(`Calculated tradingFee: ${tradingFee}`);
        const tx = {
            TransactionType: "AMMVote",
            Account: address,
            Asset: asset1Data,
            Asset2: asset2Data,
            TradingFee: tradingFee,
            Fee: TRANSACTION_FEE_DROPS,
            Flags: 2147483648
        };

        const txEntry = {
            tx: tx,
            wallet: wallet,
            description: `Vote ${feePercent}% fee for ${asset1}/${asset2} AMM`,
            delayMs: 0,
            type: "ammvote",
            queueElementId: "lp-queue"
        };

        transactionQueue.push(txEntry);
        log(`LP Vote queued: ${txEntry.description}`);
        updateTransactionQueueDisplay();
        if (!isProcessingQueue) processLPTransactionQueue();
    } catch (error) {
        log(`LP Vote error: ${error.message}`);
    }
}

function updateVoteFeeSlider() {
    const slider = document.getElementById('lp-vote-fee-slider');
    const percentageDisplay = document.getElementById('lp-vote-fee-percentage');
    const feeInput = document.getElementById('lp-vote-fee');

    const sliderValue = parseFloat(slider.value);
    percentageDisplay.textContent = `${sliderValue.toFixed(2)}%`;

    const minFee = 10;
    const maxFee = 1000;
    const fee = minFee + (sliderValue / 100) * (maxFee - minFee);
    feeInput.value = (fee / 1000).toFixed(2);
}

async function processLPTransactionQueue() {
    if (transactionQueue.length === 0) {
        isProcessingQueue = false;
        log('LP Queue is empty. Processing stopped.');
        updateTransactionQueueDisplay();
        return;
    }

    isProcessingQueue = true;
    const txEntry = transactionQueue[0];
    const { description, delayMs, type } = txEntry;

    try {
        if (delayMs > 0) {
            log(`Waiting ${delayMs / 1000} seconds before sending: ${description}`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        await ensureConnected();

        if (type === "ammdeposit") {
            await processAMMDeposit(txEntry);
        } else if (type === "ammwithdraw") {
            log('Processing AMMWithdraw transaction...');
            await processAMMWithdraw(txEntry);
        } else if (type === "ammvote") {
            await processAMMVote(txEntry);
        } else {
            log(`Unknown LP transaction type: ${type}. Skipping.`);
            throw new Error(`Unsupported transaction type: ${type}`);
        }

        transactionQueue.shift();
        log(`Transaction removed from queue. Remaining: ${transactionQueue.length}`);
        updateTransactionQueueDisplay();

        if (transactionQueue.length > 0) {
            log('Waiting 15 seconds before next LP transaction...');
            await new Promise(resolve => setTimeout(resolve, 15000));
            await processLPTransactionQueue();
        } else {
            isProcessingQueue = false;
            log('LP Queue processing completed.');
        }
    } catch (error) {
        log(`LP Queue processing error: ${error.message}`);
        transactionQueue.shift();
        log(`Transaction failed and removed from queue. Remaining: ${transactionQueue.length}`);
        updateTransactionQueueDisplay();

        if (transactionQueue.length > 0) {
            log('Waiting 15 seconds before next LP transaction...');
            await new Promise(resolve => setTimeout(resolve, 15000));
            await processLPTransactionQueue();
        } else {
            isProcessingQueue = false;
            log('LP Queue processing completed with errors.');
        }
    }
}

async function processAMMDeposit(txEntry) {
    try {
        const { tx, wallet, description } = txEntry;
        const prepared = await client.autofill(tx);
        const ledgerInfo = await client.request({ command: "ledger_current" });
        prepared.LastLedgerSequence = ledgerInfo.result.ledger_current_index + 100;
        const signed = wallet.sign(prepared);

        log(`Submitting AMMDeposit: ${description}`);
        const result = await client.submitAndWait(signed.tx_blob);

        if (result.result.meta.TransactionResult === "tesSUCCESS") {
            log(`AMMDeposit succeeded: ${description}`);
            log(`Transaction Hash: ${result.result.hash}`);
            await checkBalance();
            await resecureCache();
            await checkLPPool();

            await new Promise(resolve => setTimeout(resolve, 1000));
            updateDepositSlider('asset1', 'deposit');
            updateWithdrawSlider();
            updateVoteFeeSlider();
        } else {
            log(`AMMDeposit failed: ${result.result.meta.TransactionResult}`);
            throw new Error(`AMMDeposit failed: ${result.result.meta.TransactionResult}`);
        }
    } catch (error) {
        log(`AMMDeposit error: ${error.message}`);
        throw error;
    }
}
async function processAMMWithdraw(txEntry) {
    try {
        const { tx, wallet, description, asset1, asset2 } = txEntry;
        const prepared = await client.autofill(tx);
        const ledgerInfo = await client.request({ command: "ledger_current" });
        prepared.LastLedgerSequence = ledgerInfo.result.ledger_current_index + 100;
        const signed = wallet.sign(prepared);

        log(`Submitting AMMWithdraw: ${description}`);
        const result = await client.submitAndWait(signed.tx_blob);

        if (result.result.meta.TransactionResult === "tesSUCCESS") {
            let withdrawnXrp = 0, withdrawnToken = 0;
            const asset1IsXRP = asset1 === "XRP";
            const asset2IsXRP = asset2 === "XRP";
            const tokenAsset = asset1IsXRP ? asset2 : asset1;
            const tokenData = getAssetByName(tokenAsset);

            if (result.result.meta.AffectedNodes) {
                for (const node of result.result.meta.AffectedNodes) {
                    if (node.ModifiedNode && node.ModifiedNode.LedgerEntryType === "AccountRoot" && node.ModifiedNode.FinalFields.Account === tx.Account) {
                        const previousBalance = parseFloat(node.ModifiedNode.PreviousFields.Balance || "0");
                        const finalBalance = parseFloat(node.ModifiedNode.FinalFields.Balance || "0");
                        const xrpChange = (finalBalance - previousBalance) / 1_000_000;
                        withdrawnXrp = xrpChange > 0 ? xrpChange : 0;
                    }
                    if (node.ModifiedNode && node.ModifiedNode.LedgerEntryType === "RippleState" && node.ModifiedNode.FinalFields.LowLimit.issuer === tx.Account) {
                        const previousBalance = parseFloat(node.ModifiedNode.PreviousFields.Balance || "0");
                        const finalBalance = parseFloat(node.ModifiedNode.FinalFields.Balance || "0");
                        withdrawnToken = (finalBalance - previousBalance) > 0 ? (finalBalance - previousBalance) : 0;
                    }
                }
            }

            log(`AMMWithdraw succeeded: ${description}`);
            log(`Transaction Hash: ${result.result.hash}`);
            log(`Withdrawn: ${formatBalance(withdrawnXrp)} XRP, ${formatBalance(withdrawnToken)} ${tokenAsset}`);

            const lpQueue = document.getElementById('lp-queue');
            if (lpQueue) {
                lpQueue.innerHTML = `
                    <p>Transaction Queue:</p>
                    <p>Withdrawal Result: Withdrew ${formatBalance(withdrawnXrp)} XRP and ${formatBalance(withdrawnToken)} ${tokenAsset}${withdrawnToken === 0 ? ' (Note: 0 token amount due to pool imbalance or rounding)' : ''}</p>
                `;
            }

            const lpSlider = document.getElementById('lp-withdraw-slider');
            const lpPercentage = document.getElementById('lp-withdraw-percentage');
            const lpAmountInput = document.getElementById('lp-amount-withdraw');
            if (lpSlider && lpPercentage && lpAmountInput) {
                lpSlider.value = 0;
                lpPercentage.textContent = '0%';
                lpAmountInput.value = '';
            }

            await checkBalance();
            await resecureCache();
            await checkLPPool();

            await new Promise(resolve => setTimeout(resolve, 1000));
            updateWithdrawSlider();
            updateDepositSlider('asset1', 'deposit');
            updateVoteFeeSlider();
        } else {
            log(`AMMWithdraw failed: ${result.result.meta.TransactionResult}`);
            throw new Error(`AMMWithdraw failed: ${result.result.meta.TransactionResult}`);
        }
    } catch (error) {
        log(`AMMWithdraw error: ${error.message}`);
        throw error;
    }
}
async function processAMMVote(txEntry) {
    try {
        const { tx, wallet, description } = txEntry;
        const prepared = await client.autofill(tx);
        const ledgerInfo = await client.request({ command: "ledger_current" });
        prepared.LastLedgerSequence = ledgerInfo.result.ledger_current_index + 100;
        const signed = wallet.sign(prepared);

        log(`Submitting AMMVote: ${description}`);
        const result = await client.submitAndWait(signed.tx_blob);

        if (result.result.meta.TransactionResult === "tesSUCCESS") {
            log(`AMMVote succeeded: ${description}`);
            log(`Transaction Hash: ${result.result.hash}`);
            await resecureCache();
        } else {
            log(`AMMVote failed: ${result.result.meta.TransactionResult}`);
            throw new Error(`AMMVote failed: ${result.result.meta.TransactionResult}`);
        }
    } catch (error) {
        log(`AMMVote error: ${error.message}`);
        throw error;
    }
}

function setupLPSliders() {
    const sliders = [
        { id: 'lp-amount1-slider-deposit', fn: () => updateDepositSlider('asset1', 'deposit') },
        { id: 'lp-amount2-slider-deposit', fn: () => updateDepositSlider('asset2', 'deposit') },
        { id: 'lp-withdraw-slider', fn: updateWithdrawSlider },
        { id: 'lp-vote-fee-slider', fn: updateVoteFeeSlider }
    ];

    sliders.forEach(({ id, fn }) => {
        const slider = document.getElementById(id);
        if (slider) {
            slider.removeAttribute('oninput');
            slider.addEventListener('input', debounce(fn, 100));
            
        } else {
            log(`Error: Slider ${id} missing`);
        }
    });
}
;
