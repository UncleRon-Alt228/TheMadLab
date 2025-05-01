let pendingMintAction = null;
let mintingQueue = [];
let isProcessingMintingQueue = false;
let receiverWallet = null;

function updateMintingQueueDisplay() {
    const queueElement = document.getElementById('minting-queue');
    if (!queueElement) {
        log('Error: #minting-queue element not found in DOM.');
        return;
    }

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

function prepareMint(type) {
    const currencyInput = document.getElementById('mint-currency').value.trim();
    const amountInput = document.getElementById('mint-amount').value.trim();
    const errorElement = document.getElementById('address-error-minting');

    if (!currencyInput) {
        log('Error: Currency code is required.');
        if (errorElement) errorElement.textContent = 'Enter a currency code.';
        return;
    }

    const mintAmount = parseInt(amountInput);
    if (isNaN(mintAmount) || mintAmount <= 0 || mintAmount > 999999999999999) {
        log('Error: Invalid amount. Must be between 1 and 999,999,999,999,999.');
        if (errorElement) errorElement.textContent = 'Invalid amount.';
        return;
    }

    const confirmMessage = document.getElementById('mint-confirm-message');
    const confirmSection = document.getElementById('mint-confirmation');
    const mintButtons = document.querySelectorAll('.minting-buttons .red-black-btn');

    let warning = '';
    if (type === 'clawback') {
        warning = 'This will enable Clawback, allowing token recovery from trustlines.';
    }

    confirmMessage.textContent = `Minting ${mintAmount.toLocaleString()} ${currencyInput.toUpperCase()}${warning ? ' - ' + warning : ''}`;
    confirmSection.style.display = 'block';

    mintButtons.forEach(btn => btn.disabled = true);

    const confirmButton = document.getElementById('confirmMint');
    confirmButton.onclick = async () => {
        confirmSection.style.display = 'none';
        mintButtons.forEach(btn => btn.disabled = false);

        if (type === 'standard') {
            await queueMintToken();
        } else if (type === 'clawback') {
            await queueMintWithClawback();
        }
    };
}

function cancelMint() {
    const confirmSection = document.getElementById('mint-confirmation');
    const mintButtons = document.querySelectorAll('.minting-buttons .red-black-btn');
    
    confirmSection.style.display = 'none';
    mintButtons.forEach(btn => btn.disabled = false);
    log('Minting Cancelled by User');
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
        const mintButton = document.querySelector('#minting .red-black-btn[onclick="prepareMint(\'standard\')"]');

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
        const { availableBalanceXrp } = await calculateAvailableBalance(address);
        const fundingAmount = 10;
        const transactionFeeXrp = parseFloat(xrpl.dropsToXrp("12"));
        const totalRequiredXrp = fundingAmount + (3 * transactionFeeXrp); 

        if (totalRequiredXrp > availableBalanceXrp) {
            log(`Error: Insufficient balance. Need ${totalRequiredXrp.toFixed(6)} XRP, available ${availableBalanceXrp.toFixed(6)} XRP.`);
            if (errorElement) errorElement.textContent = `Need ${totalRequiredXrp.toFixed(6)} XRP, only ${availableBalanceXrp.toFixed(6)} XRP available.`;
            return;
        }

        if (mintButton) mintButton.disabled = true;

        receiverWallet = xrpl.Wallet.generate();
        const receiverAddress = receiverWallet.classicAddress;
        const receiverSeed = receiverWallet.seed;
        log(`New Receiver Account Created: ${receiverAddress} (Save seed via QR code or download)`);

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
            description: `Waiting 45 seconds for receiver account activation`,
            delayMs: 45000,
            execute: async () => {
                log('Step 2 Completed: Receiver Account Activation Wait Finished');
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
                    value: "9000000000000000"
                },
                Fee: "12",
                Flags: xrpl.TrustSetFlags.tfSetNoRipple
            },
            wallet: receiverWallet,
            description: `Set trustline for ${currencyCode} from receiver to issuer`,
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

        log(`Minting Started: 4 Steps Queued for ${mintAmount} ${currencyCode}`);
        updateMintingQueueDisplay();
        await processMintingQueue();
    } catch (error) {
        log(`Error: Failed to Create Receiver Account: ${error.message}. Save any generated seed via QR code or download.`);
        if (receiverWallet) {
            log(`New Receiver Account Created: ${receiverWallet.classicAddress} (Save seed via QR code or download)`);
        }
        const errorElement = document.getElementById('address-error-minting');
        const mintButton = document.querySelector('#minting .red-black-btn[onclick="prepareMint(\'standard\')"]');
        if (errorElement) errorElement.textContent = `Failed to mint token: ${error.message}`;
        if (mintButton) mintButton.disabled = false;
    }
}

async function queueMintWithClawback() {
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
        const mintButton = document.querySelector('#minting .red-black-btn[onclick="prepareMint(\'clawback\')"]');

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
        const { availableBalanceXrp } = await calculateAvailableBalance(address);
        const fundingAmount = 10;
        const transactionFeeXrp = parseFloat(xrpl.dropsToXrp("12"));
        const totalRequiredXrp = fundingAmount + (4 * transactionFeeXrp);

        if (totalRequiredXrp > availableBalanceXrp) {
            log(`Error: Insufficient balance. Need ${totalRequiredXrp.toFixed(6)} XRP, available ${availableBalanceXrp.toFixed(6)} XRP.`);
            if (errorElement) errorElement.textContent = `Need ${totalRequiredXrp.toFixed(6)} XRP, only ${availableBalanceXrp.toFixed(6)} XRP available.`;
            return;
        }

        if (mintButton) mintButton.disabled = true;

        receiverWallet = xrpl.Wallet.generate();
        const receiverAddress = receiverWallet.classicAddress;
        const receiverSeed = receiverWallet.seed;
        log(`New Receiver Account Created: ${receiverAddress} (Save seed via QR code or download)`);

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

        const flags = accountInfo.result.account_data.Flags || 0;
        if (!(flags & LSF_CLAWBACK)) {
            mintingQueue.push({
                type: "admin",
                tx: {
                    TransactionType: "AccountSet",
                    Account: address,
                    SetFlag: ASF_ALLOW_TRUSTLINE_CLAWBACK,
                    Fee: "12"
                },
                wallet: issuerWallet,
                description: `Enable Clawback for issuer ${address}`,
                delayMs: 0
            });
        }

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
            description: `Waiting 45 seconds for receiver account activation`,
            delayMs: 45000,
            execute: async () => {
                log('Step 3 Completed: Receiver Account Activation Wait Finished');
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
                    value: "9000000000000000"
                },
                Fee: "12",
                Flags: xrpl.TrustSetFlags.tfSetNoRipple
            },
            wallet: receiverWallet,
            description: `Set trustline for ${currencyCode} from receiver to issuer`,
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

        log(`Minting with Clawback Started: 5 Steps Queued for ${mintAmount} ${currencyCode}`);
        updateMintingQueueDisplay();
        await processMintingQueue();
    } catch (error) {
        log(`Error: Failed to Create Receiver Account: ${error.message}. Save any generated seed via QR code or download.`);
        if (receiverWallet) {
            log(`New Receiver Account Created: ${receiverWallet.classicAddress} (Save seed via QR code or download)`);
        }
        const errorElement = document.getElementById('address-error-minting');
        const mintButton = document.querySelector('#minting .red-black-btn[onclick="prepareMint(\'clawback\')"]');
        if (errorElement) errorElement.textContent = `Failed to mint token: ${error.message}`;
        if (mintButton) mintButton.disabled = false;
    }
}

async function processMintingQueue() {
    if (mintingQueue.length === 0) {
        isProcessingMintingQueue = false;
        log('Minting Completed Successfully! Minted to Receiver Account');
        updateMintingQueueDisplay();
        const mintButtons = document.querySelectorAll('#minting .red-black-btn');
        mintButtons.forEach(btn => btn.disabled = false);
        return;
    }

    if (isProcessingMintingQueue) {
        log('Minting queue is already processing. Waiting...');
        return;
    }
    isProcessingMintingQueue = true;

    const queueTimeout = setTimeout(() => {
        log('Minting Failed: Queue Timed Out After 5 Minutes. Save receiver seed via QR code or download.');
        mintingQueue = [];
        isProcessingMintingQueue = false;
        updateMintingQueueDisplay();
        const mintButtons = document.querySelectorAll('#minting .red-black-btn');
        mintButtons.forEach(btn => btn.disabled = false);
        receiverWallet = null;
    }, 300000);

    try {
        const txEntry = mintingQueue[0];
        const { description, delayMs, type, execute } = txEntry;

        if (delayMs > 0) {
            log(`Step ${type === "wait" ? 2 : type === "trustline" ? (mintingQueue.length === 4 ? 3 : 4) : (mintingQueue.length === 4 ? 4 : 5)}: Waiting ${delayMs / 1000} seconds for ${description}`);
        }

        await ensureConnected();

        if (type === "payment" || type === "trustline" || type === "admin") {
            const { tx, wallet } = txEntry;
            const prepared = await client.autofill(tx);
            const ledgerInfo = await client.request({ command: "ledger_current" });
            prepared.LastLedgerSequence = ledgerInfo.result.ledger_current_index + 100;
            const signed = wallet.sign(prepared);
            log(`Step ${type === "payment" && description.includes("Fund") ? 1 : type === "trustline" ? (mintingQueue.length === 4 ? 3 : 4) : type === "admin" ? 3 : (mintingQueue.length === 4 ? 4 : 5)}: ${description}`);
            log(`Transaction Blob: ${signed.tx_blob}`, true);

            let result;
            try {
                result = await client.submitAndWait(signed.tx_blob, { timeout: 45000 });
            } catch (submitError) {
                log(`Step ${type === "payment" && description.includes("Fund") ? 1 : type === "trustline" ? (mintingQueue.length === 4 ? 3 : 4) : type === "admin" ? 3 : (mintingQueue.length === 4 ? 4 : 5)} Failed: ${description}: ${submitError.message}. Save receiver seed via QR code or download.`);
                throw new Error(`Submission failed: ${submitError.message}`);
            }

            if (result.result.meta.TransactionResult === "tesSUCCESS") {
                log(`Step ${type === "payment" && description.includes("Fund") ? 1 : type === "trustline" ? (mintingQueue.length === 4 ? 3 : 4) : type === "admin" ? 3 : (mintingQueue.length === 4 ? 4 : 5)} Completed: ${description}. Transaction Hash: ${result.result.hash}`);
            } else {
                log(`Step ${type === "payment" && description.includes("Fund") ? 1 : type === "trustline" ? (mintingQueue.length === 4 ? 3 : 4) : type === "admin" ? 3 : (mintingQueue.length === 4 ? 4 : 5)} Failed: ${description}: ${result.result.meta.TransactionResult}. Save receiver seed via QR code or download.`);
                throw new Error(`${type.charAt(0).toUpperCase() + type.slice(1)} transaction failed: ${result.result.meta.TransactionResult}`);
            }
        } else if (type === "wait") {
            try {
                await Promise.race([
                    execute(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Wait step timed out')), 60000))
                ]);
            } catch (waitError) {
                log(`Step 2 Failed: Wait for Activation: ${waitError.message}`);
                throw waitError;
            }
        }

        mintingQueue.shift();
        updateMintingQueueDisplay();
    } catch (error) {
        log(`Minting Failed: ${error.message}. Save receiver seed via QR code or download.`);
        if (receiverWallet) {
            log(`New Receiver Account Created: ${receiverWallet.classicAddress} (Save seed via QR code or download)`);
        }
        mintingQueue.shift();
        updateMintingQueueDisplay();
    } finally {
        clearTimeout(queueTimeout);
        if (mintingQueue.length > 0) {
            log('Waiting 15 seconds before next minting step...');
            await new Promise(resolve => setTimeout(resolve, 15000));
            isProcessingMintingQueue = false;
            await processMintingQueue();
        } else {
            isProcessingMintingQueue = false;
            log(`Minting Completed Successfully! ${mintingQueue[0]?.description.match(/Mint (\d+) (\w+)/)?.[1] || ''} ${mintingQueue[0]?.description.match(/Mint \d+ (\w+)/)?.[1] || ''} Minted to ${mintingQueue[0]?.tx?.Destination || ''}`);
            const mintButtons = document.querySelectorAll('#minting .red-black-btn');
            mintButtons.forEach(btn => btn.disabled = false);
            receiverWallet = null;
        }
    }
}