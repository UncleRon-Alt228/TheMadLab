let isCheckingIssuer = false;

const FLAG_MAP = {
  3: { asf: "DisallowXRP", lsf: "lsfDisallowXRP", value: 0x00080000, verified: true, notes: "3" },
  6: { asf: "NoFreeze", lsf: "lsfNoFreeze", value: 0x00200000, verified: false, notes: "6" },
  7: { asf: "GlobalFreeze", lsf: "lsfGlobalFreeze", value: 0x00040000, verified: false, notes: "7" },
  8: { asf: "DefaultRipple", lsf: "lsfDefaultRipple", value: 0x00800000, verified: false, notes: "8" },
  16: { asf: "AllowTrustlineClawback", lsf: "lsfClawback", value: 0x80000000, verified: true, notes: "16" }
};

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

function stringToHex(str) {
  return Array.from(str)
    .map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function hexToDomain(hex) {
  try {
    return hex
      .match(/.{1,2}/g)
      .map(h => String.fromCharCode(parseInt(h, 16)))
      .join('');
  } catch (e) {
    log("Failed to Convert Hex to Domain");
    return "Invalid Domain";
  }
}

function validateAndConvertCurrency(currency) {
  if (!currency) return null;
  const trimmed = currency.trim();
  if (trimmed.length === 40 && /^[0-9A-Fa-f]{40}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  const upperCode = trimmed.toUpperCase();
  if (upperCode.length <= 3) {
    return upperCode;
  }
  const hexCode = xrpl.convertStringToHex(upperCode).padEnd(40, '0');
  return hexCode;
}

function showAdminConfirmationModal(action, details) {
  return new Promise(resolve => {
    const modal = document.getElementById('adminConfirmationModal');
    const content = document.getElementById('admin-confirm-content');
    const confirmCheckbox = document.getElementById('admin-confirm-checkbox');
    const confirmButton = document.getElementById('admin-confirm-btn');
    const cancelButton = document.getElementById('admin-cancel-btn');

    if (!modal || !content || !confirmCheckbox || !confirmButton || !cancelButton) {
      log(`Failed to ${action}: Modal elements missing.`);
      resolve(false);
      return;
    }

    let message;
    if (["Freeze Trustline", "Unfreeze Trustline", "Enable Rippling", "Disable Rippling", "Enable XRP Payments", "Disable XRP Payments"].includes(action)) {
      message = `Do you want to ${action.toLowerCase()}? ${details} This action can be reversed later.`;
    } else if (["Blackhole Account", "Set NoFreeze", "Enable Clawback"].includes(action)) {
      message = `⚠️ WARNING: This will permanently ${action.toLowerCase()}! ${details} This action cannot be undone.`;
    } else {
      message = `Are you sure you want to ${action.toLowerCase()}? ${details}`;
    }

    content.textContent = message;
    confirmCheckbox.checked = false;
    confirmButton.disabled = true;
    modal.style.display = 'flex';

    const confirmButtonClone = confirmButton.cloneNode(true);
    const cancelButtonClone = cancelButton.cloneNode(true);
    confirmButton.parentNode.replaceChild(confirmButtonClone, confirmButton);
    cancelButton.parentNode.replaceChild(cancelButtonClone, cancelButton);
    const newConfirmButton = confirmButtonClone;
    const newCancelButton = cancelButtonClone;

    const resolveAndCleanup = result => {
      log(`${action} ${result ? 'Confirmed' : 'Cancelled'}`);
      modal.style.display = 'none';
      confirmCheckbox.checked = false;
      newConfirmButton.disabled = true;
      resolve(result);
    };

    confirmCheckbox.onclick = () => {
      newConfirmButton.disabled = !confirmCheckbox.checked;
    };

    newConfirmButton.onclick = () => resolveAndCleanup(true);
    newCancelButton.onclick = () => resolveAndCleanup(false);
  });
}

function queueAdminTransaction(options) {
  const { action, description, tx, confirmDetails = description, validateInputs = () => Promise.resolve(true) } = options;

  const address = globalAddress;
  const errorElement = document.getElementById('address-error-admin');

  if (!contentCache || !displayTimer) {
    log(`Failed to ${action}: No wallet loaded.`);
    errorElement.textContent = 'No wallet loaded.';
    return;
  }
  if (!xrpl.isValidAddress(address)) {
    log(`Failed to ${action}: Invalid wallet address.`);
    errorElement.textContent = 'Invalid address.';
    return;
  }

  const preEther = spawnEtherNoise(4);
  window.etherPreFlux = preEther;

  validateInputs(tx).then(isValid => {
    if (!isValid) {
      log(`Failed to ${action}: Invalid input fields.`);
      return;
    }

    ensureConnected()
      .then(() => {
        calculateAvailableBalance(address)
          .then(balanceInfo => {
            const availableBalanceXrp = balanceInfo.availableBalanceXrp;
            const feeXrp = xrpl.dropsToXrp(TRANSACTION_FEE_DROPS);
            if (feeXrp > availableBalanceXrp) {
              log(`Failed to ${action}: Insufficient XRP (Need ${feeXrp.toFixed(6)}, Have ${formatBalance(availableBalanceXrp)}).`);
              errorElement.textContent = `Need ${feeXrp.toFixed(6)} XRP, have ${formatBalance(availableBalanceXrp)}.`;
              return;
            }

            fetchRenderContent()
              .then(seed => {
                const wallet = xrpl.Wallet.fromSeed(seed);
                if (wallet.classicAddress !== address) {
                  log(`Failed to ${action}: Wallet seed mismatch.`);
                  errorElement.textContent = 'Seed mismatch.';
                  return;
                }

                showAdminConfirmationModal(action, confirmDetails).then(confirmed => {
                  if (!confirmed) {
                    log(`${action} Cancelled`);
                    return;
                  }

                  const txEntry = {
                    tx,
                    wallet,
                    description,
                    delayMs: 0,
                    type: "admin",
                    queueElementId: "admin-queue"
                  };

                  transactionQueue.push(txEntry);
                  log(`Starting ${action}: ${description}`);
                  updateTransactionQueueDisplay();

                  if (!isProcessingQueue) {
                    processTransactionQueue();
                  }
                });
              })
              .catch(error => {
                log(`Failed to ${action}: ${error.message}`);
                errorElement.textContent = `Error: ${error.message}`;
              });
          })
          .catch(error => {
            log(`Failed to ${action}: ${error.message}`);
            errorElement.textContent = `Balance check error: ${error.message}`;
          });
      })
      .catch(error => {
        log(`Failed to ${action}: ${error.message}`);
        errorElement.textContent = `Connection error: ${error.message}`;
      });
  });
}

function queueMintAdditionalTokens() {
  const currencyInput = document.getElementById('admin-mint-currency')?.value.trim() || "";
  const amountInput = document.getElementById('admin-mint-amount')?.value.trim() || "";
  const targetAddress = document.getElementById('admin-mint-target')?.value.trim() || "";
  const errorElement = document.getElementById('address-error-admin');

  const tx = {
    TransactionType: "Payment",
    Account: globalAddress,
    Destination: targetAddress,
    Amount: {
      currency: null,
      issuer: globalAddress,
      value: null
    },
    Fee: TRANSACTION_FEE_DROPS
  };

  queueAdminTransaction({
    action: "Mint Additional Tokens",
    description: `Mint ${amountInput} ${currencyInput} to ${targetAddress}`,
    tx,
    validateInputs: () => {
      return new Promise(async resolve => {
        if (!currencyInput || !amountInput || !targetAddress) {
          log("Failed to Mint Tokens: Missing currency, amount, or target address.");
          errorElement.textContent = 'All fields required.';
          resolve(false);
          return;
        }

        const amount = parseFloat(amountInput);
        if (isNaN(amount) || amount <= 0 || amount > 999999999999999) {
          log("Failed to Mint Tokens: Invalid amount (Must be 0 to 999,999,999,999,999).");
          errorElement.textContent = 'Invalid amount.';
          resolve(false);
          return;
        }

        if (!xrpl.isValidAddress(targetAddress)) {
          log("Failed to Mint Tokens: Invalid target address.");
          errorElement.textContent = 'Invalid target address.';
          resolve(false);
          return;
        }

        const currencyHex = validateAndConvertCurrency(currencyInput);
        if (!currencyHex) {
          log("Failed to Mint Tokens: Invalid currency code.");
          errorElement.textContent = 'Invalid currency code.';
          resolve(false);
          return;
        }

        try {
          await ensureConnected();
          
          const accountInfo = await client.request({
            command: "account_info",
            account: globalAddress,
            ledger_index: "current"
          });
          const flags = accountInfo.result.account_data.Flags || 0;
          if (flags & LSF_REQUIRE_AUTH) {
            log("Failed to Mint Tokens: Issuer requires trustline authorization.");
            errorElement.textContent = 'Issuer requires trustline authorization.';
            resolve(false);
            return;
          }

          const accountLines = await client.request({
            command: "account_lines",
            account: targetAddress,
            ledger_index: "current"
          });
          const trustline = accountLines.result.lines.find(
            line => line.currency === currencyHex && line.account === globalAddress
          );
          if (!trustline) {
            log(`Failed to Mint Tokens: Destination lacks trustline for ${currencyInput}.`);
            errorElement.textContent = 'Destination needs a trustline for this currency.';
            resolve(false);
            return;
          }

          tx.Amount.currency = currencyHex;
          tx.Amount.value = amount.toString();
          resolve(true);
        } catch (error) {
          log(`Failed to Mint Tokens: ${error.message}`);
          errorElement.textContent = `Validation error: ${error.message}`;
          resolve(false);
        }
      });
    },
    confirmDetails: `Mint ${amountInput} ${currencyInput} to ${targetAddress}. Ensure the destination has a trustline.`
  });
}

function queueEnableRippling() {
  const currencyInput = document.getElementById('admin-ripple-currency')?.value.trim() || "";
  const targetAddress = document.getElementById('admin-ripple-target')?.value.trim() || "";
  const errorElement = document.getElementById('address-error-admin');

  const tx = {
    TransactionType: "TrustSet",
    Account: globalAddress,
    LimitAmount: { currency: null, issuer: targetAddress, value: "9000000000000000" },
    Fee: TRANSACTION_FEE_DROPS,
    Flags: TF_CLEAR_NO_RIPPLE
  };

  if (!currencyInput || !targetAddress) {
    log("Failed to Enable Rippling: Missing currency or target address.");
    errorElement.textContent = 'All fields required.';
    return;
  }

  const currencyHex = validateAndConvertCurrency(currencyInput);
  if (!currencyHex) {
    log("Failed to Enable Rippling: Invalid currency code.");
    errorElement.textContent = 'Invalid currency code.';
    return;
  }

  if (!xrpl.isValidAddress(targetAddress)) {
    log("Failed to Enable Rippling: Invalid target address.");
    errorElement.textContent = 'Invalid target address.';
    return;
  }

  tx.LimitAmount.currency = currencyHex;

  queueAdminTransaction({
    action: "Enable Rippling",
    description: `Enable rippling for ${currencyInput} with ${targetAddress}`,
    tx,
    confirmDetails: `Enable rippling for the trustline of ${currencyInput} with ${targetAddress}, allowing token flow through accounts.`
  });
}

function queueDisableRippling() {
  const currencyInput = document.getElementById('admin-ripple-currency')?.value.trim() || "";
  const targetAddress = document.getElementById('admin-ripple-target')?.value.trim() || "";
  const errorElement = document.getElementById('address-error-admin');

  const tx = {
    TransactionType: "TrustSet",
    Account: globalAddress,
    LimitAmount: { currency: null, issuer: targetAddress, value: "9000000000000000" },
    Fee: TRANSACTION_FEE_DROPS,
    Flags: TF_SET_NO_RIPPLE
  };

  if (!currencyInput || !targetAddress) {
    log("Failed to Disable Rippling: Missing currency or target address.");
    errorElement.textContent = 'All fields required.';
    return;
  }

  const currencyHex = validateAndConvertCurrency(currencyInput);
  if (!currencyHex) {
    log("Failed to Disable Rippling: Invalid currency code.");
    errorElement.textContent = 'Invalid currency code.';
    return;
  }

  if (!xrpl.isValidAddress(targetAddress)) {
    log("Failed to Disable Rippling: Invalid target address.");
    errorElement.textContent = 'Invalid target address.';
    return;
  }

  tx.LimitAmount.currency = currencyHex;

  queueAdminTransaction({
    action: "Disable Rippling",
    description: `Disable rippling for ${currencyInput} with ${targetAddress}`,
    tx,
    confirmDetails: `Disable rippling for the trustline of ${currencyInput} with ${targetAddress}, preventing token flow through accounts.`
  });
}

function queueFreezeTrustline() {
  const currencyInput = document.getElementById('admin-freeze-currency')?.value.trim() || "";
  const targetAddress = document.getElementById('admin-freeze-target')?.value.trim() || "";
  const errorElement = document.getElementById('address-error-admin');

  const tx = {
    TransactionType: "TrustSet",
    Account: globalAddress,
    LimitAmount: { currency: null, issuer: targetAddress, value: "9000000000000000" }, 
    Fee: TRANSACTION_FEE_DROPS,
    Flags: TF_SET_FREEZE
  };

  queueAdminTransaction({
    action: "Freeze Trustline",
    description: `Freeze trustline for ${currencyInput} with ${targetAddress}`,
    tx,
    validateInputs: () => {
      return new Promise(resolve => {
        if (!currencyInput || !targetAddress) {
          log("Failed to Freeze Trustline: Missing currency or target address.");
          errorElement.textContent = 'All fields required.';
          resolve(false);
          return;
        }
        const currencyHex = validateAndConvertCurrency(currencyInput);
        if (!currencyHex) {
          log("Failed to Freeze Trustline: Invalid currency code.");
          errorElement.textContent = 'Invalid currency code.';
          resolve(false);
          return;
        }
        if (!xrpl.isValidAddress(targetAddress)) {
          log("Failed to Freeze Trustline: Invalid target address.");
          errorElement.textContent = 'Invalid target address.';
          resolve(false);
          return;
        }

        tx.LimitAmount.currency = currencyHex;
        resolve(true);
      });
    },
    confirmDetails: `Freeze the trustline for ${currencyInput} with ${targetAddress}, preventing token transfers. This can be reversed by unfreezing.`
  });
}

function queueUnfreezeTrustline() {
  const currencyInput = document.getElementById('admin-freeze-currency')?.value.trim() || "";
  const targetAddress = document.getElementById('admin-freeze-target')?.value.trim() || "";
  const errorElement = document.getElementById('address-error-admin');

  const tx = {
    TransactionType: "TrustSet",
    Account: globalAddress,
    LimitAmount: { currency: null, issuer: targetAddress, value: "9000000000000000" },
    Fee: TRANSACTION_FEE_DROPS,
    Flags: TF_CLEAR_FREEZE
  };

  if (!currencyInput || !targetAddress) {
    log("Failed to Unfreeze Trustline: Missing currency or target address.");
    errorElement.textContent = 'All fields required.';
    return;
  }

  const currencyHex = validateAndConvertCurrency(currencyInput);
  if (!currencyHex) {
    log("Failed to Unfreeze Trustline: Invalid currency code.");
    errorElement.textContent = 'Invalid currency code.';
    return;
  }

  if (!xrpl.isValidAddress(targetAddress)) {
    log("Failed to Unfreeze Trustline: Invalid target address.");
    errorElement.textContent = 'Invalid target address.';
    return;
  }

  tx.LimitAmount.currency = currencyHex;

  queueAdminTransaction({
    action: "Unfreeze Trustline",
    description: `Unfreeze trustline for ${currencyInput} with ${targetAddress}`,
    tx,
    confirmDetails: `Unfreeze the trustline for ${currencyInput} with ${targetAddress}, allowing token transfers.`
  });
}

function queueClawback() {
  const currencyInput = document.getElementById('admin-clawback-currency')?.value.trim() || "";
  const targetAddress = document.getElementById('admin-clawback-target')?.value.trim() || "";
  const amountInput = document.getElementById('admin-clawback-amount')?.value.trim() || "";
  const errorElement = document.getElementById('address-error-admin');

  const tx = {
    TransactionType: "Clawback",
    Account: globalAddress,
    Amount: { currency: null, issuer: targetAddress, value: null },
    Fee: TRANSACTION_FEE_DROPS
  };

  if (!currencyInput || !targetAddress || !amountInput) {
    log("Failed to Clawback: Missing currency, target address, or amount.");
    errorElement.textContent = 'All fields required.';
    return;
  }

  const currencyHex = validateAndConvertCurrency(currencyInput);
  if (!currencyHex) {
    log("Failed to Clawback: Invalid currency code.");
    errorElement.textContent = 'Invalid currency code.';
    return;
  }

  const amount = parseFloat(amountInput);
  if (isNaN(amount) || amount <= 0) {
    log("Failed to Clawback: Invalid amount.");
    errorElement.textContent = 'Invalid amount.';
    return;
  }

  if (!xrpl.isValidAddress(targetAddress)) {
    log("Failed to Clawback: Invalid target address.");
    errorElement.textContent = 'Invalid target address.';
    return;
  }

  tx.Amount.currency = currencyHex;
  tx.Amount.value = amount.toString();

  queueAdminTransaction({
    action: "Clawback",
    description: `Clawback ${amountInput} ${currencyInput} from ${targetAddress}`,
    tx,
    confirmDetails: `Claw back ${amountInput} ${currencyInput} from ${targetAddress}, removing tokens from their balance.`
  });
}

function queueEnableClawback() {
  const tx = {
    TransactionType: "AccountSet",
    Account: globalAddress,
    SetFlag: ASF_ALLOW_TRUSTLINE_CLAWBACK,
    Fee: TRANSACTION_FEE_DROPS
  };

  queueAdminTransaction({
    action: "Enable Clawback",
    description: "Enable clawback feature",
    tx,
    confirmDetails: "Enable clawback feature, allowing token recovery. This action cannot be undone."
  });
}

function queueSetNoFreeze() {
  const tx = {
    TransactionType: "AccountSet",
    Account: globalAddress,
    SetFlag: ASF_NO_FREEZE,
    Fee: TRANSACTION_FEE_DROPS
  };

  queueAdminTransaction({
    action: "Set NoFreeze",
    description: "Set NoFreeze flag",
    tx,
    confirmDetails: "Set NoFreeze flag, preventing future freezes. This cannot be undone."
  });
}

function queueToggleXrpPayments(enable) {
  const tx = {
    TransactionType: "AccountSet",
    Account: globalAddress,
    Fee: TRANSACTION_FEE_DROPS
  };
  if (enable) {
    tx.ClearFlag = ASF_DISALLOW_XRP;
  } else {
    tx.SetFlag = ASF_DISALLOW_XRP;
  }

  queueAdminTransaction({
    action: enable ? "Enable XRP Payments" : "Disable XRP Payments",
    description: (enable ? "Enable" : "Disable") + " XRP payments",
    tx,
    confirmDetails: enable ? "Allow this account to send/receive XRP directly." : "Prevent this account from sending/receiving XRP directly."
  });
}

function queueGlobalFreeze() {
  const tx = {
    TransactionType: "AccountSet",
    Account: globalAddress,
    SetFlag: ASF_GLOBAL_FREEZE,
    Fee: TRANSACTION_FEE_DROPS
  };

  queueAdminTransaction({
    action: "Global Freeze",
    description: `Enable global freeze`,
    tx,
    confirmDetails: `Freeze all trustlines for this account, preventing token transfers globally. Verify at: https://xrpscan.com/account/${globalAddress}`
  });
}

function queueGlobalUnfreeze() {
  const tx = {
    TransactionType: "AccountSet",
    Account: globalAddress,
    ClearFlag: ASF_GLOBAL_FREEZE,
    Fee: TRANSACTION_FEE_DROPS
  };

  queueAdminTransaction({
    action: "Global Unfreeze",
    description: `Disable global freeze`,
    tx,
    confirmDetails: `Unfreeze all trustlines for this account, allowing token transfers globally. Verify at: https://xrpscan.com/account/${globalAddress}`
  });
}

function queueBlackholeAccount() {
  const address = globalAddress;
  const errorElement = document.getElementById('address-error-admin');

  if (!contentCache || !displayTimer) {
    log("Failed to Blackhole Account: No wallet loaded.");
    errorElement.textContent = 'No wallet loaded.';
    return;
  }
  if (!xrpl.isValidAddress(address)) {
    log("Failed to Blackhole Account: Invalid wallet address.");
    errorElement.textContent = 'Invalid address.';
    return;
  }

  const preEther = spawnEtherNoise(4);
  window.etherPreFlux = preEther;

  ensureConnected()
    .then(() => {
      calculateAvailableBalance(address).then(balanceInfo => {
        const availableBalanceXrp = balanceInfo.availableBalanceXrp;
        const totalFeeXrp = 4 * parseFloat(xrpl.dropsToXrp(TRANSACTION_FEE_DROPS));
        const recommendedMaxBalanceXrp = 1.0;
        const absoluteMaxBalanceXrp = 3.0;

        if (totalFeeXrp > availableBalanceXrp) {
          log(`Failed to Blackhole Account: Insufficient XRP for fees (Need ${totalFeeXrp.toFixed(6)}, Have ${formatBalance(availableBalanceXrp)}).`);
          errorElement.textContent = `Need ${totalFeeXrp.toFixed(6)} XRP, have ${formatBalance(availableBalanceXrp)}.`;
          return;
        }

        let confirmDetails = `Permanently render this account unusable by blackholing it. Ensure minimal XRP remains.\nCurrent balance: ${formatBalance(availableBalanceXrp)} XRP.\nMinimum required for fees: ${totalFeeXrp.toFixed(6)} XRP.`;
        if (availableBalanceXrp > recommendedMaxBalanceXrp) {
          confirmDetails += `\n⚠️ WARNING: Balance exceeds recommended maximum of ${recommendedMaxBalanceXrp} XRP. Any XRP above ${totalFeeXrp.toFixed(6)} XRP will be unrecoverable after blackholing. Proceed only if you are certain.`;
        }

        showAdminConfirmationModal("Blackhole Account", confirmDetails).then(confirmed => {
          if (!confirmed) {
            log("Blackhole Account Cancelled");
            return;
          }

          if (availableBalanceXrp > absoluteMaxBalanceXrp) {
            log(`Failed to Blackhole Account: Balance too high (Reduce to ${absoluteMaxBalanceXrp.toFixed(6)} XRP or less).`);
            errorElement.textContent = `Balance ${formatBalance(availableBalanceXrp)} XRP. Reduce to ${absoluteMaxBalanceXrp.toFixed(6)} XRP or less.`;
            return;
          }

          fetchRenderContent().then(seed => {
            const wallet = xrpl.Wallet.fromSeed(seed);
            if (wallet.classicAddress !== address) {
              log("Failed to Blackhole Account: Wallet seed mismatch.");
              errorElement.textContent = 'Seed mismatch.';
              return;
            }

            const transactions = [
              {
                tx: {
                  TransactionType: "AccountSet",
                  Account: address,
                  SetFlag: ASF_DEFAULT_RIPPLE,
                  Fee: TRANSACTION_FEE_DROPS
                },
                description: "Enable rippling for blackhole"
              },
              {
                tx: {
                  TransactionType: "SetRegularKey",
                  Account: address,
                  RegularKey: "rrrrrrrrrrrrrrrrrrrrBZbvji",
                  Fee: TRANSACTION_FEE_DROPS
                },
                description: "Set regular key to null address"
              },
              {
                tx: {
                  TransactionType: "AccountSet",
                  Account: address,
                  SetFlag: ASF_DISALLOW_XRP,
                  Fee: TRANSACTION_FEE_DROPS
                },
                description: "Disallow XRP payments"
              },
              {
                tx: {
                  TransactionType: "AccountSet",
                  Account: address,
                  SetFlag: ASF_DISABLE_MASTER,
                  Fee: TRANSACTION_FEE_DROPS
                },
                description: "Disable master key for blackhole"
              }
            ];

            log(`Starting Blackhole Account: 4 Transactions to Disable ${address}`);
            for (const transaction of transactions) {
              const txEntry = {
                tx: transaction.tx,
                wallet,
                description: transaction.description,
                delayMs: 0,
                type: "admin",
                queueElementId: "admin-queue"
              };
              transactionQueue.push(txEntry);
              updateTransactionQueueDisplay();
            }

            if (!isProcessingQueue) {
              processTransactionQueue();
            }
          });
        });
      });
    })
    .catch(error => {
      log(`Failed to Blackhole Account: ${error.message}`);
      errorElement.textContent = `Error: ${error.message}`;
    });
}

function toggleIssuerInputs() {
  if (isCheckingIssuer) {
    return;
  }
  isCheckingIssuer = true;

  const address = typeof globalAddress !== 'undefined' ? globalAddress : null;
  const errorElement = document.getElementById('address-error-admin');

  const buttons = [
    'admin-nofreeze-btn',
    'admin-enable-clawback-btn',
    'admin-ripple-btn',
    'admin-no-ripple-btn',
    'admin-enable-xrp-btn',
    'admin-disable-xrp-btn',
    'admin-mint-btn',
    'admin-freeze-btn',
    'admin-unfreeze-btn',
    'admin-clawback-btn',
    'admin-global-freeze-btn',
    'admin-global-unfreeze-btn',
    'admin-blackhole-btn',
    'admin-check-xrpscan-btn'
  ].map(id => document.getElementById(id)).filter(btn => btn);

  const isEnabled = address && xrpl.isValidAddress(address) && client && client.isConnected();
  for (const btn of buttons) {
    btn.disabled = !isEnabled;
  }

  errorElement.textContent = isEnabled ? '' : 'Connect to XRPL and load a valid wallet.';
  isCheckingIssuer = false;
}

document.addEventListener('DOMContentLoaded', function () {
  const adminSection = document.getElementById('admin-tools');
  if (!adminSection) {
    log("Failed to Initialize Admin Tools: Section not found in DOM.");
    console.error("Admin tools section (#admin-tools) missing.");
    return;
  }

  adminSection
    .querySelector('.section-header')
    .addEventListener('click', debounce(() => {
      if (!adminSection.classList.contains('minimized')) {
        toggleIssuerInputs();
      }
    }, 300));

  const buttonActions = [
    { id: 'admin-mint-btn', handler: queueMintAdditionalTokens },
    { id: 'admin-freeze-btn', handler: queueFreezeTrustline },
    { id: 'admin-unfreeze-btn', handler: queueUnfreezeTrustline },
    { id: 'admin-clawback-btn', handler: queueClawback },
    { id: 'admin-enable-clawback-btn', handler: queueEnableClawback },
    { id: 'admin-nofreeze-btn', handler: queueSetNoFreeze },
    { id: 'admin-global-freeze-btn', handler: queueGlobalFreeze },
    { id: 'admin-global-unfreeze-btn', handler: queueGlobalUnfreeze },
    { id: 'admin-ripple-btn', handler: queueEnableRippling },
    { id: 'admin-no-ripple-btn', handler: queueDisableRippling },
    { id: 'admin-enable-xrp-btn', handler: () => queueToggleXrpPayments(true) },
    { id: 'admin-disable-xrp-btn', handler: () => queueToggleXrpPayments(false) },
    { id: 'admin-blackhole-btn', handler: queueBlackholeAccount },
    { id: 'admin-check-xrpscan-btn', handler: openXrpscan }
  ];

  buttonActions.forEach(action => {
    const btn = document.getElementById(action.id);
    if (btn) {
      btn.removeEventListener('click', action.handler);
      const debouncedHandler = debounce(action.handler, 300);
      btn.addEventListener('click', debouncedHandler);
    } else {
      console.warn(`Button ${action.id} not found in DOM.`);
    }
  });

  if (typeof globalAddress !== 'undefined') {
    toggleIssuerInputs();
  } else {
    const interval = setInterval(() => {
      if (typeof globalAddress !== 'undefined') {
        toggleIssuerInputs();
        clearInterval(interval);
      }
    }, 100);
  }
});

function openXrpscan() {
  const address = globalAddress;
  if (xrpl.isValidAddress(address)) {
    window.open(`https://xrpscan.com/account/${address}`, '_blank');
    log(`Opening XRPSCAN for ${address}`);
  } else {
    log('Failed to Open XRPSCAN: No valid wallet loaded.');
    document.getElementById('address-error-admin').textContent = 'Load a valid wallet to view on XRPSCAN.';
  }
}

document.addEventListener('DOMContentLoaded', function () {
  const adminSection = document.getElementById('admin-tools');
  if (!adminSection) {
    log("Failed to Initialize Admin Tools: Section not found in DOM.");
    console.error("Admin tools section (#admin-tools) missing.");
    return;
  }

  adminSection
    .querySelector('.section-header')
    .addEventListener('click', debounce(() => {
      if (!adminSection.classList.contains('minimized')) {
        toggleIssuerInputs();
      }
    }, 300));

  const buttonActions = [
    { id: 'admin-mint-btn', handler: queueMintAdditionalTokens },
    { id: 'admin-freeze-btn', handler: queueFreezeTrustline },
    { id: 'admin-unfreeze-btn', handler: queueUnfreezeTrustline },
    { id: 'admin-clawback-btn', handler: queueClawback },
    { id: 'admin-enable-clawback-btn', handler: queueEnableClawback },
    { id: 'admin-nofreeze-btn', handler: queueSetNoFreeze },
    { id: 'admin-global-freeze-btn', handler: queueGlobalFreeze },
    { id: 'admin-global-unfreeze-btn', handler: queueGlobalUnfreeze },
    { id: 'admin-ripple-btn', handler: queueEnableRippling },
    { id: 'admin-no-ripple-btn', handler: queueDisableRippling },
    { id: 'admin-enable-xrp-btn', handler: () => queueToggleXrpPayments(true) },
    { id: 'admin-disable-xrp-btn', handler: () => queueToggleXrpPayments(false) },
    { id: 'admin-blackhole-btn', handler: queueBlackholeAccount },
    { id: 'admin-check-xrpscan-btn', handler: openXrpscan }
  ];

  buttonActions.forEach(action => {
    const btn = document.getElementById(action.id);
    if (btn) {
      btn.removeEventListener('click', action.handler);
      const debouncedHandler = debounce(action.handler, 300);
      btn.addEventListener('click', debouncedHandler);
    } else {
      console.warn(`Button ${action.id} not found in DOM.`);
    }
  });

  toggleIssuerInputs();
});