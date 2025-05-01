let watchedAssets = [];
let isMonitoringPrices = false;
let guardianPoolState = {
    currentPrice: null,
    startingPrice: null,
    lastPriceCheckTimestamp: null,
    asset1: null,
    asset2: null,
    asset1Hex: null,
    asset2Hex: null,
    asset1Issuer: null,
    asset2Issuer: null
};

async function validateBalancesForTransaction(address, asset, amount, isToken, transactionCount = 1) {
    const { availableBalanceXrp } = await calculateAvailableBalance(address);
    const transactionFeeXrp = parseFloat(xrpl.dropsToXrp(TRANSACTION_FEE_DROPS));
    const totalFeeXrp = transactionFeeXrp * transactionCount;

    if (totalFeeXrp > availableBalanceXrp) {
        throw new Error(`Insufficient XRP for fees. Need ${formatBalance(totalFeeXrp)} XRP, have ${formatBalance(availableBalanceXrp)}.`);
    }

    if (isToken) {
        const accountLines = await client.request({
            command: "account_lines",
            account: address,
            ledger_index: "current"
        });
        const senderLine = accountLines.result.lines.find(line => line.currency === asset.hex && line.account === asset.issuer);
        if (!senderLine || parseFloat(senderLine.balance) < amount) {
            throw new Error(`Insufficient ${asset.name} balance. Available: ${senderLine ? senderLine.balance : 0}`);
        }
    } else {
        if (amount * transactionCount + totalFeeXrp > availableBalanceXrp) {
            throw new Error(`Insufficient XRP balance. Available: ${formatBalance(availableBalanceXrp)} XRP`);
        }
    }
}

function logGuardian(message) {
    log(`[Guardian] ${message}`);
}

function logGuardianOutput(message) {
    const output = document.getElementById('guardian-output');
    if (output) {
        const timestamp = new Date().toLocaleString();
        const logMessage = `[${timestamp}] ${message}`;
        const p = document.createElement('p');
        p.textContent = logMessage;
        output.appendChild(p);
        output.scrollTop = output.scrollHeight;
    }
}

function playGuardianSound(soundFileName) {
    try {
        let soundPath = `sounds/${soundFileName}`;
        soundPath = encodeURI(soundPath);
        const audio = new Audio(soundPath);
        audio.play().catch(error => {
            logGuardian(`Error with relative path for ${soundFileName}: ${error.message}`);
        
            const fallbackPath = encodeURI(`/sounds/${soundFileName}`);
            logGuardian(`Falling back to absolute path: ${fallbackPath}`);
            const fallbackAudio = new Audio(fallbackPath);
            fallbackAudio.play().catch(fallbackError => {
                logGuardian(`Error with fallback path for ${soundFileName}: ${fallbackError.message}`);
            });
        });
    } catch (error) {
        logGuardian(`Error initializing sound ${soundFileName}: ${error.message}`);
    }
}

async function guardianCheckPoolPrice() {
    const address = globalAddress;
    const errorElement = document.getElementById('guardian-error');
    const poolInfo = document.getElementById('guardian-pool-info');
    const asset1Display = document.getElementById('guardian-asset1-display');
    const asset2Display = document.getElementById('guardian-asset2-display');

    if (!asset1Display || !asset2Display || !poolInfo || !errorElement) {
        logGuardian('Error: Guardian elements not found in DOM.');
        errorElement.textContent = 'Guardian elements missing.';
        return;
    }

    const asset1 = asset1Display.getAttribute('data-value');
    const asset2 = asset2Display.getAttribute('data-value');
    const asset1Hex = asset1Display.getAttribute('data-hex');
    const asset2Hex = asset2Display.getAttribute('data-hex');
    const asset1Issuer = asset1Display.getAttribute('data-issuer');
    const asset2Issuer = asset2Display.getAttribute('data-issuer');

    if (!asset1 || !asset2 || !asset1Hex || !asset2Hex) {
        logGuardian('Error: Asset pair not selected.');
        errorElement.textContent = 'Select both assets.';
        return;
    }

    if (!contentCache || !displayTimer) {
        logGuardian('Error: No wallet loaded.');
        errorElement.textContent = 'No wallet loaded.';
        return;
    }

    if (!xrpl.isValidAddress(address)) {
        logGuardian('Error: Invalid address.');
        errorElement.textContent = 'Invalid address.';
        return;
    }

    try {
        await ensureConnected();
        const asset1Data = asset1 === "XRP" ? { currency: "XRP" } : { currency: asset1Hex, issuer: asset1Issuer };
        const asset2Data = asset2 === "XRP" ? { currency: "XRP" } : { currency: asset2Hex, issuer: asset2Issuer };

        logGuardian(`Checking pool price for ${asset1}/${asset2}`);
        const ammInfo = await throttleRequest(() =>
            client.request({
                command: "amm_info",
                asset: asset1Data,
                asset2: asset2Data,
                ledger_index: "current"
            })
        );

        if (!ammInfo.result.amm) {
            logGuardian(`No AMM pool found for ${asset1}/${asset2}.`);
            errorElement.textContent = 'No AMM pool found for this pair.';
            poolInfo.innerHTML = '<p>Current Price: -</p><p>Starting Price: -</p>';
            guardianPoolState = {
                currentPrice: null,
                startingPrice: null,
                lastPriceCheckTimestamp: null,
                asset1: null,
                asset2: null,
                asset1Hex: null,
                asset2Hex: null,
                asset1Issuer: null,
                asset2Issuer: null
            };
            return;
        }

        const amount1 = ammInfo.result.amm.amount;
        const amount2 = ammInfo.result.amm.amount2;
        let poolXrp, poolToken, direction;

        if (asset1 === "XRP") {
            poolXrp = parseFloat(xrpl.dropsToXrp(amount1));
            poolToken = parseFloat(amount2.value);
            direction = "XRP-to-Token";
        } else {
            poolXrp = parseFloat(xrpl.dropsToXrp(amount2));
            poolToken = parseFloat(amount1.value);
            direction = "Token-to-XRP";
        }

        
        let integerDigits = Math.floor(poolXrp).toString().replace(/^0+/, '') || '0';
        let maxDecimalPlaces = integerDigits.length >= 9 ? Math.max(0, 15 - integerDigits.length) : 6;
        poolXrp = Number(poolXrp.toFixed(maxDecimalPlaces));

        integerDigits = Math.floor(poolToken).toString().replace(/^0+/, '') || '0';
        maxDecimalPlaces = integerDigits.length >= 9 ? Math.max(0, 15 - integerDigits.length) : 6;
        poolToken = Number(poolToken.toFixed(maxDecimalPlaces));

        const currentPrice = direction === "XRP-to-Token" ? poolToken / poolXrp : poolXrp / poolToken;
        
        integerDigits = Math.floor(currentPrice).toString().replace(/^0+/, '') || '0';
        maxDecimalPlaces = integerDigits.length >= 9 ? Math.max(0, 15 - integerDigits.length) : 6;
        const truncatedCurrentPrice = Number(currentPrice.toFixed(maxDecimalPlaces));

        guardianPoolState = {
            currentPrice: truncatedCurrentPrice,
            startingPrice: guardianPoolState.startingPrice || null,
            lastPriceCheckTimestamp: Date.now(),
            asset1,
            asset2,
            asset1Hex,
            asset2Hex,
            asset1Issuer,
            asset2Issuer,
            direction
        };

        poolInfo.innerHTML = `
            <p>Current Price: 1 ${asset1} = ${truncatedCurrentPrice.toFixed(6)} ${asset2}</p>
            <p>Starting Price: ${guardianPoolState.startingPrice ? guardianPoolState.startingPrice.toFixed(6) : '-'}</p>
        `;
        errorElement.textContent = '';
        logGuardian(`Pool price checked: ${asset1}/${asset2}, Price=${truncatedCurrentPrice.toFixed(6)}`);

        if (!guardianPoolState.startingPrice) {
            guardianPoolState.startingPrice = truncatedCurrentPrice;
            poolInfo.innerHTML = `
                <p>Current Price: 1 ${asset1} = ${truncatedCurrentPrice.toFixed(6)} ${asset2}</p>
                <p>Starting Price: ${guardianPoolState.startingPrice.toFixed(6)}</p>
            `;
            logGuardian(`Starting price locked: ${guardianPoolState.startingPrice.toFixed(6)}`);
        }
    } catch (error) {
        logGuardian(`guardianCheckPoolPrice error: ${error.message}`);
        errorElement.textContent = error.message.includes("ammNotFound") ? "No AMM pool found." : `Error: ${error.message}`;
        poolInfo.innerHTML = '<p>Current Price: -</p><p>Starting Price: -</p>';
        guardianPoolState = {
            currentPrice: null,
            startingPrice: null,
            lastPriceCheckTimestamp: null,
            asset1: null,
            asset2: null,
            asset1Hex: null,
            asset2Hex: null,
            asset1Issuer: null,
            asset2Issuer: null
        };
    }
}

function updateGuardianPriceDisplay() {
    const slider = document.getElementById('guardian-price-slider');
    const display = document.getElementById('guardian-price-percentage');
    if (slider && display) {
        const value = parseFloat(slider.value);
        
        const truncatedValue = Number(value.toFixed(2));
        display.textContent = `${truncatedValue.toFixed(2)}%`;
        logGuardian(`Price change set to ${truncatedValue.toFixed(2)}%`);
    } else {
        logGuardian('Error: Guardian price slider or percentage display not found.');
    }
}

function updateGuardianBalanceDisplay() {
    const slider = document.getElementById('guardian-balance-slider');
    const display = document.getElementById('guardian-balance-percentage');
    if (slider && display) {
        const value = parseFloat(slider.value);
        
        const truncatedValue = Number(value.toFixed(2));
        display.textContent = `${truncatedValue.toFixed(2)}%`;
        logGuardian(`Balance percentage set to ${truncatedValue.toFixed(2)}%`);
    } else {
        logGuardian('Error: Guardian balance slider or percentage display not found.');
    }
}

function updateGuardianSlippageDisplay() {
    const slider = document.getElementById('guardian-slippage-slider');
    const display = document.getElementById('guardian-slippage-percentage');
    if (slider && display) {
        const value = parseFloat(slider.value);
        
        const truncatedValue = Number(value.toFixed(2));
        display.textContent = `${truncatedValue.toFixed(2)}%`;
        logGuardian(`Slippage tolerance set to ${truncatedValue.toFixed(2)}%`);
    } else {
        logGuardian('Error: Guardian slippage slider or percentage display not found.');
    }
}

async function addGuardianRule() {
    const errorElement = document.getElementById('guardian-error');
    const asset1Display = document.getElementById('guardian-asset1-display');
    const asset2Display = document.getElementById('guardian-asset2-display');
    const priceSlider = document.getElementById('guardian-price-slider');
    const balanceSlider = document.getElementById('guardian-balance-slider');
    const slippageSlider = document.getElementById('guardian-slippage-slider');

    if (!asset1Display || !asset2Display || !priceSlider || !balanceSlider || !slippageSlider || !errorElement) {
        logGuardian('Error: Guardian input elements not found.');
        errorElement.textContent = 'Guardian elements missing.';
        return;
    }

    const asset1 = asset1Display.getAttribute('data-value');
    const asset2 = asset2Display.getAttribute('data-value');
    const asset1Hex = asset1Display.getAttribute('data-hex');
    const asset2Hex = asset2Display.getAttribute('data-hex');
    const asset1Issuer = asset1Display.getAttribute('data-issuer');
    const asset2Issuer = asset2Display.getAttribute('data-issuer');
    const priceChangePercent = parseFloat(priceSlider.value);
    const balancePercent = parseFloat(balanceSlider.value);
    const slippagePercent = parseFloat(slippageSlider.value);

    if (!asset1 || !asset2 || !asset1Hex || !asset2Hex) {
        logGuardian('Error: Asset pair not selected.');
        errorElement.textContent = 'Select both assets.';
        return;
    }

    if (!guardianPoolState.startingPrice) {
        logGuardian('Error: Starting price not set. Click "Get Current Price" first.');
        errorElement.textContent = 'Please get current price first.';
        return;
    }

    if (isNaN(priceChangePercent) || priceChangePercent < -10 || priceChangePercent > 10) {
        logGuardian('Error: Invalid price change percentage.');
        errorElement.textContent = 'Price change must be between -10% and 10%.';
        return;
    }

    if (isNaN(balancePercent) || balancePercent <= 0 || balancePercent > 100) {
        logGuardian('Error: Invalid balance percentage.');
        errorElement.textContent = 'Balance percentage must be between 0% and 100%.';
        return;
    }

    if (isNaN(slippagePercent) || slippagePercent < 0.1 || slippagePercent > 5) {
        logGuardian('Error: Invalid slippage percentage.');
        errorElement.textContent = 'Slippage tolerance must be between 0.1% and 5%.';
        return;
    }

    const address = globalAddress;
    if (!contentCache || !displayTimer || !xrpl.isValidAddress(address)) {
        logGuardian('Error: No wallet loaded or invalid address.');
        errorElement.textContent = 'No wallet loaded or invalid address.';
        return;
    }

    try {
        await ensureConnected();
        let inputBalance;
        const inputAsset = asset1; 
        const inputHex = asset1Hex;
        const inputIssuer = asset1Issuer;
        const outputAsset = asset2; 
        const outputHex = asset2Hex;
        const outputIssuer = asset2Issuer;

        logGuardian(`Setting rule: sell ${inputAsset} to buy ${outputAsset}`);

        if (inputAsset === "XRP") {
            const { availableBalanceXrp } = await calculateAvailableBalance(address);
            
            let integerDigits = Math.floor(availableBalanceXrp - 1).toString().replace(/^0+/, '') || '0';
            let maxDecimalPlaces = integerDigits.length >= 9 ? Math.max(0, 15 - integerDigits.length) : 6;
            inputBalance = Math.max(0, Number((availableBalanceXrp - 1).toFixed(maxDecimalPlaces)));
        } else {
            const accountLines = await client.request({ command: "account_lines", account: address, ledger_index: "current" });
            const trustline = accountLines.result.lines.find(line => line.currency === inputHex && line.account === inputIssuer);
            
            inputBalance = trustline ? parseFloat(Number(trustline.balance).toFixed(6)) : 0;
        }

        if (inputBalance <= 0) {
            logGuardian(`Error: No balance available for ${inputAsset}.`);
            errorElement.textContent = `No balance available for ${inputAsset}.`;
            return;
        }

        const rule = {
            id: Date.now(),
            asset1,
            asset2,
            asset1Hex,
            asset2Hex,
            asset1Issuer,
            asset2Issuer,
            priceChangePercent,
            balancePercent,
            slippagePercent,
            startingPrice: guardianPoolState.startingPrice,
            inputAsset,
            inputHex,
            inputIssuer,
            outputAsset,
            outputHex,
            outputIssuer,
            inputBalance,
            direction: guardianPoolState.direction
        };

        watchedAssets.push(rule);
        logGuardian(`Added Guardian rule: sell ${balancePercent}% of ${inputAsset} to buy ${outputAsset} when ${asset1}/${asset2} changes by ${priceChangePercent.toFixed(2)}% with ${slippagePercent}% slippage`);
        logGuardianOutput(`Rule added: sell ${balancePercent}% of ${inputAsset} to buy ${outputAsset} when ${asset1}/${asset2} changes by ${priceChangePercent.toFixed(2)}% with ${slippagePercent}% slippage`);
        playGuardianSound('Guardian Active.wav');
        updateWatchedAssetsDisplay();
        errorElement.textContent = '';

        priceSlider.value = 0;
        balanceSlider.value = 0;
        slippageSlider.value = 1;
        document.getElementById('guardian-price-percentage').textContent = '0.00%';
        document.getElementById('guardian-balance-percentage').textContent = '0%';
        document.getElementById('guardian-slippage-percentage').textContent = '1.00%';

        if (!isMonitoringPrices) {
            startPriceMonitoring();
        }
    } catch (error) {
        logGuardian(`addGuardianRule error: ${error.message}`);
        errorElement.textContent = `Error: ${error.message}`;
    }
}
function updateWatchedAssetsDisplay() {
    const queueElement = document.getElementById('guardian-queue');
    if (!queueElement) return;

    queueElement.innerHTML = '<p>Watched Assets:</p>';
    if (watchedAssets.length === 0) {
        queueElement.innerHTML += '<p>No assets being watched.</p>';
    } else {
        watchedAssets.forEach((rule, index) => {
            const description = `${index + 1}. Sell ${rule.balancePercent}% of ${rule.inputAsset} to buy ${rule.outputAsset} when ${rule.asset1}/${rule.asset2} changes by ${rule.priceChangePercent.toFixed(2)}% (Slippage: ${rule.slippagePercent}%, Starting Price: ${rule.startingPrice.toFixed(6)})`;
            queueElement.innerHTML += `
                <p>
                    ${description}
                    <button class="red-black-btn" onclick="cancelGuardianRule(${rule.id})" style="margin-left: 10px; padding: 4px 8px; font-size: 0.7rem;">Cancel</button>
                </p>`;
        });
    }
}

function cancelGuardianRule(ruleId) {
    const rule = watchedAssets.find(r => r.id === ruleId);
    if (rule) {
        watchedAssets = watchedAssets.filter(r => r.id !== ruleId);
        logGuardian(`Cancelled Guardian rule: sell ${rule.balancePercent}% of ${rule.inputAsset} to buy ${rule.outputAsset} for ${rule.asset1}/${rule.asset2}`);
        logGuardianOutput(`Rule cancelled: sell ${rule.balancePercent}% of ${rule.inputAsset} to buy ${rule.outputAsset} when ${rule.asset1}/${rule.asset2} changes by ${rule.priceChangePercent.toFixed(2)}%`);
        
        playGuardianSound('Guardian Cancel Action.wav');
        updateWatchedAssetsDisplay();
    }
}
async function monitorPoolPrices() {
    if (isMonitoringPrices) return;
    isMonitoringPrices = true;

    try {
        while (watchedAssets.length > 0) {
            for (const rule of watchedAssets) {
                try {
                    const { asset1, asset2, asset1Hex, asset2Hex, asset1Issuer, asset2Issuer, direction, priceChangePercent } = rule;
                    const asset1Data = asset1 === "XRP" ? { currency: "XRP" } : { currency: asset1Hex, issuer: asset1Issuer };
                    const asset2Data = asset2 === "XRP" ? { currency: "XRP" } : { currency: asset2Hex, issuer: asset2Issuer };

                    const ammInfo = await throttleRequest(() =>
                        client.request({
                            command: "amm_info",
                            asset: asset1Data,
                            asset2: asset2Data,
                            ledger_index: "current"
                        })
                    );

                    if (!ammInfo.result.amm) {
                        logGuardian(`No AMM pool found for ${asset1}/${asset2} in monitoring.`);
                        continue;
                    }

                    const amount1 = ammInfo.result.amm.amount;
                    const amount2 = ammInfo.result.amm.amount2;
                    let poolXrp, poolToken, currentPrice;

                    if (direction === "XRP-to-Token") {
                        poolXrp = parseFloat(xrpl.dropsToXrp(amount1));
                        poolToken = parseFloat(amount2.value);
                    } else {
                        poolXrp = parseFloat(xrpl.dropsToXrp(amount2));
                        poolToken = parseFloat(amount1.value);
                    }

                    
                    let integerDigits = Math.floor(poolXrp).toString().replace(/^0+/, '') || '0';
                    let maxDecimalPlaces = integerDigits.length >= 9 ? Math.max(0, 15 - integerDigits.length) : 6;
                    poolXrp = Number(poolXrp.toFixed(maxDecimalPlaces));

                    integerDigits = Math.floor(poolToken).toString().replace(/^0+/, '') || '0';
                    maxDecimalPlaces = integerDigits.length >= 9 ? Math.max(0, 15 - integerDigits.length) : 6;
                    poolToken = Number(poolToken.toFixed(maxDecimalPlaces));

                    currentPrice = direction === "XRP-to-Token" ? poolToken / poolXrp : poolXrp / poolToken;
                    
                    integerDigits = Math.floor(currentPrice).toString().replace(/^0+/, '') || '0';
                    maxDecimalPlaces = integerDigits.length >= 9 ? Math.max(0, 15 - integerDigits.length) : 6;
                    currentPrice = Number(currentPrice.toFixed(maxDecimalPlaces));

                    const priceChange = ((currentPrice - rule.startingPrice) / rule.startingPrice) * 100;
                    logGuardian(`Monitoring ${asset1}/${asset2}: Current Price=${currentPrice.toFixed(6)}, Starting Price=${rule.startingPrice.toFixed(6)}, Change=${priceChange.toFixed(2)}%`);

                    
                    if (priceChangePercent < 0 && priceChange <= priceChangePercent) {
                        logGuardian(`Price condition met for selling ${asset1} to buy ${asset2}. Queuing swap...`);
                        await queueGuardianSwap(rule, currentPrice);
                        break; 
                    } else if (priceChangePercent > 0 && priceChange >= priceChangePercent) {
                        logGuardian(`Price condition met for selling ${asset1} to buy ${asset2}. Queuing swap...`);
                        await queueGuardianSwap(rule, currentPrice);
                        break; 
                    }
                } catch (error) {
                    logGuardian(`Price monitoring error for ${rule.asset1}/${rule.asset2}: ${error.message}`);
                }
            }

            await new Promise(resolve => setTimeout(resolve, 60000));
        }
    } catch (error) {
        logGuardian(`monitorPoolPrices error: ${error.message}`);
    } finally {
        isMonitoringPrices = false;
        logGuardian('Price monitoring stopped.');
    }
}

async function queueGuardianSwap(rule, currentPrice) {
    try {
        const address = globalAddress;
        if (!contentCache || !displayTimer || !xrpl.isValidAddress(address)) {
            logGuardian('Error: No wallet loaded or invalid address.');
            logGuardianOutput(`Swap failed for ${rule.asset1}/${rule.asset2}: No wallet loaded or invalid address.`);
            return;
        }

        await ensureConnected();
        const seed = await fetchRenderContent();
        const wallet = xrpl.Wallet.fromSeed(seed);

        const { inputAsset, inputHex, inputIssuer, outputAsset, outputHex, outputIssuer, balancePercent, slippagePercent, inputBalance } = rule;
        let amount = (balancePercent / 100) * inputBalance;
        if (amount <= 0) {
            logGuardian(`Error: Invalid swap amount for ${inputAsset}.`);
            logGuardianOutput(`Swap failed for ${rule.asset1}/${rule.asset2}: Invalid swap amount for ${inputAsset}.`);
            return;
        }

        
        let integerDigits = Math.floor(amount).toString().replace(/^0+/, '') || '0';
        let maxDecimalPlaces = integerDigits.length >= 9 ? Math.max(0, 15 - integerDigits.length) : 6;
        const roundedAmount = Number(amount.toFixed(maxDecimalPlaces));

        let expectedOutput;
        if (rule.direction === "XRP-to-Token") {
            expectedOutput = roundedAmount * currentPrice; 
        } else {
            expectedOutput = roundedAmount / currentPrice; 
        }

        
        integerDigits = Math.floor(expectedOutput).toString().replace(/^0+/, '') || '0';
        maxDecimalPlaces = integerDigits.length >= 9 ? Math.max(0, 15 - integerDigits.length) : 6;
        const roundedOutput = Number(expectedOutput.toFixed(maxDecimalPlaces));

        
        await validateBalancesForTransaction(address, { hex: inputHex, issuer: inputIssuer, name: inputAsset }, roundedAmount, inputAsset !== "XRP");

        const slippageMultiplier = 1 - (slippagePercent / 100);
        
        let minDeliveredAmountValue = roundedOutput * slippageMultiplier;
        integerDigits = Math.floor(minDeliveredAmountValue).toString().replace(/^0+/, '') || '0';
        maxDecimalPlaces = integerDigits.length >= 9 ? Math.max(0, 15 - integerDigits.length) : 6;
        minDeliveredAmountValue = Number(minDeliveredAmountValue.toFixed(maxDecimalPlaces));

        const minDeliveredAmount = outputAsset === "XRP" ?
            xrpl.xrpToDrops(minDeliveredAmountValue) :
            { currency: outputHex, issuer: outputIssuer, value: minDeliveredAmountValue.toString() };

        
        let sendMaxValue = roundedAmount * (1 + (slippagePercent / 100));
        integerDigits = Math.floor(sendMaxValue).toString().replace(/^0+/, '') || '0';
        maxDecimalPlaces = integerDigits.length >= 9 ? Math.max(0, 15 - integerDigits.length) : 6;
        sendMaxValue = Number(sendMaxValue.toFixed(maxDecimalPlaces));

        const sendMax = inputAsset === "XRP" ?
            xrpl.xrpToDrops(sendMaxValue) :
            { currency: inputHex, issuer: inputIssuer, value: sendMaxValue.toString() };

        const tx = {
            TransactionType: "Payment",
            Account: address,
            Amount: minDeliveredAmount,
            Destination: address,
            SendMax: sendMax,
            Fee: TRANSACTION_FEE_DROPS,
            Flags: 0x80000000
        };

        const txEntry = {
            tx: tx,
            wallet: wallet,
            description: `Guardian Swap: sell ${roundedAmount} ${inputAsset} for ${roundedOutput} ${outputAsset} via AMM (Slippage: ${slippagePercent}%)`,
            delayMs: 0,
            type: "guardian",
            queueElementId: "guardian-queue"
        };

        transactionQueue.push(txEntry);
        logGuardian(`Guardian swap queued: ${txEntry.description}`);
        logGuardianOutput(`Swap queued: ${txEntry.description}`);
        
        playGuardianSound('Guardian Action Taken.wav');

        watchedAssets = watchedAssets.filter(r => r.id !== rule.id);
        logGuardian(`Cleared fulfilled Guardian rule: sell ${rule.balancePercent}% of ${inputAsset} to buy ${rule.outputAsset} for ${rule.asset1}/${rule.asset2}`);
        logGuardianOutput(`Rule fulfilled and cleared: sell ${rule.balancePercent}% of ${inputAsset} to buy ${rule.outputAsset} when ${rule.asset1}/${rule.asset2} changed by ${rule.priceChangePercent.toFixed(2)}%`);
        updateWatchedAssetsDisplay();
        updateTransactionQueueDisplay();

        if (!isProcessingQueue) {
            processTransactionQueue();
        }
    } catch (error) {
        logGuardian(`queueGuardianSwap error: ${error.message}`);
        logGuardianOutput(`Swap failed for ${rule.asset1}/${rule.asset2}: ${error.message}`);
    }
}
function startPriceMonitoring() {
    if (watchedAssets.length > 0 && !isMonitoringPrices) {
        logGuardian('Starting price monitoring...');
        monitorPoolPrices();
    }
}

function initializeGuardianDropdowns() {
    
    const prefabAssets = window.prefabAssets || [
    { name: "$Xoge", issuer: "rJMtvf5B3GbuFMrqybh5wYVXEH4QE8VyU1", hex: "586F676500000000000000000000000000000000" },	
	{ name: "$RLUSD", issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", hex: "524C555344000000000000000000000000000000" },
    { name: "$PUPU", issuer: "r4WfqR5DQ7PwPvVJv8Gism5cQBLGtNnvK8", hex: "5055505500000000000000000000000000000000" },
	{ name: "$Army", issuer: "rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC", hex: "41524D5900000000000000000000000000000000" },
	{ name: "$BANANA", issuer: "rpopnahpwzxiwapipm5ehq6kslehvgilqp", hex: "42414e414e410000000000000000000000000000" },
	{ name: "$589", issuer: "rfcasq9uRbvwcmLFvc4ti3j8Qt1CYCGgHz", hex: "589" },
	{ name: "$Bert", issuer: "rpwAnF1mMZRszxdinETFHwzGQiPgsv3jHR", hex: "4245525400000000000000000000000000000000" },
	{ name: "$Scrap", issuer: "rGHtYnnigyuaHehWGfAdoEhkoirkGNdZzo", hex: "7363726170000000000000000000000000000000" },
	{ name: "$RPLS", issuer: "r93hE5FNShDdUqazHzNvwsCxL9mSqwyiru", hex: "52504C5300000000000000000000000000000000" },
	{ name: "$Nox", issuer: "rBbu9c7zyuiDH4bq7uJhdLhzsRdEkSrYFX", hex: "NOX" },
	{ name: "$BITx", issuer: "rBitcoiNXev8VoVxV7pwoQx1sSfonVP9i3", hex: "4249547800000000000000000000000000000000" },
	{ name: "$METH", issuer: "rKus1pe2EZAgaL18b8MbiJkgrniWTP625G", hex: "4D45544800000000000000000000000000000000" },
	{ name: "$Schwepe", issuer: "rUQXurByxmKni4aLpuWMYMxxV5GWT1Azw2", hex: "5343485745504500000000000000000000000000" },
	{ name: "$Xrpm", issuer: "r9mZNnos1GLtc55tkmr21G9BgXxV7w9hT1", hex: "5852504D00000000000000000000000000000000" },
	{ name: "$Flippy", issuer: "rsENFmELvj92orrCKTkDTug53MzwsB7zBd", hex: "24464C4950505900000000000000000000000000" },
	{ name: "$Lihua", issuer: "rnhtvpHsAgigmVemgtzt7pujj4gv6LVL2a", hex: "4C49485541000000000000000000000000000000" },
	{ name: "$Slt", issuer: "rfGCeDUdtbzKbXfgvrpG745qdC1hcZBz8S", hex: "SLT" },
	{ name: "$BMT", issuer: "rE8dJChTgdF4GD84z8Ah5NoNbVvMTqRMLk", hex: "BMT" },
	{ name: "$Ripple", issuer: "rMgrYs2XYgbGaLZ19HbUXfi9rpsaFQYwgc", hex: "524950504C450000000000000000000000000000" },
	{ name: "$Xox", issuer: "rGJbFqiLdh23e9WigQ5sxTfFqTENveLX21", hex: "XOX" },
	{ name: "$Ribble", issuer: "rG7jT6D4fHsipvVmPSbcnvDtFzXwwSR4qx", hex: "524942424C450000000000000000000000000000" },
	{ name: "$Riptard", issuer: "r37NJszgETCmYqUkPH7PmtkpVdsYBfMYSc", hex: "5249505441524400000000000000000000000000" },
	{ name: "$Pigeon", issuer: "rhxmPqZGPeHTW684vbf1HAMsHff8RTDfWn", hex: "504944474E000000000000000000000000000000" },
	{ name: "$America", issuer: "rpVajoWTXFkKWY7gtWSwcpEcpLDUjtktCA", hex: "416D657269636100000000000000000000000000" },
	{ name: "$Grim", issuer: "rHLRdLwXiBZSD53ZQz8ogGJz25LzNCCjSz", hex: "4752494D00000000000000000000000000000000" },
	{ name: "$Britto", issuer: "rfxwXDzenkYoXSEbNA4cZjaT9FY3eeL47e", hex: "42524954544F0000000000000000000000000000" },
	{ name: "$Fuzzy", issuer: "rhCAT4hRdi2Y9puNdkpMzxrdKa5wkppR62", hex: "46555A5A59000000000000000000000000000000" },
	{ name: "$Barron", issuer: "rLxJv7a6uScd6qaSbuELTPkj9i2vJhn6YZ", hex: "426172726F6E0000000000000000000000000000" },
	{ name: "$Blue", issuer: "rDPQ9k3w791dgPNw6FwivrbfHVexaLhZXJ", hex: "424C554500000000000000000000000000000000" },
	{ name: "$Flame", issuer: "rp5CUgVjAhuthJs8LdjTXFdNWJzfQqc3p2", hex: "464C414D45000000000000000000000000000000" },
	{ name: "$Grumpy", issuer: "ra9UE2hHy4AaLeEvbj6gKFPF1DWP2K8kT6", hex: "4752554D50590000000000000000000000000000" },
	{ name: "$Pep", issuer: "r4eNzo9fDVjME4EwYS1wbTK4J2br5opD1F", hex: "PEP" },
	{ name: "$Mouse", issuer: "rJevHGVUzAUPSGxiECgqcNVNVjRkTBWD7T", hex: "4D4F555345000000000000000000000000000000" },
	{ name: "$Luther", issuer: "rPBWcjbyqcrGxpUe4awobqMmB2WaeUhuFb", hex: "4C55544845520000000000000000000000000000" },
	{ name: "$BitcoinOnXrp", issuer: "rhLJ2ma5pScsxVhL5EQr71w3FgASVLwP84", hex: "BOX" },
	{ name: "$Toto", issuer: "r9sH6YEVRyg8uYaKfyk1EfH36Lfq7a8PUD", hex: "544F544F00000000000000000000000000000000" },
	{ name: "$Trump", issuer: "r3iM2Ffe9Krgn6n3qhHj2oe8kiJMKB63s7", hex: "245452554D500000000000000000000000000000" },
	{ name: "$XGC", issuer: "rM4qkDcRyMDks5v1hYakKnLbTeppmgCpM1", hex: "XGC" },
	{ name: "$Kekius", issuer: "rLWCx7obzMRbFfreNR6eScPz6GWj4xbr4v", hex: "4B454B4955530000000000000000000000000000" },
	{ name: "$Doge", issuer: "rp4GXygXPM2ydNLgiDeHrrkfuaAufSZaca", hex: "444F474500000000000000000000000000000000" },
	{ name: "$Sand", issuer: "rs5zZN42NGy9VdEMuTgU6NVPqpBZQRZ2bv", hex: "AND" },
	{ name: "$Zrpy", issuer: "rsxkrpsYaeTUdciSFJwvto7MKSrgGnvYvA", hex: "5A52505900000000000000000000000000000000" },
	{ name: "$Meme", issuer: "rs98d8usUqkf9Wuww6MgMghSdQpvMmVFt4", hex: "4D454D4500000000000000000000000000000000" },
	{ name: "$Uga", issuer: "rBFJGmWj6YaabVCxfsjiCM8pfYXs8xFdeC", hex: "UGA" },
	{ name: "$Goat", issuer: "r96Ny5BTU3z4Aw4BfiMJ7RTgDa5iE17u9t", hex: "474F415400000000000000000000000000000000" },
	{ name: "$XRDOGE", issuer: "rLqUC2eCPohYvJCEBJ77eCCqVL2uEiczjA", hex: "5852646F67650000000000000000000000000000" },
	{ name: "$Xrpete", issuer: "rEBFKbaYRkzt9tBvV51xaW1RLYZaNyBztC", hex: "5852506574650000000000000000000000000000" },
	{ name: "$Denari", issuer: "rUY6tjGN8PJDVyVFLztRZLmPZ8uTBUfa2Z", hex: "DFI" },
	{ name: "$Peipei", issuer: "r9RftFhd6P9MzWsNkayH1Hb8rPzY5GkaGE", hex: "5045495045490000000000000000000000000000" },
	{ name: "$Rizzle", issuer: "rE99nDT3riuM9VjMQkVstMqRGBsnUHw6vm", hex: "52495A5A4C450000000000000000000000000000" },
	{ name: "$Alex", issuer: "rEwd8T3xMrhJwybaEPCMYY9NeDnxdmpiYw", hex: "24414C4558000000000000000000000000000000" },
	{ name: "$Normie", issuer: "rwtZ99naquDaXzHJNQVn9okoseWTWjQYcp", hex: "4E4F524D49450000000000000000000000000000" },
	{ name: "$Starbro", issuer: "rLfF6rkXsMvNBYosPmwX2kAGQ5oMtab6dW", hex: "5354415242524F00000000000000000000000000" },
	{ name: "$404", issuer: "raHJ4Jz9PYk356wWaDMYw79B17iWtfsSMi", hex: "404" },
	{ name: "$Xrpee", issuer: "r95aZmg9f6UU1CUApwS8V2hmejWrq5ESd3", hex: "5852506565000000000000000000000000000000" },
	{ name: "$Brb", issuer: "rUkuT9TCDTP2oeAPsrCN7XKcHZfdvHvFkG", hex: "BRB" },
	{ name: "$Maga", issuer: "rwH49FHnr48FeUP7NX9EuL4k1peLrPwS3d", hex: "4D41474100000000000000000000000000000000" },
	{ name: "$Stksy", issuer: "rMyKhoyQnheGEQBfLH4sjdg9pN5z72ehrT", hex: "53544B5359000000000000000000000000000000" },
	{ name: "$Bchamp", issuer: "rhYhn7s6z4HAfuJm7ehuSE7wxepRoUPwpi", hex: "424348414D500000000000000000000000000000" },
	{ name: "$Xtr", issuer: "rafe4x2fTrgFXauqEfmyjHDmhFgqB1YYGv", hex: "XTR" },
	{ name: "$Xwar", issuer: "rJAm3vMSiwCZHxLygaTdmiqCUG8YeSJFVy", hex: "5857415200000000000000000000000000000000" },	
	{ name: "$Cult", issuer: "rCULtAKrKbQjk1Tpmg5hkw4dpcf9S9KCs", hex: "43554C5400000000000000000000000000000000" },	
	{ name: "$SOLO", issuer: "rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz", hex: "534F4C4F00000000000000000000000000000000" },	
	{ name: "$ELS", issuer: "rHXuEaRYnnJHbDeuBH5w8yPh5uwNVh5zAg", hex: "ELS" },	
	{ name: "$CORE", issuer: "rcoreNywaoz2ZCQ8Lg2EbSLnGuRBmun6D", hex: "434F524500000000000000000000000000000000" },	
	{ name: "$VGB", issuer: "rhcyBrowwApgNonehKBj8Po5z4gTyRknaU", hex: "VGB" },	
	{ name: "$CX1", issuer: "rKk7mu1dNB25fsPEJ4quoQd5B8QmaxewKi", hex: "CX1" },	
	{ name: "$XCORE", issuer: "r3dVizzUAS3U29WKaaSALqkieytA2LCoRe", hex: "58434F5245000000000000000000000000000000" },	
	{ name: "$BTC-Gatehub", issuer: "rchGBxcD1A1C2tdxF6papQYZ8kjRKMYcL", hex: "BTC" },	
	{ name: "$ETH-Gatehub", issuer: "rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h", hex: "ETH" },	
	{ name: "$Equilibrium", issuer: "rpakCr61Q92abPXJnVboKENmpKssWyHpwu", hex: "457175696C69627269756D000000000000000000" },	
	{ name: "$CallCentre", issuer: "rpHry9uUAhG3SCfmjVgypMYkGr2XQZqH4z", hex: "43616C6C43656E74726500000000000000000000" },	
	{ name: "$PHNIX", issuer: "rDFXbW2ZZCG5WgPtqwNiA2xZokLMm9ivmN", hex: "50484E4958000000000000000000000000000000" },	
	{ name: "$USD-Gatehub", issuer: "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq", hex: "USD" },	
	{ name: "$EUR-Gatehub", issuer: "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq", hex: "EUR" },	
	{ name: "$XQK", issuer: "rHKrPGdpaqNRqRvmsiqQhD6azqc4npWoLC", hex: "XQK" },	
	{ name: "$XRdoge", issuer: "rLqUC2eCPohYvJCEBJ77eCCqVL2uEiczjA", hex: "5852646F67650000000000000000000000000000" },	
	{ name: "$NICE", issuer: "r96uXvCJxe3Yeeo9wCtJsLSpJiFUz2hvsB", hex: "4E49434500000000000000000000000000000000" },	
	{ name: "$XDX", issuer: "rMJAXYsbNzhwp7FfYnAsYP5ty3R9XnurPo", hex: "XDX" },	
	{ name: "$LCB", issuer: "r9U2eJg3FgpYKX8PrFPSxHdVu4ZheLZRJ3", hex: "LCB" },	
	{ name: "$RPR", issuer: "r3qWgpz2ry3BhcRJ8JE6rxM8esrfhuKp4R", hex: "RPR" },	
	{ name: "$Calorie", issuer: "rNqGa93B8ewQP9mUwpwqA19SApbf62U7PY", hex: "43616C6F72696500000000000000000000000000" },	
	{ name: "$FSE", issuer: "rs1MKY54miDtMFEGyNuPd3BLsXauFZUSrj", hex: "FSE" },	
	{ name: "$BIL", issuer: "rHSMLJNzjagXS3xS3wW2NcBpXWbyTuUybB", hex: "BIL" },	
	{ name: "$PASA", issuer: "rBPtuMc4HBR1SuZyZv8hs7WBVxLBYrzxbY", hex: "5041534100000000000000000000000000000000" },	
	{ name: "$CodeCoin", issuer: "rGbsKNrVURRfU1WEb1aEqaoyRJDkvssyBa", hex: "436F6465436F696E000000000000000000000000" },	
	{ name: "$CNY", issuer: "razqQKzJRdB4UxFPWf5NEpEG3WMkmwgcXA", hex: "CNY" },	
	{ name: "$ARMY", issuer: "rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC", hex: "41524D5900000000000000000000000000000000" },	
	{ name: "$ATM", issuer: "raDZ4t8WPXkmDfJWMLBcNZmmSHmBC523NZ", hex: "ATM" },	
	{ name: "$LUC", issuer: "rsygE5ynt2iSasscfCCeqaGBGiFKMCAUu7", hex: "LUC" },	
	{ name: "$Daric", issuer: "rK9AtihZZYWAwZQnJCYzZnyW833vbcPXPf", hex: "4461726963000000000000000000000000000000" },	
	{ name: "$TRSRY", issuer: "rLBnhMjV6ifEHYeV4gaS6jPKerZhQddFxW", hex: "5452535259000000000000000000000000000000" },	
	{ name: "$DRT", issuer: "rfDhSfY5JMtCrje7hGxC8Gk6dC5PgNJh63", hex: "DRT" },	
	{ name: "$MLD", issuer: "rhJYDuVMQxabTyiWuHQkQyDxr6uZEdpv5u", hex: "MLD" },	
	{ name: "$XRSHIB", issuer: "rN3EeRSxh9tLHAUDmL7Chh3vYYoUafAyyM", hex: "5852534849420000000000000000000000000000" },	
	{ name: "$XPM", issuer: "rXPMxBeefHGxx2K7g5qmmWq3gFsgawkoa", hex: "XPM" },	
	{ name: "$XMETA", issuer: "r3XwJ1hr1PtbRvbhuUkybV6tmYzzA11WcB", hex: "584D455441000000000000000000000000000000" },	
	{ name: "$ShibaNFT", issuer: "rnRXAnVZTyattZXEpKpgTyvdm17DpjrzSZ", hex: "53686962614E4654000000000000000000000000" },	
	{ name: "$Editions", issuer: "rfXwi3SqywQ2gSsvHgfdVsyZdTVM15BG7Z", hex: "65646974696F6E73000000000000000000000000" },	
	{ name: "$XRPS", issuer: "rN1bCPAxHDvyJzvkUso1L2wvXufgE4gXPL", hex: "5852505300000000000000000000000000000000" },	
	{ name: "$xSTIK", issuer: "rJNV9i4Q6zvRhpE2zjxgkvff3eGHQohZht", hex: "785354494B000000000000000000000000000000" },	
	{ name: "$MRM", issuer: "rNjQ9HZYiBk1WhuscDkmJRSc3gbrBqqAaQ", hex: "MRM" },	
	{ name: "$CNY", issuer: "rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y", hex: "CNY" },	
	{ name: "$xCBS", issuer: "rNvhXtgDdd4Sh3NKLXcUH9Hozs4dqu62we", hex: "7843425300000000000000000000000000000000" },	
	{ name: "$Gift", issuer: "rBXXRBZ46rwCkS9mHom3WW8u7gSytb5KcZ", hex: "4769667400000000000000000000000000000000" },	
	{ name: "$KGE", issuer: "rNhSjAMnDJc9tDHH1R4sqggvgDGa8Bwj5T", hex: "KGE" },	
	{ name: "$XGBL", issuer: "rMy6sCaDVF1C2BT3qmNG6kgjVDZqZ74uoF", hex: "5847424C00000000000000000000000000000000" },	
	{ name: "$XRWeb", issuer: "rDegPvsK5c2nzaKTn2PsuPZjs8b3neDDn", hex: "5852576562000000000000000000000000000000" },	
	{ name: "$xCoin", issuer: "rXCoYSUnkpygdtfpz3Df8dKQuRZjM9UFi", hex: "78436F696E000000000000000000000000000000" },	
	{ name: "$Outback", issuer: "rMzXS3BwhAwgb4fTK6ohik65jJUKKrzmqn", hex: "4F55544241434B00000000000000000000000000" },	
	{ name: "$DRS", issuer: "rDrSRap6jdWqtmxjpvDUCv3q128UjL2GS2", hex: "DRS" },	
	{ name: "$TPR", issuer: "rht98AstPWmLPQMrwd9YDrcDoTjw9Tiu4B", hex: "TPR" },	
	{ name: "$Schmeckles", issuer: "rPxw83ZP6thv7KmG5DpAW4cDW55DZRZ9wu", hex: "5363686D65636B6C657300000000000000000000" },	
	{ name: "$XGF", issuer: "rJnn9jdwaBfuyq383hNiX2oowLuLUm2DZD", hex: "XGF" },	
	{ name: "$SmartNFT", issuer: "	rf8dxyFrYWEcUQAM7QXdbbtcRPzjvoQybK", hex: "536D6172744E4654000000000000000000000000" },	
	{ name: "$DBX", issuer: "rHLJNqxCoPXdm4CnLd3w63ZFRqAUU2U4vS", hex: "DBX" },	
	{ name: "$BBulldoge", issuer: "r3b8BtKC4d8r4Je7PDJhzAgNTLR64seTDu", hex: "4242756C6C646F67650000000000000000000000" },	
	{ name: "$SwissTech", issuer: "raq7pGaYrLZRa88v6Py9V5oWMYEqPYr8Tz", hex: "5377697373546563680000000000000000000000" },	
	{ name: "$Bear", issuer: "rBEARGUAsyu7tUw53rufQzFdWmJHpJEqFW", hex: "4245415200000000000000000000000000000000" },	
	{ name: "$XRTemplate", issuer: "rMX54z8VgtRhPefzqVkdG3LxsuGdFQcXxr", hex: "585254656D706C61746500000000000000000000" },	
	{ name: "$XUM", issuer: "r465PJyGWUE8su1oVoatht6cXZJTg1jc2m", hex: "XUM" },	
	{ name: "$APXX", issuer: "rL2sSC2eMm6xYyx1nqZ9MW4AP185mg7N9t", hex: "4150585800000000000000000000000000000000" },	
	{ name: "$xHulk", issuer: "r43PooeaFyp2cCfqxMkZLu47VKUDaCzQVt", hex: "7848756C6B000000000000000000000000000000" },	
	{ name: "$ELM", issuer: "rQB9HhhBCq2zAVpwQD3jV9ja39DmomdWj1", hex: "ELM" },	
	{ name: "$XRSoftware", issuer: "rJZ9Hpaeqy3fdBvjVUjx1fW1bE75HgaJbr", hex: "5852536F66747761726500000000000000000000" },	
	{ name: "$BlackFriday", issuer: "raFpHssoH3rWkMy9XLjA6NDRW2y44tiFVM", hex: "426C61636B467269646179000000000000000000" },	
	{ name: "$xSPECTAR", issuer: "rh5jzTCdMRCVjQ7LT6zucjezC47KATkuvv", hex: "7853504543544152000000000000000000000000" },	
	{ name: "$BENTLEY", issuer: "rUW7zPkKa2QqMH2jm3PE9WqL3G4oWZL3Hj", hex: "42454E544C455900000000000000000000000000" },	
	{ name: "$CCN", issuer: "rG1bDjT25WyvPz757YC9NqdRKyz9ywF8e8", hex: "CCN" },	
	{ name: "$NFTL", issuer: "r3DCE2UVaqQaGQragAjmwL6kNicF2rw6PL", hex: "4E46544C00000000000000000000000000000000" },	
	{ name: "$XRBear", issuer: "rKxqkAbT2BQUbtnknSAJon7kX89gUKpZu3", hex: "5852426561720000000000000000000000000000" },	
	{ name: "$MAG", issuer: "rXmagwMmnFtVet3uL26Q2iwk287SRvVMJ", hex: "MAG" },	
	{ name: "$SGB-Gategub", issuer: "rctArjqVvTHihekzDeecKo6mkTYTUSBNc", hex: "SGB" },	
	{ name: "$PIN", issuer: "rhx9yNhbo7xtTy6rBY8xrUYkuYdyVs5Arb", hex: "PIN" },	
	{ name: "$XTriviA", issuer: "rhLr8bGvHvBgYXAHNPyXrQAcKGrQ2X5nU4", hex: "5854726976694100000000000000000000000000" },	
	{ name: "$Zinfinite", issuer: "rGMU2cbbMhzodpecrjLQ2A814DqL8LFxjY", hex: "5A696E66696E6974650000000000000000000000" },	
	{ name: "$TALENT", issuer: "r92SQCuWhYoB4w2UnKU7PKj4Mh7jSyemrH", hex: "54414C454E540000000000000000000000000000" },	
	{ name: "$XRsaitama", issuer: "r3nEJus5Ryoo9ckNmY8XHogoPnLfP1unFv", hex: "585273616974616D610000000000000000000000" },	
	{ name: "$XONE", issuer: "rP9v5sQR5LqcB6Bk7xJSKqUoHytkHT1one", hex: "584F4E4500000000000000000000000000000000" },	
	{ name: "$XRGary", issuer: "rCE2rxDDZtM7qkHAxorjkfLiHX71HtqTY", hex: "5852476172790000000000000000000000000000" },	
	{ name: "$Cake", issuer: "ra1XmvmraMiRYarFrHEU7XDojvRyipU5Vg", hex: "43616B6500000000000000000000000000000000" },	
	{ name: "$POKER", issuer: "rfNWXEENu93dvCBnjpFY7mRpprZzBUx8hC", hex: "504F4B4552000000000000000000000000000000" },	
	{ name: "$GOLD", issuer: "rGQtGHrgN4FK1RcEn83q4t8aK6BobzDEMK", hex: "474F4C4400000000000000000000000000000000" },	
	{ name: "$TipCoin", issuer: "rsUjMrcGu8ANoTwv3zUJE6MzSL6K7fMyPU", hex: "546970436F696E00000000000000000000000000" },	
	{ name: "$OCEAN", issuer: "rPCrPJ9Uz988tD1aQVAToioDcCGZ8nbBTn", hex: "4F4345414E000000000000000000000000000000" },	
	{ name: "$USD-Bitstamp", issuer: "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B", hex: "USD" },	
	{ name: "$SPREAD", issuer: "rwPzJd39swHT6NfxvgGFYE7q9q7EcqKuKW", hex: "5350524541440000000000000000000000000000" },	
	{ name: "$SPREAD", issuer: "rwPzJd39swHT6NfxvgGFYE7q9q7EcqKuKW", hex: "5350524541440000000000000000000000000000" },	
	{ name: "$DROP", issuer: "rszenFJoDdiGjyezQc8pME9KWDQH43Tswh", hex: "44524F5000000000000000000000000000000000" },	
	{ name: "$RDX", issuer: "rQa3LW1Au4GxGHzDBkCMKuPcn326w4Wcj2", hex: "RDX" },	
	{ name: "$UVX", issuer: "r4XUTsMNJoT8Cs6rNHzbif5MpZ7sPH1nWF", hex: "UVX" },	
	{ name: "$SmartLOX", issuer: "rBdZkMKuPnzYVVkyL2DrQKV3DsYt5PPVRh", hex: "536D6172744C4F58000000000000000000000000" },	
	{ name: "$MeowRP", issuer: "rMPEuuvWf6MvCu77NpUF37GUkdbwr9Nhhk", hex: "4D656F7752500000000000000000000000000000" },	
	{ name: "$FAITH", issuer: "rfeSrMKMvyb3MSMnQRFZ1Dwd9KHS6g49ZT", hex: "4641495448000000000000000000000000000000" },	
	{ name: "$STX", issuer: "rSTAYKxF2K77ZLZ8GoAwTqPGaphAqMyXV", hex: "STX" },	
	{ name: "$PONGO", issuer: "rwCq6TENSo3Hh9LKipXnLaxaeXBXKubqki", hex: "504F4E474F000000000000000000000000000000" },	
	{ name: "$LOVE", issuer: "rDpdyF9LtYpwRdHZs8sghaPscE8rH9sgfs", hex: "4C4F564500000000000000000000000000000000" },	
	{ name: "$GamerXGold", issuer: "rMczrvMki7DuXsuMf3zGUrqAmWvLKZNnt2", hex: "47616D657258476F6C6400000000000000000000" },	
	{ name: "$Zens", issuer: "rwDUCnzBisR37rUAbHdjpZwoTdSavBoY4f", hex: "5A656E7300000000000000000000000000000000" },	
	{ name: "$XRMiner", issuer: "r46UPDCgKfSLhGisjavEeb48sHmWbnzcX5", hex: "58524D696E657200000000000000000000000000" },	
	{ name: "$Peas", issuer: "rPAArd4yZAJaDCR5gs41YYmGphfj6yzh3R", hex: "5065617300000000000000000000000000000000" },	
	{ name: "$SEC", issuer: "rKrjzz3fN8inpeG8fZAinuyen7ZRcsRvB9", hex: "rKrjzz3fN8inpeG8fZAinuyen7ZRcsRvB9" },	
	{ name: "$XSD", issuer: "r9PwqmHiGiE7yAXmG5mk7wSJAeezLqE7Ei", hex: "XSD" },	
	{ name: "$BumCrack", issuer: "rBuFBE8nx5Zpojj6EY3Lfh4sd1CHskFRC7", hex: "42756D437261636B000000000000000000000000" },	
	{ name: "$IRE", issuer: "rfTYvAG86Y1L61RQjbxHTyJmphYzHgguCd", hex: "IRE" },	
	{ name: "$1MC", issuer: "rsJvPP7GVdPfe5zmQtvxAJVZAmDUGfhkV1", hex: "1MC" },	
	{ name: "$XFLOKI", issuer: "rUtXeAXonpFpgKubAa7LxcLd7NFep92T1t", hex: "58464C4F4B490000000000000000000000000000" },	
	{ name: "$FCX", issuer: "rwSgqza9DUzr8oPDkJz8xUbPbaxAyoeLus", hex: "FCX" },	
	{ name: "$JPY", issuer: "rB3gZey7VWHYRqJHLoHDEJXJ2pEPNieKiS", hex: "JPY" },	
	{ name: "$XWSB", issuer: "rLpL5d9qubKjht8GnkxgnVTQPq9MKNc757", hex: "5857534200000000000000000000000000000000" },	
	{ name: "$xianggang", issuer: "rMUqLuW4RpBvVAKNoaCubvbXgzuSnf6P8J", hex: "7869616E6767616E670000000000000000000000" },	
	{ name: "$CNY", issuer: "rPT74sUcTBTQhkHVD54WGncoqXEAMYbmH7", hex: "CNY" },	
	{ name: "$SimbaXRP", issuer: "rDqwjJ8fUqdyfPjJZ3h93J1XY8hz6CjEYo", hex: "53696D6261585250000000000000000000000000" },	
	{ name: "$OXP", issuer: "rrno7Nj4RkFJLzC4nRaZiLF5aHwcTVon3d", hex: "OXP" },	
	{ name: "$XDogelon", issuer: "rNFKrSUW1xKzDwHz8J9uVAs4GpxtEUoAsF", hex: "58446F67656C6F6E000000000000000000000000" },	
	{ name: "$xBANK", issuer: "rLpDQmJUpDxLXCjrwmm5rPehZyGA4GRFNZ", hex: "7842414E4B000000000000000000000000000000" },	
	{ name: "$LUSD", issuer: "rfL4Sci2ag5hhkpDuqtWYov6j3mshVWLgU", hex: "4C55534400000000000000000000000000000000" },	
	{ name: "$MONTEZUMA", issuer: "rNJpp2TXWrtFfNs8mbEsrj8gj6XVHfHywD", hex: "4D4F4E54455A554D410000000000000000000000" },	
	{ name: "$icoin", issuer: "rJSTh1VLk52tFC3VRXkNWu7Q4nYmfZv7BZ", hex: "69636F696E000000000000000000000000000000" },	
	{ name: "$xLEMUR", issuer: "rMPi7rz6i2qDRv9SmadcwbYaKpS9xqfyQQ", hex: "24784C454D555200000000000000000000000000" },	
	{ name: "$ADV", issuer: "rPneN8WPHZJaMT9pF4Ynyyq4pZZZSeTuHu", hex: "ADV" },	
	{ name: "$CTF", issuer: "r9Xzi4KsSF1Xtr8WHyBmUcvfP9FzTyG5wp", hex: "CTF" },	
	{ name: "$UMMO", issuer: "rfGqDiFegcMm8e9saj48ED74PkotwJCmJd", hex: "554D4D4F00000000000000000000000000000000" },	
	{ name: "$FLR-Gatehub", issuer: "rcxJwVnftZzXqyH9YheB8TgeiZUhNo1Eu", hex: "FLR" },	
	{ name: "$XRMOON", issuer: "rBBh2z5wsxE9gcVE2yUU39UntvRMHDKPpq", hex: "58524D4F4F4E0000000000000000000000000000" },	
	{ name: "$HADALITE", issuer: "rHiPGSMBbzDGpoTPmk2dXaTk12ZV1pLVCZ", hex: "484144414C495445000000000000000000000000" },	
	{ name: "$SSE", issuer: "rMDQTunsjE32sAkBDbwixpWr8TJdN5YLxu", hex: "SSE" },	
	{ name: "$PGN", issuer: "rPUSoeJaHQzrXATtGniVjwBQQDEtJcdwFq", hex: "PGN" },	
	{ name: "$XAH-Gatehub", issuer: "rswh1fvyLqHizBS2awu1vs6QcmwTBd9qiv", hex: "XAH" },	
	{ name: "$xFlashChain", issuer: "rJgcjY1MZJjw946qRqN57V3TGg9PZEA1bw", hex: "78466C617368436861696E000000000000000000" },	
	{ name: "$666", issuer: "rhvf9fe6PP3GC8Bku2Ug7iQPjPDxYZfrxN", hex: "666" },
	{ name: "$Stb", issuer: "rw9kWBD9LwnCrvLEZFDApDDLYfwZFv1dNs", hex: "STB" },
	{ name: "$DiHands", issuer: "rhohwqLVbQmcmghBiqoEvCEDzMir1oL3hB", hex: "24444948414E4453000000000000000000000000" },
	{ name: "$MiLady", issuer: "rhPSguKUfFLjELmXxctobqpz4NgPneBXvS", hex: "4D494C4144590000000000000000000000000000" },
	{ name: "$Burn", issuer: "rwgNTwrsZKPe7xYCy4emjFAYpgnuioHSkd", hex: "4255524E00000000000000000000000000000000" },
	{ name: "$BUT", issuer: "riQtZKAtGWGRThMNBGz8RtLGAKHd7Za8x", hex: "BUT" },
    { name: "$Dood", issuer: "rn5Y9N8APtrc7PVqXdMjkG9qvfw7FWi4kC", hex: "446F6F6400000000000000000000000000000000" },
	{ name: "$Laugh", issuer: "r32nbPw6cyt3KdxinB4ua6WSLRrrF4SXAC", hex: "4C61756768000000000000000000000000000000" },
	{ name: "$Sigma", issuer: "rfKYWZ84fm9eVEdoTcsQCo1WdqMPyaUF5z", hex: "5349474D41000000000000000000000000000000" },
	{ name: "$Xmeme", issuer: "r4UPddYeGeZgDhSGPkooURsQtmGda4oYQW", hex: "584D454D45000000000000000000000000000000" },
	{ name: "$Ascension", issuer: "r3qWgpz2ry3BhcRJ8JE6rxM8esrfhuKp4R", hex: "ASC" },
	{ name: "$ARK", issuer: "rf5Jzzy6oAFBJjLhokha1v8pXVgYYjee3b", hex: "ARK" },
	{ name: "$Pillars", issuer: "rNSYhWLhuHvmURwWbJPBKZMSPsyG5Qek17", hex: "PLR" },
	{ name: "$Grind", issuer: "rDaDV5smdWjr8QcagD8UhbPZWzJBkdVAnH", hex: "GRD" },
    { name: "$3RDEYE", issuer: "rHjyBqFM5oQvXu1soWtATC4r1V6GBnhCQQ", hex: "3352444559450000000000000000000000000000" },
    { name: "$FWOGXRP", issuer: "rNm3VNJJ2PCmQFVDRpDR6N73UEtZh32HFi", hex: "46574F4758525000000000000000000000000000" },
	{ name: "$Joey", issuer: "rN6CXs6J7WDh8miq2C2cre6w7jipc55Ut", hex: "4A6F657900000000000000000000000000000000" },
    { name: "$HAIC", issuer: "rsEXqMHTKDfGzncfJ25XtB9ZY8jayTv7N3", hex: "4841494300000000000000000000000000000000" }
    ];
    const dynamicAssets = window.dynamicAssets || [];

    const dropdowns = [
        {
            id: 'guardian-asset1-dropdown',
            gridId: 'guardian-asset1-grid',
            displayId: 'guardian-asset1-display',
            defaultValue: 'XRP',
            onchange: updateGuardianAssetPair
        },
        {
            id: 'guardian-asset2-dropdown',
            gridId: 'guardian-asset2-grid',
            displayId: 'guardian-asset2-display',
            defaultValue: 'Xoge',
            onchange: updateGuardianAssetPair
        }
    ];

    const combinedAssets = [...prefabAssets, ...dynamicAssets];
    
    if (combinedAssets.length === 0) {
        logGuardian('Warning: No assets available for dropdowns.');
    }

    dropdowns.forEach(({ id, gridId, displayId, defaultValue, onchange }) => {
        const dropdown = document.getElementById(id);
        const grid = document.getElementById(gridId);
        const display = document.getElementById(displayId);
        if (!dropdown || !grid || !display) {
            logGuardian(`Error: Dropdown elements for ${id} not found.`);
            return;
        }

        const currentValue = display.getAttribute('data-value') || defaultValue;
        const columns = [];
        for (let i = 0; i < combinedAssets.length; i += 50) {
            columns.push(combinedAssets.slice(i, i + 50));
        }
        columns[0] = [{ name: 'XRP', hex: 'XRP', issuer: '' }].concat(columns[0] || []);

        grid.innerHTML = '';
        const gridContainer = document.createElement('div');
        gridContainer.className = 'asset-grid-container';
        columns.forEach(column => {
            const columnUl = document.createElement('ul');
            columnUl.className = 'asset-column';
            column.forEach(asset => {
                const li = document.createElement('li');
                li.className = 'asset-option';
                li.textContent = asset.name;
                li.dataset.value = asset.name;
                li.dataset.hex = asset.hex || 'XRP';
                li.dataset.issuer = asset.issuer || '';
                li.onclick = () => {
                    display.textContent = asset.name;
                    display.setAttribute('data-value', asset.name);
                    display.setAttribute('data-hex', asset.hex || 'XRP');
                    display.setAttribute('data-issuer', asset.issuer || '');
                    document.getElementById(`${id.replace('-dropdown', '-panel')}`).style.display = 'none';
                    onchange();
                };
                columnUl.appendChild(li);
            });
            gridContainer.appendChild(columnUl);
        });
        grid.appendChild(gridContainer);

        const selectedAsset = combinedAssets.find(a => a.name === currentValue) ||
                             (currentValue === 'XRP' ? { name: 'XRP', hex: 'XRP', issuer: '' } :
                             (currentValue === 'Xoge' ? { name: 'Xoge', hex: '586F676500000000000000000000000000000000', issuer: 'rJMtvf5B3GbuFMrqybh5wYVXEH4QE8VyU1' } : null));
        display.textContent = selectedAsset ? selectedAsset.name : defaultValue;
        display.setAttribute('data-value', selectedAsset ? selectedAsset.name : defaultValue);
        display.setAttribute('data-hex', selectedAsset ? selectedAsset.hex || 'XRP' : 'XRP');
        display.setAttribute('data-issuer', selectedAsset ? selectedAsset.issuer || '' : '');
 
    });
}
function updateGuardianAssetPair() {
    const asset1Display = document.getElementById('guardian-asset1-display');
    const asset2Display = document.getElementById('guardian-asset2-display');
    const poolInfo = document.getElementById('guardian-pool-info');
    const errorElement = document.getElementById('guardian-error');

    if (!asset1Display || !asset2Display || !poolInfo || !errorElement) {
        logGuardian('Error: Guardian asset display elements not found.');
        return;
    }

    const asset1 = asset1Display.getAttribute('data-value');
    const asset2 = asset2Display.getAttribute('data-value');

    if (asset1 && asset2 && asset1 === asset2) {
        const availableAssets = ['XRP', ...prefabAssets.map(a => a.name)].filter(a => a !== asset1);
        const otherAsset = availableAssets.find(a => a !== 'XRP') || 'Xoge';
        asset2Display.textContent = otherAsset;
        asset2Display.setAttribute('data-value', otherAsset);
        asset2Display.setAttribute('data-hex', prefabAssets.find(a => a.name === otherAsset)?.hex || '586F676500000000000000000000000000000000');
        asset2Display.setAttribute('data-issuer', prefabAssets.find(a => a.name === otherAsset)?.issuer || 'rJMtvf5B3GbuFMrqybh5wYVXEH4QE8VyU1');
        logGuardian(`Adjusted Asset 2 to ${otherAsset} to avoid duplicate selection.`);
    }

    poolInfo.innerHTML = `
        <p>Current Price: -</p>
        <p>Starting Price: -</p>
    `;
    errorElement.textContent = '';
    guardianPoolState = {
        currentPrice: null,
        startingPrice: null,
        lastPriceCheckTimestamp: null,
        asset1: null,
        asset2: null,
        asset1Hex: null,
        asset2Hex: null,
        asset1Issuer: null,
        asset2Issuer: null
    };
    logGuardian(`Guardian asset pair updated: ${asset1 || '-'} / ${asset2 || '-'}`);
}

document.addEventListener('DOMContentLoaded', function() {
    const guardianSection = document.getElementById('guardian-tools');
    if (guardianSection) {
        const header = guardianSection.querySelector('h2, .section-header, .section-title, .header');
        if (header) {
            header.addEventListener('click', function() {
                if (!guardianSection.classList.contains('minimized')) {
                    setTimeout(() => {
                        initializeGuardianDropdowns();
                    }, 100);
                }
            });
        } else {
            logGuardian('Warning: No section header found in guardian-tools.');
        }

        const navLink = document.querySelector('a[href="#guardian-tools"]');
        if (navLink) {
            navLink.addEventListener('click', function() {
                setTimeout(() => {
                    initializeGuardianDropdowns();
                }, 100);
            });
        } else {
            logGuardian('Warning: No navigation link found for guardian-tools.');
        }

        
        if (!guardianSection.classList.contains('minimized')) {
            setTimeout(() => {
                initializeGuardianDropdowns();
            }, 500);
        }

        const priceSlider = document.getElementById('guardian-price-slider');
        const balanceSlider = document.getElementById('guardian-balance-slider');
        const slippageSlider = document.getElementById('guardian-slippage-slider');

        if (priceSlider) {
            priceSlider.addEventListener('input', updateGuardianPriceDisplay);
        } else {
            logGuardian('Error: guardian-price-slider not found.');
        }

        if (balanceSlider) {
            balanceSlider.addEventListener('input', updateGuardianBalanceDisplay);
        } else {
            logGuardian('Error: guardian-balance-slider not found.');
        }

        if (slippageSlider) {
            slippageSlider.addEventListener('input', updateGuardianSlippageDisplay);
        } else {
            logGuardian('Error: guardian-slippage-slider not found.');
        }
    } else {
        logGuardian('Error: Guardian section not found in DOM.');
    }
});