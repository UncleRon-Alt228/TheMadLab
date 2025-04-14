async function queueEscrowCreate() {
    try {
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-escrow');
        if (!contentCache || !displayTimer) {
            log('Error: No wallet loaded.');
            if (errorElement) errorElement.textContent = 'Please load a wallet.';
            return;
        }
        if (!address || !xrpl.isValidAddress(address)) {
            log('Error: Invalid wallet address.');
            if (errorElement) errorElement.textContent = 'Invalid wallet address.';
            return;
        }

        const amountInput = document.getElementById('escrow-amount').value.trim();
        const endTimeInput = document.getElementById('escrow-end-time').value.trim();
        const createButton = document.querySelector('#escrow-transactions .red-black-btn[onclick="queueEscrowCreate()"]');

        const escrowAmount = parseFloat(amountInput);
        if (!escrowAmount || escrowAmount <= 0 || isNaN(escrowAmount)) {
            log('Error: Invalid amount.');
            if (errorElement) errorElement.textContent = 'Enter a valid amount.';
            return;
        }

        const endTime = parseInt(endTimeInput);
        if (isNaN(endTime) || endTime < 30) {
            log('Error: Invalid End Time.');
            if (errorElement) errorElement.textContent = 'End Time must be at least 30 seconds.';
            return;
        }

        
        const confirmMessage = `Create self-escrow of ${escrowAmount} XRP with End Time in ${endTime} seconds? Funds will be locked until ${new Date(Date.now() + endTime * 1000).toLocaleString()}.`;
        if (!window.confirm(confirmMessage)) {
            log('Self-escrow creation canceled by user.');
            if (errorElement) errorElement.textContent = 'Creation canceled.';
            return;
        }

        
        if (createButton) createButton.disabled = true;

        await ensureConnected();

        const { availableBalanceXrp } = await calculateAvailableBalance(address);
        const transactionFeeDrops = TRANSACTION_FEE_DROPS;
        const transactionFeeXrp = parseFloat(xrpl.dropsToXrp(transactionFeeDrops));
        const escrowReserveXrp = 0.2;
        const totalRequiredXrp = escrowAmount + transactionFeeXrp;
        const adjustedAvailableXrp = availableBalanceXrp - escrowReserveXrp;

        if (totalRequiredXrp > adjustedAvailableXrp) {
            log(`Error: Insufficient balance. Need ${totalRequiredXrp.toFixed(6)} XRP, available ${adjustedAvailableXrp.toFixed(6)} XRP.`);
            if (errorElement) errorElement.textContent = `Need ${totalRequiredXrp.toFixed(6)} XRP, only ${adjustedAvailableXrp.toFixed(6)} XRP available.`;
            if (createButton) createButton.disabled = false;
            return;
        }

        const seed = await fetchRenderContent();
        const wallet = xrpl.Wallet.fromSeed(seed);
        if (wallet.classicAddress !== address) {
            log('Error: Wallet mismatch.');
            if (errorElement) errorElement.textContent = 'Wallet verification failed.';
            if (createButton) createButton.disabled = false;
            return;
        }

        const now = Math.floor(Date.now() / 1000);
        const rippleEpochOffset = 946684800;
        const tx = {
            TransactionType: "EscrowCreate",
            Account: address,
            Amount: xrpl.xrpToDrops(escrowAmount),
            Destination: address,
            FinishAfter: now - rippleEpochOffset + endTime - 1,
            CancelAfter: now - rippleEpochOffset + endTime
        };

        const description = `Created self-escrow: ${escrowAmount} XRP, End Time: ${new Date((tx.CancelAfter + rippleEpochOffset) * 1000).toISOString()}`;
        const txEntry = {
            tx: tx,
            wallet: wallet,
            description: description,
            delayMs: 0,
            type: "escrowcreate",
            queueElementId: "escrow-queue"
        };

        transactionQueue.push(txEntry);
        log(description);
        if (errorElement) errorElement.textContent = `Self-escrow created. Save the sequence number from the log.`;
        updateTransactionQueueDisplay();

        if (!isProcessingQueue) processTransactionQueue();
    } catch (error) {
        log(`Self-escrow create error: ${error.message}`);
        const errorElement = document.getElementById('address-error-escrow');
        const createButton = document.querySelector('#escrow-transactions .red-black-btn[onclick="queueEscrowCreate()"]');
        if (errorElement) errorElement.textContent = `Failed to create self-escrow: ${error.message}`;
        if (createButton) createButton.disabled = false;
    }
}

async function queueEscrowCancel() {
    try {
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-escrow');
        if (!contentCache || !displayTimer) {
            log('Error: No wallet loaded.');
            if (errorElement) errorElement.textContent = 'Please load a wallet.';
            return;
        }
        if (!address || !xrpl.isValidAddress(address)) {
            log('Error: Invalid wallet address.');
            if (errorElement) errorElement.textContent = 'Invalid wallet address.';
            return;
        }

        const sequence = parseInt(document.getElementById('escrow-cancel-sequence').value.trim());
        const cancelButton = document.querySelector('#escrow-transactions .red-black-btn[onclick="queueEscrowCancel()"]');

        if (isNaN(sequence) || sequence <= 0) {
            log('Error: Invalid sequence number.');
            if (errorElement) errorElement.textContent = 'Enter a valid sequence number.';
            return;
        }

        
        const confirmMessage = `Cancel self-escrow with sequence ${sequence}? This will release the escrowed funds to your wallet if the End Time has passed.`;
        if (!window.confirm(confirmMessage)) {
            log('Self-escrow cancellation canceled by user.');
            if (errorElement) errorElement.textContent = 'Cancellation canceled.';
            return;
        }

        
        if (cancelButton) cancelButton.disabled = true;

        await ensureConnected();

        const { availableBalanceXrp } = await calculateAvailableBalance(address);
        const transactionFeeDrops = TRANSACTION_FEE_DROPS;
        const transactionFeeXrp = parseFloat(xrpl.dropsToXrp(transactionFeeDrops));
        if (transactionFeeXrp > availableBalanceXrp) {
            log(`Error: Insufficient balance for fee. Need ${transactionFeeXrp.toFixed(6)} XRP, available ${availableBalanceXrp.toFixed(6)} XRP.`);
            if (errorElement) errorElement.textContent = `Need ${transactionFeeXrp.toFixed(6)} XRP for fee, only ${availableBalanceXrp.toFixed(6)} XRP available.`;
            if (cancelButton) cancelButton.disabled = false;
            return;
        }

        const seed = await fetchRenderContent();
        const wallet = xrpl.Wallet.fromSeed(seed);
        if (wallet.classicAddress !== address) {
            log('Error: Wallet mismatch.');
            if (errorElement) errorElement.textContent = 'Wallet verification failed.';
            if (cancelButton) cancelButton.disabled = false;
            return;
        }

        const tx = {
            TransactionType: "EscrowCancel",
            Account: address,
            Owner: address,
            OfferSequence: sequence
        };

        log(`Preparing to cancel self-escrow: Sequence ${sequence}`);
        const preparedTx = await client.autofill(tx);
        const currentLedgerResponse = await client.request({
            command: "ledger",
            ledger_index: "validated"
        });
        preparedTx.LastLedgerSequence = parseInt(currentLedgerResponse.result.ledger.ledger_index) + 100;

        const signedTx = wallet.sign(preparedTx);
        log(`Signed cancel transaction for sequence ${sequence}`);

        const description = `Canceled self-escrow: Sequence ${sequence}`;
        const txEntry = {
            tx: preparedTx,
            wallet: wallet,
            description: description,
            delayMs: 0,
            type: "escrowcancel",
            queueElementId: "escrow-queue",
            signedBlob: signedTx.tx_blob
        };

        transactionQueue.push(txEntry);
        log(description);
        if (errorElement) errorElement.textContent = 'Self-escrow cancellation queued.';
        updateTransactionQueueDisplay();

        if (!isProcessingQueue) processTransactionQueue();
    } catch (error) {
        log(`Self-escrow cancel error: ${error.message}`);
        const errorElement = document.getElementById('address-error-escrow');
        const cancelButton = document.querySelector('#escrow-transactions .red-black-btn[onclick="queueEscrowCancel()"]');
        if (error.message.includes('tecNO_PERMISSION')) {
            log('Error Details: End Time not yet reached.');
            if (errorElement) errorElement.textContent = 'Cannot cancel yet: End Time not reached.';
        } else if (error.message.includes('tecNO_LINE') || error.message.includes('tecOBJECT_NOT_FOUND')) {
            log('Error Details: Escrow not found.');
            if (errorElement) errorElement.textContent = 'Escrow not found. It may already be canceled.';
        } else {
            if (errorElement) errorElement.textContent = `Failed to cancel self-escrow: ${error.message}`;
        }
        if (cancelButton) cancelButton.disabled = false;
    }
}

async function fetchRecentEscrows() {
    try {
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-escrow');
        if (!contentCache || !displayTimer) {
            log('Error: No wallet loaded.');
            if (errorElement) errorElement.textContent = 'Please load a wallet.';
            return;
        }
        if (!address || !xrpl.isValidAddress(address)) {
            log('Error: Invalid wallet address.');
            if (errorElement) errorElement.textContent = 'Invalid wallet address.';
            return;
        }

        await ensureConnected();

        const escrowResponse = await client.request({
            command: "account_objects",
            account: address,
            type: "escrow",
            ledger_index: "validated"
        });
        const escrows = escrowResponse.result.account_objects.filter(obj => obj.Destination === address);
        if (escrows.length === 0) {
            log('No active self-escrows found.');
            if (errorElement) {
                errorElement.textContent = 'No active self-escrows found.';
                errorElement.className = 'error-message';
            }
            return;
        }

        const txResponse = await client.request({
            command: "account_tx",
            account: address,
            ledger_index_min: -1,
            ledger_index_max: -1,
            limit: 200
        });
        const escrowTxs = txResponse.result.transactions.filter(tx => 
            tx.tx && tx.tx.TransactionType === "EscrowCreate" && 
            tx.meta.TransactionResult === "tesSUCCESS" &&
            tx.tx.Destination === address
        );

        const now = Math.floor(Date.now() / 1000) - 946684800;
        log(`Found ${escrows.length} active self-escrows:`);
        const escrowList = escrows.map(obj => {
            const matchingTx = escrowTxs.reduce((best, tx) => {
                if (tx.tx.Destination !== obj.Destination || tx.tx.Amount !== obj.Amount) return best;
                const timeDiff = obj.CancelAfter ? Math.abs(tx.tx.CancelAfter - obj.CancelAfter) : Infinity;
                if (!best || timeDiff < best.timeDiff) {
                    return { tx, timeDiff };
                }
                return best;
            }, null)?.tx;
            const sequence = matchingTx ? matchingTx.tx.Sequence : 'unknown';
            const isLocked = obj.FinishAfter && now < obj.FinishAfter;
            const status = isLocked ? 'Locked' : 'Unlocked';
            const endDate = obj.CancelAfter ? new Date((obj.CancelAfter + 946684800) * 1000).toLocaleString() : 'N/A';
            const details = `Sequence: ${sequence}, Amount: ${xrpl.dropsToXrp(obj.Amount)} XRP, Status: ${status}, End Time: ${endDate}`;
            log(details);
            return { details, isLocked };
        });

        if (errorElement) {
            errorElement.innerHTML = escrowList.map(item => 
                `<span class="${item.isLocked ? 'locked' : 'unlocked'}">${item.details}</span>`
            ).join('<br>');
            errorElement.className = 'error-message';
        }
    } catch (error) {
        log(`Error fetching self-escrows: ${error.message}`);
        const errorElement = document.getElementById('address-error-escrow');
        if (errorElement) {
            errorElement.textContent = `Error fetching self-escrows: ${error.message}`;
            errorElement.className = 'error-message';
        }
    }
}