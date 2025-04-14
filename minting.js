let receiverWallet = null;
let mintingQueue = [];
let isProcessingMintingQueue = false;

function showMintConfirmationModal(currencyCode, mintAmount) {
    return new Promise((resolve) => {
        const modal = document.getElementById('mintConfirmationModal');
        const confirmCurrency = document.getElementById('confirm-currency');
        const confirmAmount = document.getElementById('confirm-amount');
        const confirmButton = document.getElementById('confirmMint');
        const cancelButton = document.getElementById('cancelMint');

        confirmCurrency.textContent = currencyCode;
        confirmAmount.textContent = mintAmount.toLocaleString();
        modal.style.display = 'flex';

        const resolveAndCleanup = (result) => {
            modal.style.display = 'none';
            resolve(result);
        };

        confirmButton.onclick = () => resolveAndCleanup(true);
        cancelButton.onclick = () => resolveAndCleanup(false);
    });
}

function updateMintingQueueDisplay() {
    const queueElement = document.getElementById('minting-queue');
    if (!queueElement) return;

    queueElement.innerHTML = '<p>Transaction Queue:</p>';
    if (mintingQueue.length === 0) {
        queueElement.innerHTML += '<p>No transactions in queue.</p>';
    } else {
        let cumulativeDelayMs = 0;
        mintingQueue.forEach((item, index) => {
            cumulativeDelayMs += item.delayMs || 0;
            if (index > 0) cumulativeDelayMs += 15000;
            const delayText = cumulativeDelayMs > 0 ? ` (Scheduled in ${(cumulativeDelayMs / 60000).toFixed(2)} minutes)` : '';
            queueElement.innerHTML += `<p>${index + 1}. ${item.description}${delayText}</p>`;
        });
    }
}

async function processMintingQueue() {
    if (mintingQueue.length === 0) {
        isProcessingMintingQueue = false;
        log('Minting queue is empty. Processing stopped.');
        updateMintingQueueDisplay();
        const mintButton = document.querySelector('#minting .red-black-btn[onclick="queueMintToken()"]');
        if (mintButton) mintButton.disabled = false;
        return;
    }

    if (isProcessingMintingQueue) {
        log('Minting queue is already processing. Waiting...');
        return;
    }
    isProcessingMintingQueue = true;

    const txEntry = mintingQueue[0];
    const { description, delayMs, type, execute } = txEntry;

    try {
        if (delayMs > 0) {
            log(`Waiting ${delayMs / 1000} seconds before: ${description}`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        await ensureConnected();

        if (type === "payment") {
            const { tx, wallet } = txEntry;
            const prepared = await client.autofill(tx);
            const ledgerInfo = await client.request({ command: "ledger_current" });
            prepared.LastLedgerSequence = ledgerInfo.result.ledger_current_index + 100;
            const signed = wallet.sign(prepared);
            log(`Submitting payment: ${description}`);
            const result = await client.submitAndWait(signed.tx_blob);
            if (result.result.meta.TransactionResult === "tesSUCCESS") {
                log(`Payment succeeded: ${description}`);
                log(`Transaction Hash: ${result.result.hash}`);
            } else {
                throw new Error(`Payment failed: ${result.result.meta.TransactionResult}`);
            }
        } else if (type === "trustline") {
            const { tx, wallet } = txEntry;
            tx.Flags = xrpl.TrustSetFlags.tfSetNoRipple;
            const prepared = await client.autofill(tx);
            const ledgerInfo = await client.request({ command: "ledger_current" });
            prepared.LastLedgerSequence = ledgerInfo.result.ledger_current_index + 100;
            const signed = wallet.sign(prepared);
            log(`Submitting trustline: ${description}`);
            const result = await client.submitAndWait(signed.tx_blob);
            if (result.result.meta.TransactionResult === "tesSUCCESS") {
                log(`Trustline succeeded: ${description}`);
            } else {
                throw new Error(`Trustline failed: ${result.result.meta.TransactionResult}`);
            }
        } else if (type === "wait") {
            try {
                log('Starting wait step...');
                await Promise.race([
                    execute(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Wait step timed out')), 60000))
                ]);
                log('Wait step completed successfully.');
            } catch (waitError) {
                log(`Error in wait step: ${waitError.message}`);
                throw waitError;
            }
        }

        mintingQueue.shift();
        log(`Transaction removed from queue. Remaining: ${mintingQueue.length}`);
        updateMintingQueueDisplay();
    } catch (error) {
        log(`Minting queue error: ${error.message}`);
        mintingQueue.shift();
        log(`Transaction failed and removed from queue. Remaining: ${mintingQueue.length}`);
        updateMintingQueueDisplay();
    } finally {
        if (mintingQueue.length > 0) {
            log('Waiting 15 seconds before next minting transaction...');
            await new Promise(resolve => setTimeout(resolve, 15000));
            isProcessingMintingQueue = false;
            await processMintingQueue();
        } else {
            isProcessingMintingQueue = false;
            log('Minting queue processing completed.');
            const mintButton = document.querySelector('#minting .red-black-btn[onclick="queueMintToken()"]');
            if (mintButton) mintButton.disabled = false;
        }
    }
}

async function queueMintToken() {
    try {
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-minting');
        if (!contentCache || !displayTimer || !address || !xrpl.isValidAddress(address)) {
            log('Error: No valid wallet loaded.');
            if (errorElement) errorElement.textContent = 'Please load a valid wallet.';
            return;
        }

        const currencyInput = document.getElementById('mint-currency').value.trim();
        const amountInput = document.getElementById('mint-amount').value.trim();
        const mintButton = document.querySelector('#minting .red-black-btn[onclick="queueMintToken()"]');

        
        if (!currencyInput) {
            log('Error: Currency code is required.');
            if (errorElement) errorElement.textContent = 'Enter a currency code.';
            return;
        }
        const currencyCode = currencyInput.toUpperCase();
        const currencyHex = currencyCode.length <= 3 ? currencyCode : xrpl.convertStringToHex(currencyCode).padEnd(40, '0');

        
        const mintAmount = parseInt(amountInput);
        if (isNaN(mintAmount) || mintAmount <= 0 || mintAmount > 999999999999999) {
            log('Error: Invalid amount. Must be between 1 and 999,999,999,999,999.');
            if (errorElement) errorElement.textContent = 'Invalid amount.';
            return;
        }

        
        await ensureConnected();
        const accountInfo = await client.request({
            command: "account_info",
            account: address,
            ledger_index: "current"
        });
        const accountLines = await client.request({
            command: "account_lines",
            account: address,
            ledger_index: "current"
        });
        const serverInfo = await client.request({ command: "server_info" });
        const reserveBaseXrp = parseFloat(serverInfo.result.info.validated_ledger.reserve_base_xrp);
        const reserveIncXrp = parseFloat(serverInfo.result.info.validated_ledger.reserve_inc_xrp);
        const totalBalanceXrp = parseFloat(xrpl.dropsToXrp(accountInfo.result.account_data.Balance));
        const trustlines = accountLines.result.lines.length;
        const totalReserveXrp = reserveBaseXrp + (trustlines * reserveIncXrp);
        const availableBalanceXrp = totalBalanceXrp - totalReserveXrp;
        const fundingAmount = 10;
        const transactionFeeXrp = parseFloat(xrpl.dropsToXrp("12"));
        const totalRequiredXrp = fundingAmount + (3 * transactionFeeXrp);
        if (totalRequiredXrp > availableBalanceXrp) {
            log(`Error: Insufficient balance. Need ${totalRequiredXrp.toFixed(6)} XRP, available ${availableBalanceXrp.toFixed(6)} XRP.`);
            if (errorElement) errorElement.textContent = `Need ${totalRequiredXrp.toFixed(6)} XRP, only ${availableBalanceXrp.toFixed(6)} XRP available.`;
            return;
        }

        
        const confirmed = await showMintConfirmationModal(currencyCode, mintAmount);
        if (!confirmed) {
            log('Minting process canceled by user.');
            if (errorElement) errorElement.textContent = 'Minting canceled.';
            if (mintButton) mintButton.disabled = false;
            return;
        }

        
        if (mintButton) mintButton.disabled = true;

        
        receiverWallet = xrpl.Wallet.generate();
        const receiverAddress = receiverWallet.classicAddress;
        const receiverSeed = receiverWallet.seed;
        log(`Receiver account created: ${receiverAddress}`);

        
        const warningPanel = document.getElementById('minting-receiver-warning');
        if (warningPanel) {
            warningPanel.innerHTML = `
                <h3>⚠️ Receiver Account Created ⚠️</h3>
                <p style="color: #ff4444; font-weight: bold;">
                    Save the receiver account's seed and address securely! This is the ONLY time you will see the seed unencrypted.
                    If you lose it, you will lose access to the minted tokens.
                </p>
                <p>Address: <a href="https://xrpscan.com/account/${receiverAddress}" class="address-link" target="_blank">${receiverAddress}</a></p>
                <p>Click below to view QR codes:</p>
                <div class="qr-buttons">
                    <button class="green-btn" onclick="showQRCode('address', '${receiverAddress}')">Show Address QR Code</button>
                    <button class="red-black-btn" onclick="showQRCode('seed', '${receiverSeed}')">Show Seed QR Code</button>
                </div>
                <p>Download the receiver account data:</p>
                <button class="red-black-btn" onclick="downloadUnencryptedWallet('${receiverSeed}', '${receiverAddress}')">Download Unencrypted Wallet</button>
                <button class="red-black-btn" onclick="g7('${receiverSeed}', '${receiverAddress}')">Download Encrypted Wallet</button>
                <p>You can load this account in another browser tab to manage it separately.</p>
            `;
            warningPanel.style.display = 'block';
        }

        
        const issuerSeed = await fetchRenderContent();
        const issuerWallet = xrpl.Wallet.fromSeed(issuerSeed);
        if (issuerWallet.classicAddress !== address) {
            log('Error: Issuer wallet mismatch.');
            if (errorElement) errorElement.textContent = 'Issuer wallet verification failed.';
            if (mintButton) mintButton.disabled = false;
            return;
        }

        
        mintingQueue = [];

        
        mintingQueue.push({
            type: "payment",
            tx: {
                TransactionType: "Payment",
                Account: address,
                Destination: receiverAddress,
                Amount: xrpl.xrpToDrops(fundingAmount),
                Fee: "12"
            },
            wallet: issuerWallet,
            description: `Fund receiver account ${receiverAddress} with ${fundingAmount} XRP`,
            delayMs: 0
        });

        
        mintingQueue.push({
            type: "wait",
            description: `Waiting 30 seconds for receiver account activation`,
            delayMs: 30000,
            execute: async () => {
                log('Receiver account activation wait complete.');
            }
        });

        
        mintingQueue.push({
            type: "trustline",
            tx: {
                TransactionType: "TrustSet",
                Account: receiverAddress,
                LimitAmount: {
                    currency: currencyHex,
                    issuer: address,
                    value: mintAmount.toString()
                },
                Fee: "12"
            },
            wallet: receiverWallet,
            description: `Set trustline for ${currencyCode} (Limit: ${mintAmount}) from receiver to issuer`,
            delayMs: 0
        });

        
        mintingQueue.push({
            type: "payment",
            tx: {
                TransactionType: "Payment",
                Account: address,
                Destination: receiverAddress,
                Amount: {
                    currency: currencyHex,
                    issuer: address,
                    value: mintAmount.toString()
                },
                Fee: "12"
            },
            wallet: issuerWallet,
            description: `Mint ${mintAmount} ${currencyCode} to receiver account`,
            delayMs: 0
        });

        log(`Minting process started: ${mintingQueue.length} transactions queued.`);
        updateMintingQueueDisplay();
        await processMintingQueue();
    } catch (error) {
        log(`Mint token error: ${error.message}`);
        const errorElement = document.getElementById('address-error-minting');
        const mintButton = document.querySelector('#minting .red-black-btn[onclick="queueMintToken()"]');
        if (errorElement) errorElement.textContent = `Failed to mint token: ${error.message}`;
        if (mintButton) mintButton.disabled = false;
    }
}