let client = null;
let transactionQueue = [];
let isProcessingQueue = false;
let isConnecting = false;
const TRANSACTION_FEE_DROPS = "12";
let globalAddress = "";
let passwordResolve = null;
const BASE_RESERVE_XRP = 1;
const TRUSTLINE_RESERVE_XRP = 0.2;
const ACCOUNT_DELETE_FEE_XRP = 0.2;
let contentCache = null;
let displayTimer = null;
let encryptedPasswords = null;
let passwordSessionKey = null;
let isWalletFreshlyCreated = false;
const ammState = {
    lastPoolPrice: null,
    lastPriceCheckTimestamp: null
};
let cachedBalance = { totalBalanceXrp: 0, totalReserveXrp: 0, availableBalanceXrp: 0, timestamp: 0 };
const poolLogPrefixXrplAssetsBasePair = "XrplAssetsBasePair_X7k9PqWvT2mY8nL5jR3";
let dynamicAssets = [];

function randomizeServerSelection() {
    const serverSelect = document.getElementById('wss-server');
    if (!serverSelect) {
        log('Error: #wss-server dropdown not found on page load.');
        return;
    }
    
    const options = serverSelect.options;
    if (options.length === 0) {
        log('Error: No server options available in #wss-server.');
        return;
    }
    
    const selectedIndex = options.length === 1 ? 0 : Math.floor(Math.random() * options.length);
    serverSelect.selectedIndex = selectedIndex;
    log(`Random server selected on page load: ${options[selectedIndex].text}`);
}

async function deriveKey(password, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveBits", "deriveKey"]);
    return await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt, iterations: 500000, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
}

async function deriveOuterKey(salt) {
    try {
        const hash = await argon2.hash({
            pass: poolLogPrefixXrplAssetsBasePair,
            salt: salt,
            time: 3,
            mem: 64 * 1024,
            parallelism: 4,
            hashLen: 32,
            type: argon2.Argon2id
        });
        return await crypto.subtle.importKey(
            "raw",
            hash.hash,
            { name: "AES-GCM" },
            false,
            ["encrypt", "decrypt"]
        );
    } catch (error) {
        throw new Error(`Outer key derivation failed: ${error.message}`);
    }
}

function a1(length = 32) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_!@#$%^&*";
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => chars[b % chars.length]).join("");
}

async function b2(salt, x) {
    try {
        const hash = await argon2.hash({
            pass: x,
            salt: salt,
            time: 10,
            mem: 256 * 1024,
            parallelism: 4,
            hashLen: 32,
            type: argon2.Argon2id
        });
        return await crypto.subtle.importKey(
            "raw",
            hash.hash,
            { name: "AES-GCM" },
            false,
            ["encrypt", "decrypt"]
        );
    } catch (error) {
        throw new Error(`Argon2 key derivation failed: ${error.message}`);
    }
}
function stringToHex(str) {
    return str.split('')
        .map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('');
}

function arrayBufferToBase64(arrayBuffer) {
    const uint8Array = new Uint8Array(arrayBuffer);
    const binary = Array.from(uint8Array).map(byte => String.fromCharCode(byte)).join('');
    try {
        return btoa(binary);
    } catch (error) {
        log(`Base64 encoding error: ${error.message}`);
        console.error("Failed to encode:", uint8Array, error);
        throw error;
    }
}

function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes.buffer;
}

async function initializePasswordSessionKey() {
    const randomPassword = a1(32);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await argon2.hash({
        pass: randomPassword,
        salt: salt,
        time: 3,
        mem: 64 * 1024,
        parallelism: 4,
        hashLen: 32,
        type: argon2.Argon2id
    });
    passwordSessionKey = await crypto.subtle.importKey(
        "raw",
        hash.hash,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"]
    );
    return { salt, randomPassword };
}

async function updateDisplayData(dataItem) {
    if (!dataItem || typeof dataItem !== 'string') {
        throw new Error("Data item must be a non-empty string.");
    }

    const textProcessor = new TextEncoder();
    const styleOffset = crypto.getRandomValues(new Uint8Array(16));
    const renderKey = crypto.getRandomValues(new Uint8Array(32));
    let layoutHash;
    try {

        const renderKeyHex = Array.from(renderKey).map(byte => byte.toString(16).padStart(2, '0')).join('');
        layoutHash = await argon2.hash({
            pass: renderKeyHex,
            salt: styleOffset,
            time: 10,
            mem: 64 * 1024,
            parallelism: 4,
            hashLen: 32,
            type: argon2.Argon2id
        });
        if (!(layoutHash.hash instanceof Uint8Array) || layoutHash.hash.byteLength !== 32) {
            throw new Error("hash failed to produce valid output.");
        }
    } catch (hashError) {
        log(` hash failed: ${hashError.message}`);
        throw hashError;
    }

    let formattedText;
    let seedIv;
    try {
        seedIv = crypto.getRandomValues(new Uint8Array(12));
        const aesKey = await crypto.subtle.importKey(
            "raw",
            layoutHash.hash,
            { name: "AES-GCM" },
            false,
            ["encrypt", "decrypt"]
        );
        formattedText = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: seedIv },
            aesKey,
            textProcessor.encode(dataItem)
        );
        if (!(formattedText instanceof ArrayBuffer) || formattedText.byteLength === 0) {
            throw new Error("Invalid encrypted seed data.");
        }

    } catch (encryptError) {
        log(`Seed encryption failed: ${encryptError.message}`);
        throw encryptError;
    }

    let tickGenerator;
    try {
        tickGenerator = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt", "decrypt"]
        );
        if (!(tickGenerator instanceof CryptoKey)) {
            throw new Error("Key generation failed to produce a valid CryptoKey.");
        }
    } catch (keyGenError) {
        log(`TickGenerator generation failed: ${keyGenError.message}`);
        throw keyGenError;
    }

    let lockedKey;
    const frameShift = crypto.getRandomValues(new Uint8Array(12));
    try {
        lockedKey = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: frameShift },
            tickGenerator,
            renderKey
        );
        if (!(lockedKey instanceof ArrayBuffer) || lockedKey.byteLength === 0) {
            throw new Error("Invalid locked key data.");
        }
    } catch (lockError) {
        log(`RenderKey encryption failed: ${lockError.message}`);
        throw lockError;
    }

    try {
        contentCache = {
            textBlock: arrayBufferToBase64(formattedText),
            offset: arrayBufferToBase64(styleOffset),
            spacing: arrayBufferToBase64(seedIv),
            keyFrame: arrayBufferToBase64(lockedKey),
            shift: arrayBufferToBase64(frameShift)
        };
        if (!contentCache.spacing || contentCache.spacing.length === 0) {
            throw new Error("Invalid Base64 encoding of seed IV.");
        }
        displayTimer = tickGenerator;
    } catch (cacheError) {
        log(`Cache setup failed: ${cacheError.message}`);
        throw cacheError;
    }

    dataItem = null;
}
async function fetchRenderContent() {
    
    if (!contentCache || !displayTimer) {
       
        throw new Error("No display cache available.");
    }

    
    const textDecoder = new TextDecoder();

    let activeKey;
    try {
    
        const iv = base64ToArrayBuffer(contentCache.shift);
        const ciphertext = base64ToArrayBuffer(contentCache.keyFrame);
        
        activeKey = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            displayTimer,
            ciphertext
        );
        if (!(activeKey instanceof ArrayBuffer) || activeKey.byteLength === 0) {
        
            throw new Error("Decryption failed to produce valid key data.");
        }
        
        const activeKeyArray = new Uint8Array(activeKey);
        
    } catch (decryptError) {
        
        console.error("Decryption failed:", decryptError);
        throw new Error(`Key decryption failed: ${decryptError.message}`);
    }

    let styleHash;
    try {
        const realSaltArrayBuffer = base64ToArrayBuffer(contentCache.offset);
        const realSalt = new Uint8Array(realSaltArrayBuffer); 
        
        const fullPassString = Array.from(new Uint8Array(activeKey)).map(byte => byte.toString(16).padStart(2, '0')).join('');
        const testHash = await argon2.hash({
            pass: "testpassword123",
            salt: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
            time: 1,
            mem: 1024,
            hashLen: 32,
            type: argon2.Argon2id
        });
        styleHash = await argon2.hash({
            pass: fullPassString,
            salt: realSalt,
            time: 10,
            mem: 64 * 1024,
            parallelism: 4,
            hashLen: 32,
            type: argon2.Argon2id
        });
        
    } catch (hashError) {
        
        console.error("Hashing failed:", hashError);
        throw new Error(`Argon2 hashing failed: ${hashError.message}`);
    }

    let tempOutput;
    try {
        
        const seedIv = base64ToArrayBuffer(contentCache.spacing);
        
        const aesKey = await crypto.subtle.importKey(
            "raw",
            styleHash.hash,
            { name: "AES-GCM" },
            false,
            ["encrypt", "decrypt"]
        );
        tempOutput = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: seedIv },
            aesKey,
            base64ToArrayBuffer(contentCache.textBlock)
        );
        
    } catch (finalDecryptError) {
        
        console.error("Final decryption failed:", finalDecryptError);
        throw new Error(`Seed decryption failed: ${finalDecryptError.message}`);
    }

    const output = textDecoder.decode(tempOutput);
    

    tempOutput = crypto.getRandomValues(new Uint8Array(tempOutput.byteLength));
    tempOutput = crypto.getRandomValues(new Uint8Array(tempOutput.byteLength));
    tempOutput = crypto.getRandomValues(new Uint8Array(tempOutput.byteLength));
    tempOutput = null;

    if (!output || typeof output !== 'string' || !output.match(/^s[0-9a-zA-Z]{27,}$/)) {
        
        throw new Error("Invalid seed format after decryption.");
    }

    return output;
}

async function encryptPasswordsInMemory(password1, password2) {
    const { salt } = await initializePasswordSessionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const data = JSON.stringify({ password1, password2 });
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        passwordSessionKey,
        encoder.encode(data)
    );
    encryptedPasswords = {
        data: arrayBufferToBase64(encrypted),
        iv: arrayBufferToBase64(iv),
        salt: arrayBufferToBase64(salt)
    };
}

async function decryptPasswordsInMemory() {
    if (!encryptedPasswords || !passwordSessionKey) {
        throw new Error("No wallet in memory.");
    }
    const decoder = new TextDecoder();
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(base64ToArrayBuffer(encryptedPasswords.iv)) },
        passwordSessionKey,
        base64ToArrayBuffer(encryptedPasswords.data)
    );
    return JSON.parse(decoder.decode(decrypted));
}

function spawnEtherNoise(count) {
    const etherBits = [];
    for (let i = 0; i < count; i++) {
        const flux = xrpl.Wallet.generate();
        etherBits.push({
            locus: flux.classicAddress,
            spark: flux.seed,
            tag: `Ether Shard ${i + 1}`
        });
        
    }
    return etherBits;
}

async function resecureCache() {
    if (!contentCache || !displayTimer) {
    
        return;
    }
    

    const newDisplayTimer = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );

    const oldIv = base64ToArrayBuffer(contentCache.shift);
    const oldCiphertext = base64ToArrayBuffer(contentCache.keyFrame);
    const renderKey = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: oldIv },
        displayTimer,
        oldCiphertext
    );

    const newIv = crypto.getRandomValues(new Uint8Array(12));
    const newCiphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: newIv },
        newDisplayTimer,
        renderKey
    );

    contentCache = {
        textBlock: contentCache.textBlock,
        offset: contentCache.offset,
        spacing: contentCache.spacing,
        keyFrame: arrayBufferToBase64(newCiphertext),
        shift: arrayBufferToBase64(newIv)
    };
    displayTimer = newDisplayTimer;

    
}
function clearSensitiveData() {
    contentCache = null;
    displayTimer = null;
    encryptedPasswords = null;
    passwordSessionKey = null;
    globalAddress = "";
    isWalletFreshlyCreated = false;
    
}

function log(message) {
    const output = document.getElementById('output');
    if (output) {
        const addressRegex = /(r[0-9a-zA-Z]{25,35})/g;
        const hashRegex = /([0-9A-Fa-f]{64})/g;

        let linkedMessage = message;
        linkedMessage = linkedMessage.replace(addressRegex, match => `<a href="https://xrpscan.com/account/${match}" class="address-link" target="_blank">${match}</a>`);
        linkedMessage = linkedMessage.replace(hashRegex, match => `<a href="https://xrpscan.com/tx/${match}" class="hash-link" target="_blank">${match}</a>`);

        output.insertAdjacentHTML('beforeend', linkedMessage + '<br>');
        output.scrollTop = output.scrollHeight;
    }
}

function showPasswordModal() {
    return new Promise((resolve) => {
        const modal = document.getElementById('passwordModal');
        const password1Input = document.getElementById('password1');
        const password2Input = document.getElementById('password2');
        const submitButton = document.getElementById('submitPasswords');

        password1Input.value = '';
        password2Input.value = '';
        password1Input.type = 'password';
        password2Input.type = 'password';
        const toggleButtons = document.querySelectorAll('.toggle-password');
        toggleButtons.forEach(btn => btn.textContent = 'Show');

        modal.style.display = 'flex';
        passwordResolve = resolve;

        submitButton.onclick = () => {
            const password1 = password1Input.value;
            const password2 = password2Input.value;
            if (!password1 || !password2) {
                log('Error: Both passwords are required.');
                return;
            }
            modal.style.display = 'none';
            password1Input.value = '';
            password2Input.value = '';
            resolve({ password1, password2 });
        };
    });
}

function closePasswordModal() {
    const modal = document.getElementById('passwordModal');
    const password1Input = document.getElementById('password1');
    const password2Input = document.getElementById('password2');
    modal.style.display = 'none';
    password1Input.value = '';
    password2Input.value = '';
    setTimeout(() => {
        reapplyCursorStyle();
    }, 100);
    if (passwordResolve) {
        passwordResolve(null);
    }
}

function togglePasswordVisibility(inputId, button) {
    const input = document.getElementById(inputId);
    if (input.type === 'password') {
        input.type = 'text';
        button.textContent = 'Hide';
    } else {
        input.type = 'password';
        button.textContent = 'Show';
    }
}


async function decodeLPToken(currency, issuer) {
    try {
        const hexCurrency = currency.toLowerCase();
        const prefix = hexCurrency.substring(0, 2);
        if (prefix !== '03') {
            return null;
        }

        await ensureConnected();
        const accountObjects = await client.request({
            command: "account_objects",
            account: issuer,
            ledger_index: "current",
            type: "amm"
        });

        let asset1, asset2;
        for (const obj of accountObjects.result.account_objects) {
            if (obj.LedgerEntryType === "AMM") {
                asset1 = obj.Asset;
                asset2 = obj.Asset2;
                break;
            }
        }

        if (!asset1 || !asset2) {
            log(`No AMM object found for issuer ${issuer}`);
            return `Unknown LP (Issuer: ${issuer.slice(0, 10)}...)`;
        }

        const asset1Name = asset1.currency === "XRP" ? "XRP" : prefabAssets.find(a => a.hex === asset1.currency)?.name || xrpl.convertHexToString(asset1.currency).replace(/\0/g, '') || `[HEX:${asset1.currency.slice(0, 8)}]`;
        const asset2Name = asset2.currency === "XRP" ? "XRP" : prefabAssets.find(a => a.hex === asset2.currency)?.name || xrpl.convertHexToString(asset2.currency).replace(/\0/g, '') || `[HEX:${asset2.currency.slice(0, 8)}]`;
        const lpName = `${asset1Name}/${asset2Name} LP`;
        
        return lpName;
    } catch (error) {
        log(`Error decoding LP token for issuer ${issuer}: ${error.message}`);
        return `Unknown LP (Issuer: ${issuer.slice(0, 10)}...)`;
    }
}

async function checkBalance() {
    const errorElement = document.getElementById('address-error');
    try {
        await ensureConnected();
        const address = globalAddress;
        const accountAddress = document.getElementById('account-address');
        const assetGrid = document.getElementById('asset-grid');

        if (!xrpl.isValidAddress(address)) {
            if (errorElement) errorElement.textContent = 'Invalid XRPL address.';
            log('Error: Invalid XRPL address.');
            return;
        }

        if (errorElement) errorElement.textContent = '';

        const { totalBalanceXrp, totalReserveXrp, availableBalanceXrp: available } = await calculateAvailableBalance(address);

        const accountLines = await throttleRequest(() => client.request({
            command: "account_lines",
            account: address,
            ledger_index: "current"
        }));

        dynamicAssets = [];
        globalLPTokens = [];
        for (const line of accountLines.result.lines) {
            const currencyHex = line.currency;
            const currencyName = xrpl.convertHexToString(currencyHex).replace(/\0/g, '') || currencyHex;
            const issuer = line.account;
            if (!prefabAssets.some(a => a.hex === currencyHex)) {
                dynamicAssets.push({ name: currencyName, issuer: issuer, hex: currencyHex });
            }

            const lpName = await decodeLPToken(currencyHex, issuer);
            if (lpName) {
                globalLPTokens.push({
                    lpName: lpName,
                    currency: currencyHex,
                    issuer: issuer,
                    balance: parseFloat(line.balance)
                });
            }
        }
        log(`Updated globalLPTokens: ${JSON.stringify(globalLPTokens)}`);

        if (accountAddress && assetGrid) {
            accountAddress.innerHTML = `Address: <a href="https://xrpscan.com/account/${address}" class="address-link" target="_blank">${address}</a>`;
            assetGrid.innerHTML = `
                <div class="asset-item">
                    <span class="asset-name">XRP</span>
                    <div class="asset-balance">
                        Total: ${formatBalance(totalBalanceXrp)} XRP<br>
                        Reserve: ${formatBalance(totalReserveXrp)} XRP<br>
                        Available: ${formatBalance(available)} XRP
                    </div>
                </div>
            `;

            for (const line of accountLines.result.lines) {
                const currencyHex = line.currency;
                let assetName = xrpl.convertHexToString(currencyHex).replace(/\0/g, '') || `[HEX:${currencyHex.slice(0, 8)}]`;
                const issuer = line.account;
				log('Wallet balance checked.');
                const lpName = await decodeLPToken(currencyHex, issuer);
                if (lpName) {
                    assetName = lpName;
                }

                const issuerLink = `<a href="https://xrpscan.com/account/${issuer}" class="address-link" target="_blank"><span class="asset-name">${assetName}</span></a>`;
                assetGrid.innerHTML += `
                    <div class="asset-item">
                        ${issuerLink}
                        <div class="asset-balance">${formatBalance(line.balance)}</div>
                    </div>
                `;
            }
        } else {
            log('Error: UI elements (account-address or asset-grid) not found.');
        }

        updateBalances();
        selectTrustAsset();
        await new Promise(resolve => setTimeout(resolve, 100));
        populateAssetDropdowns();
    } catch (error) {
        log(`Error checking balance: ${error.message}`);
        if (errorElement) errorElement.textContent = 'Failed to check balance';
        throw error;
    }
}

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
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            reject(error);
        }
    }

    isProcessingRequests = false;
}

async function i9(event) {
    const file = event.target.files[0];
    if (!file) {
        log('No file selected.');
        return;
    }
    const fileNameDisplay = document.getElementById('fileName');
    if (fileNameDisplay) {
        fileNameDisplay.textContent = file.name;
    }
    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const data = JSON.parse(e.target.result);
            if (!data.z || !data.v1 || !data.s1 || !data.v2 || !data.s2 || !data.v3 || !data.s3) {
                log('Error: Invalid wallet file format. Expected triple-layer encryption fields.');
                return;
            }
            const passwords = await showPasswordModal();
            if (!passwords) {
                log('Error: Password entry cancelled.');
                return;
            }
            const { password1, password2 } = passwords;
            let parsedData = await f6(
                data.z,
                data.v1,
                data.s1,
                data.v2,
                data.s2,
                data.v3,
                data.s3,
                password1,
                password2
            );
            const seedBox = document.getElementById('seed');
            const addrBox = document.getElementById('address');
            seedBox.type = 'text';
            addrBox.type = 'password';
            seedBox.value = 'Seed Loaded (Not Displayed)';
            addrBox.value = parsedData.address;
            globalAddress = parsedData.address;
            await updateDisplayData(parsedData.seed);
            await encryptPasswordsInMemory(password1, password2);
            isWalletFreshlyCreated = false;
            log('Wallet loaded from the ether');
            log('Welcome to the mad lab');
            log('You are the chief scientist');

            const alertPanel = document.getElementById('wallet-warning');
            if (alertPanel) {
                alertPanel.innerHTML = `
                    <h3>Wallet Loaded</h3>
                    <p>Your wallet has been loaded. The address is displayed above and can be viewed via QR code below.</p>
                    <p>Click the button below to view the address QR code (safe to share for funding):</p>
                    <div class="qr-buttons">
                        <button class="green-btn" onclick="showQRCode('address', '${parsedData.address}')">Show Address QR Code</button>
                    </div>
                    <p>The seed is not displayed during loading for security reasons. To create an unencrypted backup, verify your passwords:</p>
                    <button class="red-black-btn" onclick="downloadUnencryptedWallet(null, null)">Download Unencrypted Wallet</button>
                    <p>Connecting to the server and checking balance automatically...</p>
                `;
                alertPanel.style.display = 'block';
            }

            await connectWebSocket();
            await checkBalance();
            parsedData.seed = crypto.getRandomValues(new Uint8Array(32));
            parsedData.seed = crypto.getRandomValues(new Uint8Array(32));
            parsedData.seed = crypto.getRandomValues(new Uint8Array(32));
            parsedData = null;

            const soundFiles = ['1.mp3', '2.mp3', '3.mp3'];
            const randomSound = soundFiles[Math.floor(Math.random() * soundFiles.length)];
            const audio = new Audio(`sounds/${randomSound}`);
            audio.play().catch(error => {});
        } catch (error) {
            log(`Error: Failed to load wallet file: ${error.message}`);
        }
    };
    reader.onerror = function() {
        log('Error reading wallet file.');
    };
    reader.readAsText(file);
}
async function createWallet() {
    const seedInput = document.getElementById('seed');
    const addressInput = document.getElementById('address');

    if (globalAddress || contentCache) {
        const confirmed = await showWalletOverwriteConfirmation();
        if (!confirmed) {
            log('Wallet creation cancelled by user.');
            return;
        }

        clearWalletData();
    }

    seedInput.value = '';
    addressInput.value = '';

    let inputText = seedInput.value.trim();
    let wallet;

    if (inputText && inputText.length > 0) {
        if (!inputText.match(/^s[0-9a-zA-Z]{27,}$/)) {
            log('Error: Invalid seed format. Seeds typically start with "s" and are 28+ characters.');
            document.getElementById('address-error').textContent = 'Invalid seed format.';
            return;
        }
        try {
            wallet = xrpl.Wallet.fromSeed(inputText);
        } catch (error) {
            log(`Error: Invalid seed - ${error.message}`);
            document.getElementById('address-error').textContent = 'Invalid seed.';
            return;
        }
    } else {
        wallet = xrpl.Wallet.generate();
        inputText = wallet.seed;
    }

    const locationTag = wallet.classicAddress;
    seedInput.type = 'text';
    addressInput.type = 'password';
    seedInput.value = 'Seed Loaded (View via QR Code Below)';
    addressInput.value = locationTag;
    globalAddress = locationTag;
    await updateDisplayData(inputText);
    isWalletFreshlyCreated = true;
    log('Wallet created or loaded from seed');

    const alertPanel = document.getElementById('wallet-warning');
    if (alertPanel) {
        const isCustomInput = inputText && inputText.length > 0 && document.getElementById('seed').value.trim() !== 'Seed Loaded (View via QR Code Below)';
        alertPanel.innerHTML = `
            <h3>⚠️ IMPORTANT WARNING ⚠️</h3>
            <p style="color: #ff4444; font-weight: bold;">
                ${isCustomInput ? 'You entered a seed manually. Ensure you save it securely!' : 'This is the ONLY time you will see your wallet seed unencrypted.'} 
                You MUST save this information securely by downloading the files below. If you lose it, you will lose access to your wallet permanently. Do NOT share your seed with anyone!
            </p>
            <p style="color: #ffaa00; font-weight: bold;">
                Critical Note: ${isCustomInput ? 'This seed is your responsibility to secure.' : 'You will never see this seed again after this moment.'} No one, including The Mad Lab, can recover it for you. Ensure you save it securely offline on another device or in written form (e.g., on paper stored in a safe place).
            </p>
            <p>Click the buttons below to view QR codes for funding your wallet or viewing your seed:</p>
            <div class="qr-buttons">
                <button class="green-btn" onclick="showQRCode('address', '${locationTag}')">Show Address QR Code</button>
                <button class="red-black-btn" onclick="showQRCode('seed', '${inputText}')">Show Seed QR Code</button>
            </div>
            <p>Download the unencrypted version of your wallet data for offline storage (e.g., USB or paper). Keep this file secure and never store it online:</p>
            <button class="red-black-btn" onclick="downloadUnencryptedWallet('${inputText}', '${locationTag}')">Download Unencrypted Wallet</button>
            <p>Download the encrypted version below for safe storage (requires your passwords to decrypt):</p>
            <button class="red-black-btn" onclick="g7('${inputText}', '${locationTag}')">Download Encrypted Wallet</button>
            <p>Once you have saved your wallet data, click the button below to clear it from the display and memory:</p>
            <button class="clear-dom-btn" onclick="clearWalletData()">Clear Wallet Data from Display</button>
        `;
        alertPanel.style.display = 'block';
    }

    inputText = crypto.getRandomValues(new Uint8Array(32));
    inputText = crypto.getRandomValues(new Uint8Array(32));
    inputText = crypto.getRandomValues(new Uint8Array(32));
    inputText = null;
}

function showWalletOverwriteConfirmation() {
    return new Promise((resolve) => {
        const existingModal = document.querySelector('.confirmation-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.className = 'password-modal-overlay confirmation-modal';
        modal.innerHTML = `
            <div class="password-modal-content">
                <h2>Confirm Wallet Creation</h2>
                <p>You currently have a wallet loaded. Do you wish to log out and create a new wallet?</p>
                <p>This action will clear your current wallet data from memory.</p>
                <div class="modal-buttons">
                    <button class="green-btn" id="confirmOverwrite">Yes, Create New Wallet</button>
                    <button class="red-black-btn" id="cancelOverwrite">Cancel</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.style.display = 'flex';

        const confirmButton = document.getElementById('confirmOverwrite');
        const cancelButton = document.getElementById('cancelOverwrite');

        const resolveAndCleanup = (result) => {
            modal.remove();
            resolve(result);
        };

        confirmButton.onclick = () => resolveAndCleanup(true);
        cancelButton.onclick = () => resolveAndCleanup(false);
    });
}

function showQRCode(type, data) {
    const existingModals = document.querySelectorAll('.qr-modal');
    existingModals.forEach(modal => modal.remove());

    const modal = document.createElement('div');
    modal.className = 'qr-modal';
    modal.innerHTML = `
        <div class="qr-modal-content">
            <h2>${type === 'address' ? 'Address QR Code' : 'Seed QR Code'}</h2>
            <p>Scan this QR code to ${type === 'address' ? 'fund your wallet' : 'import your wallet into another app'}.</p>
            <div id="qr-${type}"></div>
            <button class="red-black-btn" onclick="this.parentElement.parentElement.remove()">Close</button>
        </div>
    `;
    document.body.appendChild(modal);

    new QRCode(document.getElementById(`qr-${type}`), {
        text: data,
        width: 128,
        height: 128,
        colorDark: "#ffffff",
        colorLight: "#2a2a2a",
        correctLevel: QRCode.CorrectLevel.H
    });
}

async function g7(seed, address) {
    const passwords = await showPasswordModal();
    if (!passwords) {
        log('Error: Password entry cancelled.');
        return;
    }
    const { password1, password2 } = passwords;
    try {
        const walletData = { seed, address };
        const { z, v1, s1, v2, s2, v3, s3 } = await e5(walletData, password1, password2);
        const encryptedFile = { z, v1, s1, v2, s2, v3, s3 };
        const blob = new Blob([JSON.stringify(encryptedFile)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ML_${address.slice(0, 5)}_encrypted.json`;
        a.click();
        URL.revokeObjectURL(url);
        log('Encrypted wallet file downloaded successfully.');
    } catch (error) {
        log(`Error saving encrypted wallet file: ${error.message}`);
    }
}
async function downloadUnencryptedWallet(inputText, locationTag) {
    log('Attempting to download unencrypted wallet file...');

    if (isWalletFreshlyCreated && inputText && locationTag) {
        try {
            const dataBlock = { seed: inputText, address: locationTag };
            const blob = new Blob([JSON.stringify(dataBlock, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `ML_${locationTag.slice(0, 5)}_unencrypted.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            log('Unencrypted wallet file downloaded successfully. Store this file securely offline.');
            return;
        } catch (error) {
            log(`Error saving unencrypted wallet file: ${error.message}`);
            return;
        }
    }

    if (contentCache && displayTimer) {
        const passwords = await showPasswordModal();
        if (!passwords) {
            log('Error: Password entry cancelled. Cannot download unencrypted wallet.');
            return;
        }
        const { password1, password2 } = passwords;

        try {
            const cachedCredentials = await decryptPasswordsInMemory();
            if (password1 !== cachedCredentials.password1 || password2 !== cachedCredentials.password2) {
                log('Error: Incorrect passwords. Cannot download unencrypted wallet.');
                return;
            }

            let parsedText = await fetchRenderContent();
            const dataBlock = { seed: parsedText, address: globalAddress };
            const blob = new Blob([JSON.stringify(dataBlock, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `ML_${globalAddress.slice(0, 5)}_unencrypted.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            log('Unencrypted wallet file downloaded successfully after password verification. Store this file securely offline.');

            parsedText = crypto.getRandomValues(new Uint8Array(32));
            parsedText = crypto.getRandomValues(new Uint8Array(32));
            parsedText = crypto.getRandomValues(new Uint8Array(32));
            parsedText = null;
        } catch (error) {
            log(`Error during unencrypted wallet download: ${error.message}`);
        }
    } else {
        log('Error: Cannot download unencrypted wallet. Either create a new wallet or load an encrypted wallet first.');
    }
}

async function saveWalletFile() {
    log(`saveWalletFile: Starting - contentCache=${!!contentCache}, displayTimer=${!!displayTimer}, globalAddress=${globalAddress}`);
    
    if (!contentCache || !displayTimer || !globalAddress) {
        log('Error: No wallet loaded. Please create or load a wallet first.');
        return;
    }

    let seed;
    try {
        log('Fetching seed from secure cache...');
        seed = await fetchRenderContent();
        log(`Seed fetched successfully: ${seed ? 'Present' : 'Missing'}`);
    } catch (error) {
        log(`Error fetching seed: ${error.message}`);
        return;
    }

    const address = globalAddress;
    if (!seed || !address) {
        log(`Error: Seed and address are required to save the wallet. Seed=${!!seed}, Address=${address}`);
        return;
    }

    log('Showing password modal...');
    const passwords = await showPasswordModal();
    if (!passwords) {
        log('Error: Password entry cancelled.');
        return;
    }
    const { password1, password2 } = passwords;
    log('Passwords entered successfully.');

    try {
        const walletData = { seed, address };
        log('Encrypting wallet data with Argon2 shell...');
        const { z, v1, s1, v2, s2, v3, s3 } = await e5(walletData, password1, password2);
        const encryptedFile = { z, v1, s1, v2, s2, v3, s3 };
        const blob = new Blob([JSON.stringify(encryptedFile)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ML_${address.slice(0, 5)}.json`;
        log('Initiating file download...');
        a.click();
        URL.revokeObjectURL(url);
        log('Wallet file saved successfully (triple-encrypted with Argon2 shell).');
    } catch (error) {
        log(`Error saving wallet file: ${error.message}`);
    }
}


function clearWalletData() {
    const seedInput = document.getElementById('seed');
    const addressInput = document.getElementById('address');
    const warningContainer = document.getElementById('wallet-warning');

    if (seedInput) seedInput.value = '';
    if (addressInput) addressInput.value = '';
    if (warningContainer) {
        warningContainer.innerHTML = `
            <h3>Wallet Data Cleared from Display</h3>
            <p>The wallet data has been cleared from the display. Memory remains intact for further actions (e.g., saving or transactions).</p>
        `;
    }
    log(`clearWalletData: UI cleared - contentCache=${!!contentCache}, displayTimer=${!!displayTimer}, globalAddress=${globalAddress}`);
}
function resetAllWalletData() {
    clearSensitiveData();
    const accountAddress = document.getElementById('account-address');
    const assetGrid = document.getElementById('asset-grid');
    if (accountAddress) {
        accountAddress.textContent = 'Address: -';
    } else {
        log('Warning: #account-address element not found during reset.');
    }
    
    if (assetGrid) {
        assetGrid.innerHTML = '';
    } else {
        log('Warning: #asset-grid element not found during reset.');
    }
    log('The lab is clean chief scientist!');
}

async function loadUnencryptedWalletFile(event) {
    log('loadUnencryptedWalletFile: Starting');
    const file = event.target.files[0];
    if (!file) {
        log('No file selected.');
        return;
    }
    const fileNameDisplay = document.getElementById('unencryptedFileName');
    if (fileNameDisplay) {
        fileNameDisplay.textContent = file.name;
    }
    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            log('Parsing unencrypted wallet file...');
            const data = JSON.parse(e.target.result);
            if (!data.seed || !data.address) {
                log('Error: Invalid unencrypted wallet file format. Expected seed and address.');
                return;
            }
            log(`Loaded wallet - Address: ${data.address}, Seed: ${data.seed.slice(0, 6)}...`);

            const seedBox = document.getElementById('seed');
            const addrBox = document.getElementById('address');
            seedBox.type = 'text';
            addrBox.type = 'password';
            seedBox.value = 'Seed Loaded (Not Displayed)';
            addrBox.value = data.address;
            globalAddress = data.address;

            log(`Pre-updateDisplayData: contentCache=${!!contentCache}, displayTimer=${!!displayTimer}`);
            try {
                await updateDisplayData(data.seed);
                log(`Post-updateDisplayData: contentCache=${!!contentCache}, displayTimer=${!!displayTimer}`);
            } catch (error) {
                log(`Error in updateDisplayData: ${error.message}`);
                return;
            }

            isWalletFreshlyCreated = false;
            log('Wallet loaded from unencrypted file');

            const alertPanel = document.getElementById('wallet-warning');
            if (alertPanel) {
                alertPanel.innerHTML = `
                    <h3>Wallet Loaded (Unencrypted)</h3>
                    <p>Your wallet has been loaded from an unencrypted file. The address is displayed above.</p>
                    <p>Click below to view the address QR code (safe to share for funding):</p>
                    <div class="qr-buttons">
                        <button class="green-btn" onclick="showQRCode('address', '${data.address}')">Show Address QR Code</button>
                    </div>
                    <p>Save it encrypted for security:</p>
                    <button class="red-black-btn" onclick="saveWalletFile()">Save Wallet</button>
                    <p>Connecting to the server and checking balance...</p>
                `;
                alertPanel.style.display = 'block';
            }

            await connectWebSocket();
            await checkBalance();

            log('Overwriting temporary seed data...');
            data.seed = crypto.getRandomValues(new Uint8Array(32));
            data.seed = crypto.getRandomValues(new Uint8Array(32));
            data.seed = crypto.getRandomValues(new Uint8Array(32));
            data = null;
        } catch (error) {
            log(`Error: Failed to load unencrypted wallet file: ${error.message}`);
        }
    };
    reader.onerror = function() {
        log('Error reading unencrypted wallet file.');
    };
    reader.readAsText(file);
}

async function e5(data, p1, p2) {
    const encoder = new TextEncoder();
    try {
        const s1 = crypto.getRandomValues(new Uint8Array(16));
        const v1 = crypto.getRandomValues(new Uint8Array(12));
        const k1 = await deriveKey(p1, s1);
        const l1 = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: v1 },
            k1,
            encoder.encode(JSON.stringify(data))
        );

        const s2 = crypto.getRandomValues(new Uint8Array(16));
        const v2 = crypto.getRandomValues(new Uint8Array(12));
        const k2 = await deriveKey(p2, s2);
        const l2 = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: v2 },
            k2,
            l1
        );

        const s3 = crypto.getRandomValues(new Uint8Array(16));
        const v3 = crypto.getRandomValues(new Uint8Array(12));
        const combinedPassword = p1 + p2;
        const k3 = await b2(s3, combinedPassword);
        const l3 = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: v3 },
            k3,
            l2
        );

        log('Wallet encrypted with Argon2 shell and dual-password layers');
        return {
            z: arrayBufferToBase64(l3),
            v1: arrayBufferToBase64(v1),
            s1: arrayBufferToBase64(s1),
            v2: arrayBufferToBase64(v2),
            s2: arrayBufferToBase64(s2),
            v3: arrayBufferToBase64(v3),
            s3: arrayBufferToBase64(s3)
        };
    } catch (error) {
        throw new Error(`Encryption failed: ${error.message}`);
    }
}

async function f6(z, v1, s1, v2, s2, v3, s3, p1, p2) {
    const decoder = new TextDecoder();
    try {
        const combinedPassword = p1 + p2;
        const k3 = await b2(new Uint8Array(base64ToArrayBuffer(s3)), combinedPassword);
        const l3 = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(base64ToArrayBuffer(v3)) },
            k3,
            base64ToArrayBuffer(z)
        );

        const k2 = await deriveKey(p2, new Uint8Array(base64ToArrayBuffer(s2)));
        const l2 = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(base64ToArrayBuffer(v2)) },
            k2,
            l3
        );

        const k1 = await deriveKey(p1, new Uint8Array(base64ToArrayBuffer(s1)));
        const l1 = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(base64ToArrayBuffer(v1)) },
            k1,
            l2
        );

        return JSON.parse(decoder.decode(l1));
    } catch (error) {
        throw new Error(`Decryption failed: ${error.message}`);
    }
}
async function f6(z, v1, s1, v2, s2, v3, s3, p1, p2) {
    const decoder = new TextDecoder();
    try {
 
        const combinedPassword = p1 + p2;
        const k3 = await b2(new Uint8Array(base64ToArrayBuffer(s3)), combinedPassword);
        const l3 = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(base64ToArrayBuffer(v3)) },
            k3,
            base64ToArrayBuffer(z)
        );

 
        const k2 = await deriveKey(p2, new Uint8Array(base64ToArrayBuffer(s2)));
        const l2 = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(base64ToArrayBuffer(v2)) },
            k2,
            l3
        );

 
        const k1 = await deriveKey(p1, new Uint8Array(base64ToArrayBuffer(s1)));
        const l1 = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(base64ToArrayBuffer(v1)) },
            k1,
            l2
        );

        return JSON.parse(decoder.decode(l1));
    } catch (error) {
        throw new Error(`Decryption failed: ${error.message}`);
    }
}

async function calculateTotalObjects(address) {
    try {
        const accountObjects = await client.request({ command: "account_objects", account: address, ledger_index: "current" });
        return accountObjects.result.account_objects.length;
    } catch (error) {
        log(`Error calculating total objects: ${error.message}`);
        throw error;
    }
}

async function calculateTotalReserve(address, additionalObjects = 0) {
    try {
        const accountLines = await client.request({ command: "account_lines", account: address, ledger_index: "current" });
        const trustlineCount = accountLines.result.lines.length;

        const totalObjects = await calculateTotalObjects(address) + additionalObjects;

        let ownerReserveXrp = 0;
        if (totalObjects > 2) {
            ownerReserveXrp = totalObjects * TRUSTLINE_RESERVE_XRP;
        }

        const totalReserveXrp = BASE_RESERVE_XRP + ownerReserveXrp;
        return totalReserveXrp;
    } catch (error) {
        log(`Error calculating total reserve: ${error.message}`);
        throw error;
    }
}


async function queueTransaction() {
    try {
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-transactions');
        if (!contentCache || !displayTimer) {
            log('Error: No wallet loaded.');
            if (errorElement) errorElement.textContent = 'No wallet loaded.';
            return;
        }
        if (!address || !xrpl.isValidAddress(address)) {
            log('Error: Invalid address.');
            if (errorElement) errorElement.textContent = 'Invalid address.';
            return;
        }

        const destinationAddress = document.getElementById('send-destination')?.value;
        if (!destinationAddress || !xrpl.isValidAddress(destinationAddress)) {
            log('Error: Invalid destination address.');
            if (errorElement) errorElement.textContent = 'Invalid destination address.';
            return;
        }

        const sendAssetSelect = document.getElementById('send-asset-select');
        if (!sendAssetSelect) {
            log('Error: Send asset dropdown not found in DOM.');
            if (errorElement) errorElement.textContent = 'Send Transactions section not loaded.';
            return;
        }

        const selectedAssetName = sendAssetSelect.value;
        const amountInput = document.getElementById('send-amount');
        const amount = parseFloat(amountInput?.value);
        if (!amount || amount <= 0 || isNaN(amount)) {
            log('Error: Invalid amount.');
            if (errorElement) errorElement.textContent = 'Invalid amount.';
            return;
        }

        const destinationTagInput = document.getElementById('send-destination-tag')?.value.trim();
        let destinationTag = null;
        if (destinationTagInput) {
            destinationTag = parseInt(destinationTagInput);
            if (isNaN(destinationTag) || destinationTag < 0 || destinationTag > 4294967295) {
                log('Error: Invalid Destination Tag. Must be a number between 0 and 4294967295.');
                if (errorElement) errorElement.textContent = 'Invalid Destination Tag.';
                return;
            }
        }

        const memo = document.getElementById('send-memo')?.value;
        const isMegaSend = document.getElementById('schedule-tx-transactions')?.checked;
        const sendCount = isMegaSend ? 5 : 1;

        await ensureConnected();
        const seed = await fetchRenderContent();
        const wallet = xrpl.Wallet.fromSeed(seed);

        const selectedOption = sendAssetSelect.options[sendAssetSelect.selectedIndex];
        const isLPToken = selectedOption.getAttribute('data-is-lp') === 'true';
        const currencyHex = isLPToken ? selectedOption.getAttribute('data-currency-hex') : null;
        const issuer = isLPToken ? selectedOption.getAttribute('data-issuer') : null;

        let asset = selectedAssetName === "XRP" ? null : getAssetByName(selectedAssetName);
        if (isLPToken) {
            if (!currencyHex || !issuer) {
                log('Error: Missing ledger data for LP token.');
                if (errorElement) errorElement.textContent = 'Invalid LP token data.';
                return;
            }
            asset = { hex: currencyHex, issuer: issuer };

            const accountLines = await client.request({
                command: "account_lines",
                account: address,
                ledger_index: "current"
            });
            const senderLine = accountLines.result.lines.find(line => line.currency === asset.hex && line.account === asset.issuer);
            if (!senderLine || parseFloat(senderLine.balance) < amount) {
                log(`Error: Insufficient ${selectedAssetName} balance. Available: ${senderLine ? senderLine.balance : 0}`);
                if (errorElement) errorElement.textContent = `Insufficient balance: ${senderLine ? senderLine.balance : 0}`;
                return;
            }

            const destLines = await client.request({
                command: "account_lines",
                account: destinationAddress,
                ledger_index: "current"
            });
            const destLine = destLines.result.lines.find(line => line.currency === asset.hex && line.account === asset.issuer);
            if (!destLine) {
                log(`Error: Destination has no trustline for ${selectedAssetName}.`);
                if (errorElement) errorElement.textContent = `Destination needs a trustline for ${selectedAssetName}.`;
                return;
            }
            const destBalance = parseFloat(destLine.balance) || 0;
            const destLimit = parseFloat(destLine.limit) || 0;
            if (destLimit !== 0 && (destBalance + amount) > destLimit) {
                log(`Error: Destination trustline limit too low. Current: ${destBalance}/${destLimit}, Needed: ${destBalance + amount}`);
                if (errorElement) errorElement.textContent = `Destination trustline limit too low: ${destLimit}. Needs at least ${Math.ceil(destBalance + amount)}.`;
                return;
            }
        }

        const formattedAmount = asset ? amount.toFixed(6) : xrpl.xrpToDrops(amount.toString());
        const sendMax = asset ? (amount * 1.001).toFixed(6) : xrpl.xrpToDrops((amount * 1.001).toString());

        for (let i = 0; i < sendCount; i++) {
            const tx = {
                TransactionType: "Payment",
                Account: address,
                Destination: destinationAddress,
                Amount: asset ? {
                    currency: asset.hex,
                    issuer: asset.issuer,
                    value: formattedAmount
                } : formattedAmount
            };
            if (asset) {
                tx.SendMax = {
                    currency: asset.hex,
                    issuer: asset.issuer,
                    value: sendMax
                };
            }
            if (memo) {
                tx.Memos = [{ Memo: { MemoData: stringToHex(memo), MemoType: stringToHex("Memo") } }];
            }
            if (destinationTag !== null) {
                tx.DestinationTag = destinationTag;
            }
            const description = `Send ${amount} ${selectedAssetName} to ${destinationAddress}${memo ? ` with memo "${memo}"` : ''}${isMegaSend ? ` (Transaction ${i + 1}/5)` : ''}`;
            const txEntry = {
                tx: tx,
                wallet: wallet,
                description: description,
                delayMs: 0,
                type: "payment",
                queueElementId: "transaction-queue-transactions"
            };
            transactionQueue.push(txEntry);
            log(`Transaction added to queue: ${description}. Current queue length: ${transactionQueue.length}`);
        }

        updateTransactionQueueDisplay();
        if (!isProcessingQueue) processTransactionQueue();
    } catch (error) {
        log(`Error queuing transaction: ${error.message}`);
        if (errorElement) errorElement.textContent = `Error: ${error.message}`;
    }
}

async function queueMegaTransaction() {
    console.log("queueMegaTransaction() called");
    try {
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-transactions');

        if (!contentCache || !displayTimer) {
            log('Error: No wallet loaded. Load a wallet in the Wallet Management section.');
            errorElement.textContent = 'No wallet loaded.';
            return;
        }
        if (!xrpl.isValidAddress(address)) {
            log('Error: Invalid address. Load a valid wallet in the Wallet Management section.');
            errorElement.textContent = 'Invalid address.';
            return;
        }

        const preEther = spawnEtherNoise(4);
        window.etherPreFlux = preEther;

        const destination = document.getElementById('send-destination').value;
        const amount = document.getElementById('send-amount').value;
        const currency = document.getElementById('send-asset-select').value;
        const destinationTagInput = document.getElementById('send-destination-tag').value.trim();
        let destinationTag = null;
        if (destinationTagInput) {
            destinationTag = parseInt(destinationTagInput);
            if (isNaN(destinationTag) || destinationTag < 0 || destinationTag > 4294967295) {
                log('Error: Invalid Destination Tag. Must be a number between 0 and 4294967295.');
                errorElement.textContent = 'Invalid Destination Tag.';
                return;
            }
        }
        const memo = document.getElementById('send-memo').value;

        if (!xrpl.isValidAddress(destination)) {
            log('Error: Invalid destination address.');
            errorElement.textContent = 'Invalid destination address.';
            return;
        }
        if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
            log('Error: Invalid amount.');
            errorElement.textContent = 'Invalid amount.';
            return;
        }

        const confirmed = await showMegaTransactionConfirmationModal(amount, currency, destination, memo);
        if (!confirmed) {
            log('Mega transaction cancelled by user.');
            return;
        }

        const seed = await fetchRenderContent();
        const wallet = xrpl.Wallet.fromSeed(seed);
        if (wallet.classicAddress !== address) {
            log('Error: Seed does not match address.');
            errorElement.textContent = 'Seed does not match address.';
            return;
        }

        const tx = {
            TransactionType: "Payment",
            Account: address,
            Destination: destination,
            Fee: "12"
        };

        if (currency === "XRP") {
            await ensureConnected();
            const { availableBalanceXrp } = await calculateAvailableBalance(address);
            const transactionFeeXrp = parseFloat(xrpl.dropsToXrp("12"));
            const amountXrp = parseFloat(amount);
            const totalRequiredXrp = (amountXrp + transactionFeeXrp) * 5;

            if (totalRequiredXrp > availableBalanceXrp) {
                log(`Error: Insufficient available balance for 5 transactions. Available: ${formatBalance(availableBalanceXrp)} XRP`);
                errorElement.textContent = `Insufficient available balance for 5 transactions. Available: ${formatBalance(availableBalanceXrp)} XRP`;
                return;
            }
            tx.Amount = xrpl.xrpToDrops(amount);
        } else {
            const asset = getAssetByName(currency);
            if (!asset) {
                log('Error: Asset not found.');
                errorElement.textContent = 'Asset not found.';
                return;
            }
            await ensureConnected();
            const accountLines = await client.request({ command: "account_lines", account: address, ledger_index: "current" });
            const trustline = accountLines.result.lines.find(line => line.currency === asset.hex && line.account === asset.issuer);
            if (!trustline || parseFloat(trustline.balance) < parseFloat(amount) * 5) {
                log(`Error: Insufficient ${currency} balance for 5 transactions. Available: ${trustline ? formatBalance(trustline.balance) : 0} ${currency}`);
                errorElement.textContent = `Insufficient ${currency} balance for 5 transactions`;
                return;
            }
            tx.Amount = { currency: asset.hex, value: amount, issuer: asset.issuer };
            tx.Flags = xrpl.PaymentFlags.tfPartialPayment;
        }

        if (memo) {
            tx.Memos = [{ Memo: { MemoData: stringToHex(memo), MemoType: stringToHex("Memo") } }];
        }
        if (destinationTag !== null) {
            tx.DestinationTag = destinationTag;
        }

        const scheduleCheckbox = document.getElementById('schedule-tx-transactions');
        const delayInput = document.getElementById('schedule-delay-transactions');
        let delayMs = 0;

        if (scheduleCheckbox.checked && delayInput.value) {
            const delayMinutes = parseInt(delayInput.value);
            if (isNaN(delayMinutes) || delayMinutes <= 0) {
                log('Error: Invalid delay time.');
                errorElement.textContent = 'Invalid delay time.';
                return;
            }
            delayMs = delayMinutes * 10 * 1000;
            log(`Scheduling transactions to be sent in ${delayMinutes} minutes...`);
        }

        for (let i = 0; i < 5; i++) {
            const txEntry = {
                tx: { ...tx },
                wallet: wallet,
                description: `Send ${amount} ${currency} to ${destination}${memo ? ` with memo "${memo}"` : ''} (Mega Send ${i + 1}/5)`,
                delayMs: delayMs + (i * 10000),
                type: "payment",
                queueElementId: "transaction-queue-transactions"
            };
            transactionQueue.push(txEntry);
            log(`Transaction ${i + 1}/5 added to queue: ${txEntry.description}. Current queue length: ${transactionQueue.length}`);
        }

        updateTransactionQueueDisplay();
        if (!isProcessingQueue) processTransactionQueue();
    } catch (error) {
        log(`Mega transaction error: ${error.message}`);
    }
}

async function queueTrustlineTransaction() {
    try {
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-trustlines');

        if (!contentCache || !displayTimer) {
            log('Error: No wallet loaded. Load a wallet in the Wallet Management section.');
            errorElement.textContent = 'No wallet loaded.';
            return;
        }
        if (!xrpl.isValidAddress(address)) {
            log('Error: Invalid address. Load a valid wallet in the Wallet Management section.');
            errorElement.textContent = 'Invalid address.';
            return;
        }

        const preEther = spawnEtherNoise(4);
        window.etherPreFlux = preEther;

        const issuer = document.getElementById('trust-issuer').value;
        const currency = document.getElementById('trust-currency').value;
        const limit = document.getElementById('trust-limit').value;

        if (!issuer || !currency || !limit) {
            log('Error: Missing trustline fields.');
            errorElement.textContent = 'Fill all trustline fields.';
            return;
        }
        if (!xrpl.isValidAddress(issuer)) {
            log('Error: Invalid issuer address.');
            errorElement.textContent = 'Invalid issuer address.';
            return;
        }
        if (parseFloat(limit) < 0) {
            log('Error: Trustline limit must be non-negative.');
            errorElement.textContent = 'Trustline limit must be non-negative.';
            return;
        }

        if (parseFloat(limit) === 0) {
            const confirmStasis = confirm("Warning: Setting the trustline limit to 0 will place any tokens you hold in stasis, preventing sending or receiving. You can undo this later by setting a proper limit. Proceed?");
            if (!confirmStasis) {
                log('Trustline setting cancelled.');
                return;
            }
        }

        const seed = await fetchRenderContent();
        const wallet = xrpl.Wallet.fromSeed(seed);
        if (wallet.classicAddress !== address) {
            log('Error: Seed does not match address.');
            errorElement.textContent = 'Seed does not match address.';
            return;
        }

        const { availableBalanceXrp } = await calculateAvailableBalance(address, 1);
        const transactionFeeXrp = xrpl.dropsToXrp(TRANSACTION_FEE_DROPS);
        const totalRequiredXrp = transactionFeeXrp;

        if (totalRequiredXrp > availableBalanceXrp) {
            log(`Error: Insufficient available balance to set trustline. Available: ${formatBalance(availableBalanceXrp)} XRP, Required: ${formatBalance(totalRequiredXrp)} XRP (Fee: ${transactionFeeXrp} XRP).`);
            errorElement.textContent = `Insufficient available balance. Available: ${formatBalance(availableBalanceXrp)} XRP.`;
            return;
        }

        const tx = {
            TransactionType: "TrustSet",
            Account: address,
            LimitAmount: { currency: currency, issuer: issuer, value: limit },
            Fee: TRANSACTION_FEE_DROPS
        };

        const scheduleCheckbox = document.getElementById('schedule-tx-trustlines');
        const delayInput = document.getElementById('schedule-delay-trustlines');
        let delayMs = 0;

        if (scheduleCheckbox.checked && delayInput.value) {
            const delayMinutes = parseInt(delayInput.value);
            if (isNaN(delayMinutes) || delayMinutes <= 0) {
                log('Error: Invalid delay time.');
                errorElement.textContent = 'Invalid delay time.';
                return;
            }
            delayMs = delayMinutes * 60 * 1000;
            log(`Scheduling trustline transaction to be sent in ${delayMinutes} minutes...`);
        }

        const txEntry = {
            tx: tx,
            wallet: wallet,
            description: `Set trustline for ${xrpl.convertHexToString(currency).replace(/\0/g, '')} (Issuer: ${issuer}) with limit ${limit}`,
            delayMs: delayMs,
            type: "trustline",
            queueElementId: "trustline-queue"
        };

        transactionQueue.push(txEntry);
        log(`Trustline transaction added to queue. Current queue length: ${transactionQueue.length}`);
        updateTransactionQueueDisplay();

        if (!isProcessingQueue) processTransactionQueue();
    } catch (error) {
        log(`Trustline queue error: ${error.message}`);
    }
}

async function queueAccountDeleteTransaction() {
    try {
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-deletion');

        if (!contentCache || !displayTimer) {
            log('Error: No wallet loaded. Load a wallet in the Wallet Management section.');
            errorElement.textContent = 'No wallet loaded.';
            return;
        }
        if (!xrpl.isValidAddress(address)) {
            log('Error: Invalid address. Load a valid wallet in the Wallet Management section.');
            errorElement.textContent = 'Invalid address.';
            return;
        }

        const preEther = spawnEtherNoise(4);
        window.etherPreFlux = preEther;

        const destination = document.getElementById('delete-destination').value.trim();
        if (!xrpl.isValidAddress(destination)) {
            log('Error: Invalid destination address.');
            errorElement.textContent = 'Invalid destination address.';
            return;
        }
        if (destination === address) {
            log('Error: Destination address cannot be the same as the account being deleted.');
            errorElement.textContent = 'Destination address cannot be the same as the account.';
            return;
        }

        const accountInfo = await client.request({ command: "account_info", account: address, ledger_index: "current" });
        const balanceXrp = xrpl.dropsToXrp(accountInfo.result.account_data.Balance);
        const sequence = accountInfo.result.account_data.Sequence;

        const ledgerInfo = await client.request({ command: "ledger_current" });
        const currentLedgerIndex = ledgerInfo.result.ledger_current_index;

        const accountObjects = await client.request({ command: "account_objects", account: address, ledger_index: "current" });
        const ownedObjects = accountObjects.result.account_objects;

        const accountLines = await client.request({ command: "account_lines", account: address, ledger_index: "current" });
        const trustlines = accountLines.result.lines;

        const trustlineCount = trustlines.length;
        const totalReserveXrp = BASE_RESERVE_XRP + (trustlineCount * TRUSTLINE_RESERVE_XRP);

        const sequenceRequirementMet = sequence <= (currentLedgerIndex - 256);
        if (!sequenceRequirementMet) {
            log(`Error: Sequence number (${sequence}) is too high. It must be at least 256 less than the current ledger index (${currentLedgerIndex}). Wait for more ledgers to close.`);
            errorElement.textContent = 'Sequence number too high. Wait for more ledgers to close.';
            return;
        }

        const transactionFeeXrp = ACCOUNT_DELETE_FEE_XRP;
        const minimumBalanceXrp = totalReserveXrp + transactionFeeXrp;
        const balanceSufficient = parseFloat(balanceXrp) >= minimumBalanceXrp;
        if (!balanceSufficient) {
            log(`Error: Insufficient balance (${balanceXrp} XRP). Minimum required: ${minimumBalanceXrp} XRP (Reserve: ${totalReserveXrp} XRP, Fee: ${transactionFeeXrp} XRP).`);
            errorElement.textContent = 'Insufficient balance to cover reserve and fee.';
            return;
        }

        const noOwnedObjects = ownedObjects.length === 0;
        if (!noOwnedObjects) {
            log(`Error: Account owns objects (${ownedObjects.length}). Delete all trustlines, offers, and other objects before deleting the account.`);
            errorElement.textContent = 'Account owns objects. Delete all objects first.';
            return;
        }

        try {
            await client.request({ command: "account_info", account: destination, ledger_index: "current" });
        } catch (error) {
            if (error.message.includes("actNotFound")) {
                log(`Error: Destination account (${destination}) does not exist on the ledger.`);
                errorElement.textContent = 'Destination account does not exist.';
                return;
            }
            throw error;
        }

        const remainingXrp = Math.max(0, parseFloat(balanceXrp) - totalReserveXrp - transactionFeeXrp);
        log(`Expected XRP to be sent to destination after deletion: ${remainingXrp} XRP (Balance: ${balanceXrp} XRP, Reserve: ${totalReserveXrp} XRP, Fee: ${transactionFeeXrp} XRP)`);

        const confirmMessage = `WARNING: This will PERMANENTLY delete the account ${address} and send its remaining XRP (${formatBalance(remainingXrp)} XRP, after subtracting the reserve of ${totalReserveXrp} XRP and the transaction fee of ${transactionFeeXrp} XRP) to ${destination}. This action is IRREVERSIBLE. Are you sure you want to proceed?`;
        if (!confirm(confirmMessage)) {
            log('Account deletion cancelled by user.');
            return;
        }

        const seed = await fetchRenderContent();
        const wallet = xrpl.Wallet.fromSeed(seed);
        if (wallet.classicAddress !== address) {
            log('Error: Seed does not match address.');
            errorElement.textContent = 'Seed does not match address.';
            return;
        }

        const tx = {
            TransactionType: "AccountDelete",
            Account: address,
            Destination: destination,
            Fee: xrpl.xrpToDrops(ACCOUNT_DELETE_FEE_XRP)
        };

        const scheduleCheckbox = document.getElementById('schedule-tx-deletion');
        const delayInput = document.getElementById('schedule-delay-deletion');
        let delayMs = 0;

        if (scheduleCheckbox.checked && delayInput.value) {
            const delayMinutes = parseInt(delayInput.value);
            if (isNaN(delayMinutes) || delayMinutes <= 0) {
                log('Error: Invalid delay time.');
                errorElement.textContent = 'Invalid delay time.';
                return;
            }
            delayMs = delayMinutes * 60 * 1000;
            log(`Scheduling account deletion transaction to be sent in ${delayMinutes} minutes...`);
        }

        const txEntry = {
            tx: tx,
            wallet: wallet,
            description: `Delete account ${address} and send remaining XRP to ${destination}`,
            delayMs: delayMs,
            type: "deletion",
            queueElementId: "deletion-queue"
        };

        transactionQueue.push(txEntry);
        log(`Account deletion transaction added to queue. Current queue length: ${transactionQueue.length}`);
        updateTransactionQueueDisplay();

        if (!isProcessingQueue) processTransactionQueue();
    } catch (error) {
        log(`Account deletion queue error: ${error.message}`);
    }
}

async function queueNukeTrustline() {
    try {
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-nuke');

        if (!contentCache || !displayTimer) {
            log('Error: No wallet loaded. Load a wallet in the Wallet Management section.');
            errorElement.textContent = 'No wallet loaded.';
            return;
        }
        if (!xrpl.isValidAddress(address)) {
            log('Error: Invalid address. Load a valid wallet in the Wallet Management section.');
            errorElement.textContent = 'Invalid address.';
            return;
        }

        const preEther = spawnEtherNoise(4);
        window.etherPreFlux = preEther;

        const nukeAssetSelect = document.getElementById('nuke-asset-select');
        const selectedAssetName = nukeAssetSelect.value;
        const asset = getAssetByName(selectedAssetName);

        if (!asset || selectedAssetName === "XRP") {
            log('Error: Cannot nuke XRP or invalid asset selected.');
            errorElement.textContent = 'Cannot nuke XRP or invalid asset.';
            return;
        }

        await ensureConnected();
        const accountLines = await client.request({ command: "account_lines", account: address, ledger_index: "current" });
        const trustline = accountLines.result.lines.find(line => line.currency === asset.hex && line.account === asset.issuer);
        
        if (!trustline) {
            log(`Error: No trustline exists for ${asset.name}.`);
            errorElement.textContent = `No trustline exists for ${asset.name}.`;
            return;
        }

        const fullBalance = parseFloat(trustline.balance);
        const issuer = asset.issuer;
        const isZeroBalance = fullBalance === 0;

        const warningMessage = isZeroBalance
            ? `☢️ Asset does not require a nuke, but we will nuke it anyways! 💥 This will close the trustline for ${asset.name}. Proceed with caution!`
            : `☢️ WARNING: This will send ALL ${fullBalance} ${asset.name} back to ${issuer} (burning it if blackholed) and then close the trustline. This is IRREVERSIBLE and will completely remove the trustline. Proceed with caution! 💥\n\nAre you sure you want to NUKE this trustline?`;
        if (!confirm(warningMessage)) {
            log('Nuke trustline cancelled by user.');
            return;
        }

        const seed = await fetchRenderContent();
        const wallet = xrpl.Wallet.fromSeed(seed);
        if (wallet.classicAddress !== address) {
            log('Error: Seed does not match address.');
            errorElement.textContent = 'Seed does not match address.';
            return;
        }

        const { availableBalanceXrp } = await calculateAvailableBalance(address, 1);
        const transactionFeeXrp = xrpl.dropsToXrp(TRANSACTION_FEE_DROPS);
        const totalRequiredXrp = isZeroBalance ? transactionFeeXrp : transactionFeeXrp * 2;
        if (totalRequiredXrp > availableBalanceXrp) {
            log(`Error: Insufficient XRP for fees. Available: ${formatBalance(availableBalanceXrp)} XRP, Required: ${formatBalance(totalRequiredXrp)} XRP`);
            errorElement.textContent = `Insufficient XRP for fees. Available: ${formatBalance(availableBalanceXrp)} XRP`;
            return;
        }

        const closeTx = {
            TransactionType: "TrustSet",
            Account: address,
            LimitAmount: { currency: asset.hex, issuer: issuer, value: "0" },
            Fee: TRANSACTION_FEE_DROPS,
            Flags: xrpl.TrustSetFlags.tfClearNoRipple
        };

        if (isZeroBalance) {
            const closeTxEntry = {
                tx: closeTx,
                wallet: wallet,
                description: `☢️ Nuke Trustline: Close trustline for ${asset.name} (Issuer: ${issuer}) - No balance to send!`,
                delayMs: 0,
                type: "trustline",
                queueElementId: "transaction-queue-transactions"
            };
            transactionQueue.push(closeTxEntry);
            log(`Nuke trustline transaction queued: Close trustline for ${asset.name} (zero balance). Queue length: ${transactionQueue.length}`);
        } else {
            const sendTx = {
                TransactionType: "Payment",
                Account: address,
                Destination: issuer,
                Amount: { currency: asset.hex, value: trustline.balance, issuer: issuer },
                Fee: TRANSACTION_FEE_DROPS,
                Flags: xrpl.PaymentFlags.tfPartialPayment
            };

            const sendTxEntry = {
                tx: sendTx,
                wallet: wallet,
                description: `💥 Nuke Trustline: Send ${trustline.balance} ${asset.name} to issuer ${issuer}`,
                delayMs: 0,
                type: "payment",
                queueElementId: "transaction-queue-transactions"
            };

            const closeTxEntry = {
                tx: closeTx,
                wallet: wallet,
                description: `☢️ Nuke Trustline: Close trustline for ${asset.name} (Issuer: ${issuer})`,
                delayMs: 15000,
                type: "trustline",
                queueElementId: "transaction-queue-transactions"
            };

            transactionQueue.push(sendTxEntry);
            transactionQueue.push(closeTxEntry);
            log(`Nuke trustline transactions queued: Send ${trustline.balance} ${asset.name} to issuer, then close trustline. Queue length: ${transactionQueue.length}`);
        }

        updateTransactionQueueDisplay();
        if (!isProcessingQueue) processTransactionQueue();
    } catch (error) {
        log(`Nuke trustline error: ${error.message}`);
        document.getElementById('address-error-nuke').textContent = `Error: ${error.message}`;
    }
}

async function setTrustline(txEntry) {
    try {
        await ensureConnected();
        const { tx, wallet } = txEntry;

        tx.Flags = xrpl.TrustSetFlags.tfSetNoRipple;

        const preparedTrustSet = await client.autofill(tx);
        const ledgerInfo = await client.request({ command: "ledger_current" });
        const currentLedger = ledgerInfo.result.ledger_current_index;
        preparedTrustSet.LastLedgerSequence = currentLedger + 50;
        const signedTrustSet = wallet.sign(preparedTrustSet);
        log('Submitting Trustline transaction...');
        const startTimeTrustSet = Date.now();
        const trustSetResult = await Promise.race([
            client.submitAndWait(signedTrustSet.tx_blob),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Trustline transaction submission timed out')), 30000))
        ]);
        const endTimeTrustSet = Date.now();
        log(`Trustline transaction submission took ${(endTimeTrustSet - startTimeTrustSet) / 1000} seconds`);
        log(`Trustline Transaction Hash: ${trustSetResult.result.hash}`);

        if (trustSetResult.result.meta.TransactionResult !== "tesSUCCESS") {
            log(`Trustline failed: ${trustSetResult.result.meta.TransactionResult}`);
            if (trustSetResult.result.meta.TransactionResult === "tefNO_AUTH_REQUIRED") log('Info: No authorization required for this Trustline.');
            return;
        }

        log('Trustline set successfully with No Ripple flag enabled.');

        const accountLines = await client.request({ command: "account_lines", account: tx.Account, ledger_index: "current" });
        const newTrustline = accountLines.result.lines.find(line => line.currency === tx.LimitAmount.currency && line.account === tx.LimitAmount.issuer);
        if (newTrustline) {
            if (parseFloat(newTrustline.balance) < 0) {
                log('Warning: Trustline balance is negative. The No Ripple flag may not be applied due to XRPL restrictions.');
            } else {
                log(`Trustline balance: ${formatBalance(newTrustline.balance)}. No Ripple flag should be active.`);
            }
        } else {
            log('Trustline successfully closed and removed from account lines.');
        }

        await checkBalance();
    } catch (error) {
        log(`Trustline error: ${error.message || 'Unknown error occurred'}`);
        throw error;
    }
}

async function closeTrustline() {
    try {
        await ensureConnected();
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-trustlines');

        if (!contentCache || !displayTimer) {
            log('Error: No wallet loaded. Load a wallet in the Wallet Management section.');
            errorElement.textContent = 'No wallet loaded.';
            return;
        }
        if (!xrpl.isValidAddress(address)) {
            log('Error: Invalid address. Load a valid wallet in the Wallet Management section.');
            errorElement.textContent = 'Invalid address.';
            return;
        }

        const preEther = spawnEtherNoise(4);
        window.etherPreFlux = preEther;

        const issuer = document.getElementById('trust-issuer').value;
        const currency = document.getElementById('trust-currency').value;

        if (!issuer || !currency) {
            log('Error: Missing fields.');
            errorElement.textContent = 'Fill Issuer and Hex Code.';
            return;
        }

        const seed = await fetchRenderContent();
        const wallet = xrpl.Wallet.fromSeed(seed);
        if (wallet.classicAddress !== address) {
            log('Error: Seed does not match address.');
            errorElement.textContent = 'Seed does not match address.';
            return;
        }

        const trustSet = {
            TransactionType: "TrustSet",
            Account: address,
            LimitAmount: { currency: currency, issuer: issuer, value: "0" },
            Fee: TRANSACTION_FEE_DROPS,
            Flags: 131072
        };

        const prepared = await client.autofill(trustSet);
        const ledgerInfo = await client.request({ command: "ledger_current" });
        const currentLedger = ledgerInfo.result.ledger_current_index;
        prepared.LastLedgerSequence = currentLedger + 50;
        const signed = wallet.sign(prepared);
        log('Submitting Trustline closure transaction...');
        const startTime = Date.now();
        const result = await Promise.race([
            client.submitAndWait(signed.tx_blob),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Transaction submission timed out')), 30000))
        ]);
        const endTime = Date.now();
        log(`Transaction submission took ${(endTime - startTime) / 1000} seconds`);

        if (result.result.meta.TransactionResult === "tesSUCCESS") {
            log('Trustline closed successfully');
            await checkBalance();

            const postEther = spawnEtherNoise(5);
            window.etherPostFlux = postEther;

            await resecureCache();
        } else {
            log(`Trustline closure failed: ${result.result.meta.TransactionResult}`);
            if (result.result.meta.TransactionResult === "tefNO_AUTH_REQUIRED") log('Info: No authorization required for this Trustline.');
        }
    } catch (error) {
        log(`Close trustline error: ${error.message || 'Unknown error occurred'}`);
    }
}

async function processTransactionQueue() {
    if (transactionQueue.length === 0) {
        isProcessingQueue = false;
        log('Queue is empty. Processing stopped.');
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

        log(`Ensuring connection before processing: ${description}`);
        await Promise.race([
            ensureConnected(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 10000))
        ]);
        log(`Connection ensured, proceeding with transaction: ${description}`);

        if (type === "swap") {
            log('Processing swap transaction...');
            await executeSwap(txEntry);
        } else if (type === "trustline") {
            log('Processing trustline transaction...');
            await setTrustline(txEntry);
        } else if (type === "domain") {
            log('Processing domain transaction...');
            const prepared = await client.autofill(txEntry.tx);
            const ledgerInfo = await client.request({ command: "ledger_current" });
            const currentLedger = ledgerInfo.result.ledger_current_index;
            prepared.LastLedgerSequence = currentLedger + 50;
            const signed = txEntry.wallet.sign(prepared);
            log(`Submitting transaction: ${description}`);
            const result = await client.submitAndWait(signed.tx_blob);
            if (result.result.meta.TransactionResult === "tesSUCCESS") {
                log(`Transaction succeeded: ${description}`);
                await fetchDomain();
            } else {
                log(`Transaction failed: ${description} - ${result.result.meta.TransactionResult}`);
                throw new Error(`Transaction failed: ${result.result.meta.TransactionResult}`);
            }
        } else if (type === "deletion") {
            log('Processing deletion transaction...');
            const prepared = await client.autofill(txEntry.tx);
            const ledgerInfo = await client.request({ command: "ledger_current" });
            const currentLedger = ledgerInfo.result.ledger_current_index;
            prepared.LastLedgerSequence = currentLedger + 50;
            const signed = txEntry.wallet.sign(prepared);
            log(`Submitting transaction: ${description}`);
            const result = await client.submitAndWait(signed.tx_blob, { failHard: true });
            if (result.result.meta.TransactionResult === "tesSUCCESS") {
                log(`Transaction succeeded: ${description}`);
                clearWalletData();
            } else {
                log(`Transaction failed: ${description} - ${result.result.meta.TransactionResult}`);
                throw new Error(`Transaction failed: ${result.result.meta.TransactionResult}`);
            }
        } else if (type === "signerlist") {
            log('Processing signerlist transaction...');
            await processSignerListSet(txEntry);
        } else if (type === "multisign") {
            log('Processing multisign transaction...');
            await processMultiSignTransaction(txEntry);
        } else if (type === "regularkey") {
            log('Processing regularkey transaction...');
            const prepared = await client.autofill(txEntry.tx);
            const ledgerInfo = await client.request({ command: "ledger_current" });
            const currentLedger = ledgerInfo.result.ledger_current_index;
            prepared.LastLedgerSequence = currentLedger + 50;
            const signed = txEntry.wallet.sign(prepared);
            log(`Submitting transaction: ${description}`);
            const result = await client.submitAndWait(signed.tx_blob);
            if (result.result.meta.TransactionResult === "tesSUCCESS") {
                log(`Transaction succeeded: ${description}`);
                await fetchRegularKey();
            } else {
                log(`Transaction failed: ${description} - ${result.result.meta.TransactionResult}`);
                throw new Error(`Transaction failed: ${result.result.meta.TransactionResult}`);
            }
        } else if (type === "offercreate" || type === "offercancel") {
            log('Processing offer transaction...');
            const prepared = await client.autofill(txEntry.tx);
            const ledgerInfo = await client.request({ command: "ledger_current" });
            const currentLedger = ledgerInfo.result.ledger_current_index;
            prepared.LastLedgerSequence = currentLedger + 50;
            const signed = txEntry.wallet.sign(prepared);
            log(`Submitting transaction: ${description}`);
            const result = await client.submitAndWait(signed.tx_blob);
            if (result.result.meta.TransactionResult === "tesSUCCESS") {
                log(`Transaction succeeded: ${description}`);
                await fetchOffers();
            } else {
                log(`Transaction failed: ${description} - ${result.result.meta.TransactionResult}`);
                throw new Error(`Transaction failed: ${result.result.meta.TransactionResult}`);
            }
        } else if (type === "escrowcreate") {
            log('Processing escrow create transaction...');
            const prepared = await client.autofill(txEntry.tx);
            const ledgerInfo = await client.request({ command: "ledger_current" });
            const currentLedger = ledgerInfo.result.ledger_current_index;
            prepared.LastLedgerSequence = currentLedger + 50;
            const signed = txEntry.wallet.sign(prepared);
            log(`Submitting transaction: ${description}`);
            const result = await client.submitAndWait(signed.tx_blob);
            if (result.result.meta.TransactionResult === "tesSUCCESS") {
                log(`Transaction succeeded: ${description}`);
                log(`Transaction Hash: ${result.result.hash}`);
                const sequence = result.result.Sequence;
                log(`Sequence Number (Save!): ${sequence}`);
                document.getElementById('escrow-sequence').textContent = `Sequence Number: ${sequence}`;
                await checkBalance();
                const postEther = spawnEtherNoise(5);
                window.etherPostFlux = postEther;
                await resecureCache();
            } else {
                log(`Transaction failed: ${description} - ${result.result.meta.TransactionResult}`);
                throw new Error(`Transaction failed: ${result.result.meta.TransactionResult}`);
            }
        } else if (type === "escrowfinish" || type === "escrowcancel") {
            log(`Processing escrow ${type} transaction...`);
            const prepared = await client.autofill(txEntry.tx);
            const ledgerInfo = await client.request({ command: "ledger_current" });
            const currentLedger = ledgerInfo.result.ledger_current_index;
            prepared.LastLedgerSequence = currentLedger + 50;
            const signed = txEntry.wallet.sign(prepared);
            log(`Submitting transaction: ${description}`);
            const result = await client.submitAndWait(signed.tx_blob);
            if (result.result.meta.TransactionResult === "tesSUCCESS") {
                log(`Transaction succeeded: ${description}`);
                log(`Transaction Hash: ${result.result.hash}`);
                await checkBalance();
                const postEther = spawnEtherNoise(5);
                window.etherPostFlux = postEther;
                await resecureCache();
            } else {
                log(`Transaction failed: ${description} - ${result.result.meta.TransactionResult}`);
                throw new Error(`Transaction failed: ${result.result.meta.TransactionResult}`);
            }
        } else {
            log('Processing payment transaction...');
            await processPaymentTransaction(txEntry);
        }

        transactionQueue.shift();
        log(`Transaction removed from queue. Remaining: ${transactionQueue.length}`);
        updateTransactionQueueDisplay();

        if (transactionQueue.length > 0) {
            log('Waiting 15 seconds before sending the next transaction...');
            await new Promise(resolve => setTimeout(resolve, 15000));
            await processTransactionQueue();
        } else {
            isProcessingQueue = false;
            log('Queue processing completed.');
        }
    } catch (error) {
        log(`Queue processing error: ${error.message}`);
        transactionQueue.shift();
        log(`Transaction failed and removed from queue. Remaining: ${transactionQueue.length}`);
        updateTransactionQueueDisplay();

        if (transactionQueue.length > 0) {
            log('Waiting 15 seconds before sending the next transaction...');
            await new Promise(resolve => setTimeout(resolve, 15000));
            await processTransactionQueue();
        } else {
            isProcessingQueue = false;
            log('Queue processing completed with errors.');
        }
    }
}


async function processPaymentTransaction(txEntry) {
    try {
        const { tx, wallet, description } = txEntry;
        log('Autofilling transaction...');
        const prepared = await client.autofill(tx);
        log(`Prepared transaction: ${JSON.stringify(prepared)}`);
        log('Fetching current ledger...');
        const ledgerInfo = await client.request({ command: "ledger_current" });
        const currentLedger = ledgerInfo.result.ledger_current_index;
        prepared.LastLedgerSequence = currentLedger + 100;
        log('Signing transaction...');

        let tempText = await fetchRenderContent();
        const activeWallet = xrpl.Wallet.fromSeed(tempText);
        const signed = activeWallet.sign(prepared);

        tempText = crypto.getRandomValues(new Uint8Array(32));
        tempText = crypto.getRandomValues(new Uint8Array(32));
        tempText = crypto.getRandomValues(new Uint8Array(32));
        tempText = null;

        log(`Submitting transaction: ${description}`);
        let result = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const startTime = Date.now();
                result = await Promise.race([
                    client.submitAndWait(signed.tx_blob),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Transaction submission timed out')), 15000))
                ]);
                const endTime = Date.now();
                log(`Transaction submission took ${(endTime - startTime) / 1000} seconds on attempt ${attempt}`);
                break;
            } catch (error) {
                log(`Submission attempt ${attempt} failed: ${error.message}`);
                if (attempt === 2) {
                    const submitResult = await client.submit(signed.tx_blob, { failHard: true });
                    log(`Raw submit response: ${JSON.stringify(submitResult)}`);
                    throw new Error(`Failed after 2 attempts: ${error.message}`);
                }
                log(`Retrying submission (attempt ${attempt + 1}/2)...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

        if (result.result.meta.TransactionResult === "tesSUCCESS") {
            log(`Transaction succeeded: ${description}`);
            log(`Transaction Hash: ${result.result.hash}`);
            await checkBalance();

            const postEther = spawnEtherNoise(5);
            window.etherPostFlux = postEther;
            await resecureCache();
        } else {
            log(`Transaction failed: ${description} - ${result.result.meta.TransactionResult}`);
            throw new Error(`Transaction failed: ${result.result.meta.TransactionResult}`);
        }
    } catch (error) {
        log(`Payment transaction error: ${error.message}`);
        throw error;
    }
}


function updateTransactionQueueDisplay() {
    const queueElements = {
        "transaction-queue-transactions": [],
        "transaction-queue-amm": [],
        "trustline-queue": [],
        "domain-queue": [],
        "deletion-queue": [],
        "regular-key-queue": [],
        "multisign-queue": [],
        "amm-swap-queue": []
    };

    transactionQueue.forEach((item, index) => {
        if (queueElements[item.queueElementId]) queueElements[item.queueElementId].push({ item, index });
    });

    for (const [queueId, items] of Object.entries(queueElements)) {
        const queueElement = document.getElementById(queueId);
        if (!queueElement) continue;
        queueElement.innerHTML = '<p>Transaction Queue:</p>';
        if (items.length === 0) {
            queueElement.innerHTML += '<p>No transactions in queue.</p>';
        } else {
            let cumulativeDelayMs = 0;
            items.forEach(({ item, index }) => {
                cumulativeDelayMs += item.delayMs;
                if (index > 0) cumulativeDelayMs += 15000;
                const delayText = item.delayMs > 0 ? ` (Scheduled in ${(cumulativeDelayMs / 60000).toFixed(2)} minutes)` : '';
                queueElement.innerHTML += `<p>${index + 1}. ${item.description}${delayText}</p>`;
            });
        }
    }
}

function toggleScheduleOptions(checkboxId, delayId) {
    const scheduleCheckbox = document.getElementById(checkboxId);
    const delayInput = document.getElementById(delayId);
    if (scheduleCheckbox && delayInput) delayInput.disabled = !scheduleCheckbox.checked;
}

function showTransactionConfirmationModal(amount, currency, destination, memo) {
    return new Promise((resolve) => {
        const existingModal = document.querySelector('.confirmation-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.className = 'password-modal-overlay confirmation-modal';
        modal.innerHTML = `
            <div class="password-modal-content">
                <h2>Confirm Transaction</h2>
                <p>You are going to send ${amount} ${currency} to ${destination}${memo ? ` with memo "${memo}"` : ''}.</p>
                <p>This action is IRREVERSIBLE.</p>
                <div class="modal-buttons">
                    <button class="green-btn" id="confirmTx">Send</button>
                    <button class="red-black-btn" id="cancelTx">Cancel</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.style.display = 'flex';

        const confirmButton = document.getElementById('confirmTx');
        const cancelButton = document.getElementById('cancelTx');

        const resolveAndCleanup = (result) => {
            modal.remove();
            resolve(result);
        };

        confirmButton.onclick = () => resolveAndCleanup(true);
        cancelButton.onclick = () => resolveAndCleanup(false);
    });
}

function showMegaTransactionConfirmationModal(amount, currency, destination, memo) {
    return new Promise((resolve) => {
        const existingModal = document.querySelector('.confirmation-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.className = 'password-modal-overlay confirmation-modal';
        modal.innerHTML = `
            <div class="password-modal-content">
                <h2>Confirm Mega Transaction</h2>
                <p>You are going to send this transaction 5 times: ${amount} ${currency} to ${destination}${memo ? ` with memo "${memo}"` : ''}.</p>
                <p>This action is IRREVERSIBLE.</p>
                <div class="modal-buttons">
                    <button class="green-btn" id="confirmMegaTx">Send x5</button>
                    <button class="red-black-btn" id="cancelMegaTx">Cancel</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.style.display = 'flex';

        const confirmButton = document.getElementById('confirmMegaTx');
        const cancelButton = document.getElementById('cancelMegaTx');

        const resolveAndCleanup = (result) => {
            modal.remove();
            resolve(result);
        };

        confirmButton.onclick = () => resolveAndCleanup(true);
        cancelButton.onclick = () => resolveAndCleanup(false);
    });
}

function formatBalance(value) {
    const num = parseFloat(value);
    if (isNaN(num)) return value;
    if (Math.abs(num) < 0.00001) return "0";
    return num.toFixed(5);
}

const prefabAssets = [
    { name: "Xoge", issuer: "rJMtvf5B3GbuFMrqybh5wYVXEH4QE8VyU1", hex: "586F676500000000000000000000000000000000" },
    { name: "RLUSD", issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", hex: "524C555344000000000000000000000000000000" },
    { name: "PUPU", issuer: "r4WfqR5DQ7PwPvVJv8Gism5cQBLGtNnvK8", hex: "5055505500000000000000000000000000000000" },
    { name: "Dood", issuer: "rn5Y9N8APtrc7PVqXdMjkG9qvfw7FWi4kC", hex: "446F6F6400000000000000000000000000000000" },
	{ name: "Schmeckles", issuer: "rPxw83ZP6thv7KmG5DpAW4cDW55DZRZ9wu", hex: "5363686D65636B6C657300000000000000000000" },
	{ name: "Casino Coin", issuer: "rCSCManTZ8ME9EoLrSHHYKW8PPwWMgkwr", hex: "CSC" },
	{ name: "Laugh", issuer: "r32nbPw6cyt3KdxinB4ua6WSLRrrF4SXAC", hex: "4C61756768000000000000000000000000000000" },
	{ name: "Sigma", issuer: "rfKYWZ84fm9eVEdoTcsQCo1WdqMPyaUF5z", hex: "5349474D41000000000000000000000000000000" },
	{ name: "666", issuer: "rhvf9fe6PP3GC8Bku2Ug7iQPjPDxYZfrxN", hex: "666" },
	{ name: "Xmeme", issuer: "r4UPddYeGeZgDhSGPkooURsQtmGda4oYQW", hex: "584D454D45000000000000000000000000000000" },
	{ name: "Reaper", issuer: "r3qWgpz2ry3BhcRJ8JE6rxM8esrfhuKp4R", hex: "RPR" },
	{ name: "Ascension", issuer: "r3qWgpz2ry3BhcRJ8JE6rxM8esrfhuKp4R", hex: "ASC" },
	{ name: "ARK", issuer: "rf5Jzzy6oAFBJjLhokha1v8pXVgYYjee3b", hex: "ARK" },
	{ name: "Pillars", issuer: "rNSYhWLhuHvmURwWbJPBKZMSPsyG5Qek17", hex: "PLR" },
	{ name: "Grind", issuer: "rDaDV5smdWjr8QcagD8UhbPZWzJBkdVAnH", hex: "GRD" },
    { name: "3RDEYE", issuer: "rHjyBqFM5oQvXu1soWtATC4r1V6GBnhCQQ", hex: "3352444559450000000000000000000000000000" },
    { name: "FWOGXRP", issuer: "rNm3VNJJ2PCmQFVDRpDR6N73UEtZh32HFi", hex: "46574F4758525000000000000000000000000000" },
    { name: "HAIC", issuer: "rsEXqMHTKDfGzncfJ25XtB9ZY8jayTv7N3", hex: "4841494300000000000000000000000000000000" }
];

let dexSwapDirection = 'sell';

async function queueSwapTransaction() {
    try {
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-amm');

        if (!contentCache || !displayTimer) {
            log('Error: No wallet loaded. Load a wallet in the Wallet Management section.');
            errorElement.textContent = 'No wallet loaded.';
            return;
        }
        if (!xrpl.isValidAddress(address)) {
            log('Error: Invalid address. Load a valid wallet in the Wallet Management section.');
            errorElement.textContent = 'Invalid address.';
            return;
        }

        const preEther = spawnEtherNoise(4);
        window.etherPreFlux = preEther;

        const inputAsset = document.getElementById('swap-input-asset').value;
        const outputAsset = document.getElementById('swap-output-asset').value;
        const amount = document.getElementById('swap-amount').value;
        const slippage = parseFloat(document.getElementById('swap-slippage').value) / 100;

        if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
            log('Error: Invalid amount.');
            errorElement.textContent = 'Invalid amount.';
            return;
        }
        if (isNaN(slippage) || slippage < 0) {
            log('Error: Invalid slippage.');
            errorElement.textContent = 'Invalid slippage.';
            return;
        }

        const now = Date.now();
        const timeDiff = ammState.lastPriceCheckTimestamp ? now - ammState.lastPriceCheckTimestamp : Infinity;
        if (!ammState.lastPoolPrice || timeDiff > 60000) {
            log(`Error: Pool price is outdated. Time since last check: ${timeDiff / 1000} seconds. Please check pool price again.`);
            errorElement.textContent = 'Pool price outdated. Check pool price.';
            return;
        }

        let asset, direction;
        if (inputAsset === "XRP" && outputAsset !== "XRP") {
            asset = getAssetByName(outputAsset);
            direction = "XRP-to-Token";
        } else if (outputAsset === "XRP" && inputAsset !== "XRP") {
            asset = getAssetByName(inputAsset);
            direction = "Token-to-XRP";
        } else {
            log('Error: One asset must be XRP.');
            errorElement.textContent = 'One asset must be XRP.';
            return;
        }

        if (!asset) {
            log('Error: Asset not found.');
            errorElement.textContent = 'Asset not found.';
            return;
        }

        const { poolXrp, poolToken } = ammState.lastPoolPrice;

        const seed = await fetchRenderContent();
        const wallet = xrpl.Wallet.fromSeed(seed);
        if (wallet.classicAddress !== address) {
            log('Error: Seed does not match address.');
            errorElement.textContent = 'Seed does not match address.';
            return;
        }

        let inputBalance;
        if (direction === "XRP-to-Token") {
            if (!cachedBalance || !cachedBalance.availableBalanceXrp || (now - cachedBalance.timestamp) >= 120000) {
                await ensureConnected();
                cachedBalance = await calculateAvailableBalance(address);
                cachedBalance.timestamp = now;
                log('Wallet current balance fetched.');
            }
            inputBalance = Math.max(0, cachedBalance.availableBalanceXrp - 1);
            const amountXrp = parseFloat(amount);
            const totalRequiredXrp = amountXrp + xrpl.dropsToXrp(TRANSACTION_FEE_DROPS);
            if (totalRequiredXrp > inputBalance) {
                log(`Error: Insufficient usable XRP balance. Usable: ${formatBalance(inputBalance)} XRP, Required: ${formatBalance(totalRequiredXrp)} XRP`);
                errorElement.textContent = `Insufficient usable XRP balance. Usable: ${formatBalance(inputBalance)} XRP`;
                return;
            }
        } else {
            const accountLines = await client.request({ command: "account_lines", account: address, ledger_index: "current" });
            const trustline = accountLines.result.lines.find(line => line.currency === asset.hex && line.account === asset.issuer);
            inputBalance = trustline ? parseFloat(trustline.balance) : 0;
            if (inputBalance < parseFloat(amount)) {
                log(`Error: Insufficient ${inputAsset} balance. Available: ${formatBalance(inputBalance)} ${inputAsset}`);
                errorElement.textContent = `Insufficient ${inputAsset} balance`;
                return;
            }
        }

        const tx = {
            TransactionType: "Payment",
            Account: address,
            Destination: address,
            Flags: xrpl.PaymentFlags.tfPartialPayment
        };

        let expectedOutputAsset;
        if (direction === "XRP-to-Token") {
            const sendMax = xrpl.xrpToDrops(amount);
            const expectedToken = parseFloat(amount) * (poolToken / poolXrp);
            const minToken = expectedToken * (1 - slippage);
            const roundedMinToken = minToken.toFixed(6);
            if (parseFloat(roundedMinToken) <= 0) {
                log('Error: Expected token amount must be positive after slippage.');
                errorElement.textContent = 'Expected token amount too low.';
                return;
            }
            tx.Amount = { currency: asset.hex, issuer: asset.issuer, value: roundedMinToken };
            tx.SendMax = sendMax;
            expectedOutputAsset = outputAsset;
        } else {
            const sendMaxValue = amount;
            const expectedXrp = parseFloat(amount) * (poolXrp / poolToken);
            const minXrp = expectedXrp * (1 - slippage);
            const roundedMinXrp = minXrp.toFixed(6);
            if (parseFloat(roundedMinXrp) <= 0) {
                log('Error: Expected XRP amount must be positive after slippage.');
                errorElement.textContent = 'Expected XRP amount too low.';
                return;
            }
            tx.Amount = xrpl.xrpToDrops(roundedMinXrp);
            tx.SendMax = { currency: asset.hex, issuer: asset.issuer, value: sendMaxValue };
            expectedOutputAsset = "XRP";
        }

        const txEntry = {
            tx: tx,
            wallet: wallet,
            description: `Swap ${amount} ${inputAsset} for ${outputAsset} (Min received with ${slippage * 100}% slippage)`,
            direction: direction,
            expectedOutputAsset: expectedOutputAsset,
            delayMs: 0,
            type: "swap",
            queueElementId: "transaction-queue-amm"
        };

        transactionQueue.push(txEntry);
        log(`Swap transaction added to queue: ${JSON.stringify(txEntry.tx)}. Current queue length: ${transactionQueue.length}`);
        updateTransactionQueueDisplay();

        if (!isProcessingQueue) processTransactionQueue();
    } catch (error) {
        log(`Swap queue error: ${error.message}`);
    }
}
async function executeSwap(txEntry) {
    try {
        await ensureConnected();
        const { tx, wallet } = txEntry;

        const preEther = spawnEtherNoise(4);
        window.etherPreFlux = preEther;

        const prepared = await client.autofill(tx);
        const ledgerInfo = await client.request({ command: "ledger_current" });
        const currentLedger = ledgerInfo.result.ledger_current_index;
        prepared.LastLedgerSequence = currentLedger + 300;
        const signed = wallet.sign(prepared);
        log('Submitting swap transaction...');
        const startTime = Date.now();
        const result = await Promise.race([
            client.submitAndWait(signed.tx_blob),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Transaction submission timed out')), 15000))
        ]);
        const endTime = Date.now();
        log(`Transaction submission took ${(endTime - startTime) / 1000} seconds`);

        if (result.result.meta.TransactionResult === "tesSUCCESS") {
            const deliveredAmount = result.result.meta.DeliveredAmount || result.result.meta.delivered_amount;
            if (deliveredAmount) {
                const deliveredValue = typeof deliveredAmount === 'string' ? xrpl.dropsToXrp(deliveredAmount) : deliveredAmount.value;
                const deliveredAsset = txEntry.expectedOutputAsset || "Unknown";
                log(`Swap succeeded: Received ${formatBalance(deliveredValue)} ${deliveredAsset}`);
                log(`Transaction Hash: ${result.result.hash}`);
                if (document.getElementById('swap-result')) {
                    document.getElementById('swap-result').innerHTML = `<p>Swap Result: Received ${formatBalance(deliveredValue)} ${deliveredAsset}</p>`;
                }
            } else {
                log('Swap succeeded, but delivered amount not available.');
                if (document.getElementById('swap-result')) document.getElementById('swap-result').innerHTML = '<p>Swap Result: Delivered amount not available</p>';
            }
            await checkBalance();

            const postEther = spawnEtherNoise(5);
            window.etherPostFlux = postEther;

            await resecureCache();
        } else {
            log(`Swap failed: ${result.result.meta.TransactionResult}`);
            throw new Error(`Swap failed with result: ${result.result.meta.TransactionResult}`);
        }
    } catch (error) {
        log(`Swap error: ${error.message}`);
        throw error;
    }
}
function populateOffer(gets, pays, buyAssetName, sellAssetName) {
    const buyAmountInput = document.getElementById('dex-buy-amount');
    const sellAmountInput = document.getElementById('dex-sell-amount');
    const buyAsset = document.getElementById('dex-buy-asset').value;

    const offerRow = event.target.closest('tr');
    if (offerRow.classList.contains('sell-offer')) {
        dexSwapDirection = 'buy';
        buyAmountInput.value = parseFloat(pays).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
        sellAmountInput.value = parseFloat(gets).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
        log(`Populated offer: Buy ${pays} ${buyAssetName} for ${gets} ${sellAssetName}`);
    } else if (offerRow.classList.contains('buy-offer')) {
        dexSwapDirection = 'sell';
        sellAmountInput.value = parseFloat(gets).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
        buyAmountInput.value = parseFloat(pays).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
        log(`Populated offer: Buy ${pays} ${buyAssetName} for ${gets} ${sellAssetName}`);
    }

    updateDexSwapStatement();
}

async function checkPoolPrice() {
    try {
        await ensureConnected();
        const inputAsset = document.getElementById('swap-input-asset')?.value;
        const outputAsset = document.getElementById('swap-output-asset')?.value;

        log(`Checking pool price for ${inputAsset}`);

        let asset, direction;
        if (inputAsset === "XRP" && outputAsset !== "XRP") {
            asset = getAssetByName(outputAsset);
            direction = "XRP-to-Token";
        } else if (outputAsset === "XRP" && inputAsset !== "XRP") {
            asset = getAssetByName(inputAsset);
            direction = "Token-to-XRP";
        } else {
            log('Error: One asset must be XRP.');
            document.getElementById('pool-info').innerHTML = '<p>Pool Reserves: Invalid pair</p><p>Pool Price: Invalid pair</p><p>Pool Fee: -</p>';
            return;
        }

        if (!asset) {
            log('Error: Asset not found.');
            document.getElementById('pool-info').innerHTML = '<p>Pool Reserves: Asset not found</p><p>Pool Price: Asset not found</p><p>Pool Fee: -</p>';
            return;
        }

        const ammInfo = await client.request({
            command: "amm_info",
            asset: inputAsset === "XRP" ? { currency: "XRP" } : { currency: asset.hex, issuer: asset.issuer },
            asset2: outputAsset === "XRP" ? { currency: "XRP" } : { currency: asset.hex, issuer: asset.issuer },
            ledger_index: "current"
        });

        if (!ammInfo.result.amm) {
            log('Error: AMM pool not found for this asset pair.');
            document.getElementById('pool-info').innerHTML = '<p>Pool Reserves: Not found</p><p>Pool Price: Not found</p><p>Pool Fee: -</p>';
            return;
        }

        let poolXrp, poolToken;
        if (direction === "XRP-to-Token") {
            const poolXrpDrops = parseFloat(ammInfo.result.amm.amount);
            poolXrp = xrpl.dropsToXrp(poolXrpDrops);
            poolToken = parseFloat(ammInfo.result.amm.amount2.value);
        } else {
            poolToken = parseFloat(ammInfo.result.amm.amount.value);
            const poolXrpDrops = parseFloat(ammInfo.result.amm.amount2);
            poolXrp = xrpl.dropsToXrp(poolXrpDrops);
        }

        if (isNaN(poolXrp) || isNaN(poolToken) || poolXrp <= 0 || poolToken <= 0) {
            log('Error: Invalid pool reserves.');
            document.getElementById('pool-info').innerHTML = '<p>Pool Reserves: Invalid reserves</p><p>Pool Price: Invalid reserves</p><p>Pool Fee: -</p>';
            return;
        }

        const priceXrpPerToken = poolXrp / poolToken;
        const priceTokenPerXrp = poolToken / poolXrp;

        const tradingFeeBasisPoints = ammInfo.result.amm.trading_fee || 0;
        const tradingFeePercent = (tradingFeeBasisPoints / 1000).toFixed(3); // Convert basis points to percentage

        ammState.lastPoolPrice = {
            poolXrp: poolXrp,
            poolToken: poolToken,
            direction: direction,
            assetName: asset.name
        };
        ammState.lastPriceCheckTimestamp = Date.now();

        if (globalAddress && xrpl.isValidAddress(globalAddress)) {
            try {
                cachedBalance = await calculateAvailableBalance(globalAddress);
                cachedBalance.timestamp = Date.now();
                log('Balance cached after checking pool price.');
            } catch (error) {
                log(`Error caching balance in checkPoolPrice: ${error.message}`);
                cachedBalance = { totalBalanceXrp: 0, totalReserveXrp: 0, availableBalanceXrp: 0, timestamp: 0 };
            }
        } else {
            log('No valid wallet address to cache balance.');
            cachedBalance = { totalBalanceXrp: 0, totalReserveXrp: 0, availableBalanceXrp: 0, timestamp: 0 };
        }

        const poolInfo = document.getElementById('pool-info');
        poolInfo.innerHTML = `
            <p>Pool Reserves: ${formatBalance(poolXrp)} XRP, ${formatBalance(poolToken)} ${asset.name}</p>
            <p>Pool Price: 1 XRP = ${formatBalance(priceTokenPerXrp)} ${asset.name}, 1 ${asset.name} = ${formatBalance(priceXrpPerToken)} XRP</p>
            <p>Pool Fee: ${tradingFeePercent}%</p>
        `;
        log(`Pool price checked successfully for ${inputAsset} to ${outputAsset}`);

        const slider = document.getElementById('swap-balance-slider');
        if (slider) {
            slider.disabled = false;
            await updateBalances();
            slider.disabled = false;
        }
    } catch (error) {
        log(`Check pool price error: ${error.message}`);
        document.getElementById('pool-info').innerHTML = '<p>Pool Reserves: Error</p><p>Pool Price: Error</p><p>Pool Fee: -</p>';
        ammState.lastPoolPrice = null;
        ammState.lastPriceCheckTimestamp = null;
        cachedBalance = { totalBalanceXrp: 0, totalReserveXrp: 0, availableBalanceXrp: 0, timestamp: 0 };
    }
}
function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

async function updateSwapAmountsFromSlider() {
    const slider = document.getElementById('swap-balance-slider');
    const percentage = parseFloat(slider.value);
    document.getElementById('slider-percentage').textContent = `${percentage}%`;

    const now = Date.now();
    const timeDiff = ammState.lastPriceCheckTimestamp ? now - ammState.lastPriceCheckTimestamp : Infinity;
    if (!ammState.lastPriceCheckTimestamp || timeDiff > 180000) {
        log('Error: Pool price is outdated. Please check pool price again.');
        slider.disabled = true;
        slider.value = 0;
        document.getElementById('slider-percentage').textContent = '0%';
        document.getElementById('swap-amount').value = '';
        document.getElementById('swap-output-amount').value = '';
        return;
    }

    if (!ammState.lastPoolPrice) {
        log('Error: No pool price available. Please check pool price.');
        slider.disabled = true;
        slider.value = 0;
        document.getElementById('slider-percentage').textContent = '0%';
        document.getElementById('swap-amount').value = '';
        document.getElementById('swap-output-amount').value = '';
        return;
    }

    const inputAsset = document.getElementById('swap-input-asset').value;
    const outputAsset = document.getElementById('swap-output-asset').value;
    let inputBalance;

    if (inputAsset === "XRP") {
        const address = globalAddress;
        if (!address || !xrpl.isValidAddress(address)) {
            log('Error: Invalid address for balance check.');
            slider.value = 0;
            document.getElementById('slider-percentage').textContent = '0%';
            document.getElementById('swap-amount').value = '';
            document.getElementById('swap-output-amount').value = '';
            return;
        }
        await ensureConnected();
        const { availableBalanceXrp } = await calculateAvailableBalance(address);
        inputBalance = Math.max(0, availableBalanceXrp - 1);
    } else {
        const inputAssetData = getAssetByName(inputAsset);
        if (!inputAssetData) {
            log(`Error: Input asset ${inputAsset} not found.`);
            slider.value = 0;
            document.getElementById('slider-percentage').textContent = '0%';
            document.getElementById('swap-amount').value = '';
            document.getElementById('swap-output-amount').value = '';
            return;
        }
        const inputAssetHex = inputAssetData.hex;
        const inputBalanceElement = document.getElementById('input-balance');
        if (!inputBalanceElement || !inputBalanceElement.textContent) {
            log('Error: Input balance element not found or empty.');
            slider.value = 0;
            document.getElementById('slider-percentage').textContent = '0%';
            document.getElementById('swap-amount').value = '';
            document.getElementById('swap-output-amount').value = '';
            return;
        }
        const balanceText = inputBalanceElement.textContent.replace('Balance: ', '').trim();
        inputBalance = parseFloat(balanceText);
        if (isNaN(inputBalance)) {
            log(`Error: Failed to parse input balance: "${balanceText}"`);
            slider.value = 0;
            document.getElementById('slider-percentage').textContent = '0%';
            document.getElementById('swap-amount').value = '';
            document.getElementById('swap-output-amount').value = '';
            return;
        }
    }

    if (isNaN(inputBalance) || inputBalance <= 0) {
        log('Error: Invalid input balance.');
        slider.value = 0;
        document.getElementById('slider-percentage').textContent = '0%';
        document.getElementById('swap-amount').value = '';
        document.getElementById('swap-output-amount').value = '';
        return;
    }

    const inputAmount = (percentage / 100) * inputBalance;
    const roundedInputAmount = inputAmount.toFixed(6);
    document.getElementById('swap-amount').value = roundedInputAmount;

    const { poolXrp, poolToken, direction } = ammState.lastPoolPrice;
    let expectedOutput;
    if (direction === "XRP-to-Token") {
        expectedOutput = parseFloat(roundedInputAmount) * (poolToken / poolXrp);
        expectedOutput = expectedOutput.toFixed(6);
        document.getElementById('swap-output-amount').value = expectedOutput;
    } else {
        expectedOutput = parseFloat(roundedInputAmount) * (poolXrp / poolToken);
        expectedOutput = expectedOutput.toFixed(6);
        document.getElementById('swap-output-amount').value = expectedOutput;
    }

    slider.disabled = false;
    document.getElementById('swap-result').innerHTML = '<p>Swap Result: -</p>';
}

async function updateSliderFromAmount() {
    const slider = document.getElementById('swap-balance-slider');
    const amountInput = document.getElementById('swap-amount');
    const percentageDisplay = document.getElementById('slider-percentage');
    const errorElement = document.getElementById('address-error-amm');

    const amount = parseFloat(amountInput.value);
    if (isNaN(amount) || amount <= 0) {
        log('Error: Invalid amount entered.');
        if (errorElement) errorElement.textContent = 'Invalid amount entered.';
        slider.value = 0;
        percentageDisplay.textContent = '0%';
        amountInput.value = '';
        document.getElementById('swap-output-amount').value = '';
        return;
    }

    const now = Date.now();
    const timeDiff = ammState.lastPriceCheckTimestamp ? now - ammState.lastPriceCheckTimestamp : Infinity;
    if (!ammState.lastPriceCheckTimestamp || timeDiff > 180000) {
        log('Error: Pool price is outdated. Please check pool price again.');
        if (errorElement) errorElement.textContent = 'Pool price is outdated. Please check pool price again.';
        slider.disabled = true;
        slider.value = 0;
        percentageDisplay.textContent = '0%';
        amountInput.value = '';
        document.getElementById('swap-output-amount').value = '';
        return;
    }

    if (!ammState.lastPoolPrice) {
        log('Error: No pool price available. Please check pool price.');
        if (errorElement) errorElement.textContent = 'No pool price available. Please check pool price.';
        slider.disabled = true;
        slider.value = 0;
        percentageDisplay.textContent = '0%';
        amountInput.value = '';
        document.getElementById('swap-output-amount').value = '';
        return;
    }

    const inputAsset = document.getElementById('swap-input-asset').value;
    let inputBalance;

    if (inputAsset === "XRP") {
        const address = globalAddress;
        if (!address || !xrpl.isValidAddress(address)) {
            log('Error: Invalid address for balance check.');
            if (errorElement) errorElement.textContent = 'Invalid address for balance check.';
            slider.value = 0;
            percentageDisplay.textContent = '0%';
            amountInput.value = '';
            document.getElementById('swap-output-amount').value = '';
            return;
        }
        await ensureConnected();
        const { availableBalanceXrp } = await calculateAvailableBalance(address);
        inputBalance = Math.max(0, availableBalanceXrp - 1);
    } else {
        const inputAssetData = getAssetByName(inputAsset);
        if (!inputAssetData) {
            log(`Error: Input asset ${inputAsset} not found.`);
            if (errorElement) errorElement.textContent = `Input asset ${inputAsset} not found.`;
            slider.value = 0;
            percentageDisplay.textContent = '0%';
            amountInput.value = '';
            document.getElementById('swap-output-amount').value = '';
            return;
        }
        const inputBalanceElement = document.getElementById('input-balance');
        if (!inputBalanceElement || !inputBalanceElement.textContent) {
            log('Error: Input balance element not found or empty.');
            if (errorElement) errorElement.textContent = 'Input balance element not found or empty.';
            slider.value = 0;
            percentageDisplay.textContent = '0%';
            amountInput.value = '';
            document.getElementById('swap-output-amount').value = '';
            return;
        }
        const balanceText = inputBalanceElement.textContent.replace('Balance: ', '').trim();
        inputBalance = parseFloat(balanceText);
        if (isNaN(inputBalance)) {
            log(`Error: Failed to parse input balance: "${balanceText}"`);
            if (errorElement) errorElement.textContent = `Failed to parse input balance: "${balanceText}"`;
            slider.value = 0;
            percentageDisplay.textContent = '0%';
            amountInput.value = '';
            document.getElementById('swap-output-amount').value = '';
            return;
        }
    }

    if (isNaN(inputBalance) || inputBalance <= 0) {
        log('Error: Invalid input balance.');
        if (errorElement) errorElement.textContent = 'Invalid input balance.';
        slider.value = 0;
        percentageDisplay.textContent = '0%';
        amountInput.value = '';
        document.getElementById('swap-output-amount').value = '';
        return;
    }

    const percentage = (amount / inputBalance) * 100;
    if (percentage > 100) {
        log('Error: Amount exceeds available balance.');
        if (errorElement) errorElement.textContent = `Amount exceeds available balance. Available: ${formatBalance(inputBalance)} ${inputAsset}`;
        slider.value = 0;
        percentageDisplay.textContent = '0%';
        amountInput.value = '';
        document.getElementById('swap-output-amount').value = '';
        return;
    }

    slider.value = percentage;
    slider.disabled = false;
    percentageDisplay.textContent = `${percentage.toFixed(2)}%`;

    const roundedInputAmount = amount.toFixed(6);
    amountInput.value = roundedInputAmount;

    const { poolXrp, poolToken, direction } = ammState.lastPoolPrice;
    let expectedOutput;
    if (direction === "XRP-to-Token") {
        expectedOutput = parseFloat(roundedInputAmount) * (poolToken / poolXrp);
        expectedOutput = expectedOutput.toFixed(6);
        document.getElementById('swap-output-amount').value = expectedOutput;
    } else {
        expectedOutput = parseFloat(roundedInputAmount) * (poolXrp / poolToken);
        expectedOutput = expectedOutput.toFixed(6);
        document.getElementById('swap-output-amount').value = expectedOutput;
    }

    document.getElementById('swap-result').innerHTML = '<p>Swap Result: -</p>';
    if (errorElement) errorElement.textContent = '';
}

async function connectWebSocket(serverOverride = null) {
    const serverSelect = document.getElementById('wss-server');
    const status = document.getElementById('connection-status');
    const server = serverOverride || serverSelect?.value;
    if (!server || !status || !serverSelect) return;

    if (client && client.isConnected()) {
        log('Already connected to XRPL server.');
        return;
    }

    if (isConnecting) {
        log('Connection attempt already in progress. Waiting...');
        return;
    }

    if (client) {
        await client.disconnect();
        client = null;
    }

    isConnecting = true;
    status.textContent = 'Connecting...';
    serverSelect.value = server;

    try {
        client = new xrpl.Client(server);
        await client.connect();
        status.textContent = 'Connected';
        log(`Connected to WSS Server.`);
        updateBalances();
    } catch (error) {
        log(`Connection failed to ${server}: ${error.message}`);
        status.textContent = 'Disconnected';
        client = null;
        throw error;
    } finally {
        isConnecting = false;
    }
}

async function disconnectWebSocket() {
    if (client && client.isConnected()) {
        await client.disconnect();
        client = null;
    }
    if (document.getElementById('connection-status')) document.getElementById('connection-status').textContent = 'Disconnected';
    const accountAddress = document.getElementById('account-address');
    const assetGrid = document.getElementById('asset-grid');
    const currentLimitDisplay = document.getElementById('current-trust-limit');
    const currentDomainDisplay = document.getElementById('current-domain');
    const currentRegularKeyDisplay = document.getElementById('current-regular-key');
    const currentSignerListDisplay = document.getElementById('current-signer-list');
    const ledgerIndexDisplay = document.getElementById('ledger-index');
    const ledgerCloseTimeDisplay = document.getElementById('ledger-close-time');
    const validatorStatsDisplay = document.getElementById('validator-stats');
    const amendmentVotingDisplay = document.getElementById('amendment-voting');
    const currentOffersDisplay = document.getElementById('current-offers');

    if (accountAddress) accountAddress.textContent = 'Address: -';
    if (assetGrid) assetGrid.innerHTML = '';
    if (currentLimitDisplay) currentLimitDisplay.textContent = 'Current Trustline Limit: None';
    if (currentDomainDisplay) currentDomainDisplay.textContent = 'Current Domain: None';
    if (currentRegularKeyDisplay) currentRegularKeyDisplay.textContent = 'Current Regular Key: None';
    if (currentSignerListDisplay) currentSignerListDisplay.textContent = 'Current Signer List: None';
    if (ledgerIndexDisplay) ledgerIndexDisplay.textContent = '-';
    if (ledgerCloseTimeDisplay) ledgerCloseTimeDisplay.textContent = '-';
    if (validatorStatsDisplay) validatorStatsDisplay.innerHTML = '<p>No validator data available.</p>';
    if (amendmentVotingDisplay) amendmentVotingDisplay.innerHTML = '<p>No amendment data available.</p>';
    if (currentOffersDisplay) currentOffersDisplay.innerHTML = '<p>No offers available.</p>';

    log('Disconnected from XRPL server');
    updateBalances();
}

async function ensureConnected() {
    if (client && client.isConnected()) return;

    if (isConnecting) {
        log('Waiting for existing connection attempt to complete...');
        while (isConnecting) await new Promise(resolve => setTimeout(resolve, 100));
        if (client && client.isConnected()) return;
    }

    log('Not connected. Connecting...');
    await connectWebSocket();
    if (!client || !client.isConnected()) throw new Error('Failed to connect to XRPL server');
}


async function calculateAvailableBalance(address, additionalTrustlines = 0) {
    try {
        const serverInfo = await client.request({ command: "server_info" });
        const reserveBaseXrp = xrpl.dropsToXrp(serverInfo.result.info.validated_ledger.reserve_base);
        const reserveIncXrp = xrpl.dropsToXrp(serverInfo.result.info.validated_ledger.reserve_inc);
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

        const totalBalanceXrp = xrpl.dropsToXrp(accountInfo.result.account_data.Balance);
        const trustlines = accountLines.result.lines.length + additionalTrustlines;
        const totalReserveXrp = parseFloat(reserveBaseXrp) + (trustlines * parseFloat(reserveIncXrp));
        const availableBalanceXrp = parseFloat(totalBalanceXrp) - totalReserveXrp;

        return { totalBalanceXrp, totalReserveXrp, availableBalanceXrp };
    } catch (error) {
        log(`If this is a new account you will need to fund it and that will activate it: ${error.message}`);
        throw error;
    }
}

async function updateNukeAssetDetails(forceFetch = false) {
    const nukeAssetSelect = document.getElementById('nuke-asset-select');
    const selectedAssetName = nukeAssetSelect.value;
    const asset = getAssetByName(selectedAssetName);
    const balanceDisplay = document.getElementById('nuke-asset-balance');
    const address = globalAddress;

    if (!asset || selectedAssetName === "XRP") {
        balanceDisplay.textContent = 'Current Balance: -';
        return;
    }

    if (!forceFetch) {
        balanceDisplay.textContent = 'Current Balance: -';
        return;
    }

    if (xrpl.isValidAddress(address) && client && client.isConnected()) {
        try {
            const accountLines = await client.request({ command: "account_lines", account: address, ledger_index: "current" });
            const trustline = accountLines.result.lines.find(line => line.currency === asset.hex && line.account === asset.issuer);
            if (trustline) {
                balanceDisplay.textContent = `Current Balance: ${trustline.balance} ${asset.name}`;
            } else {
                balanceDisplay.textContent = `Current Balance: 0 ${asset.name} (No Trustline)`;
            }
        } catch (error) {
            log(`Error fetching balance for ${asset.name}: ${error.message}`);
            balanceDisplay.textContent = 'Current Balance: Unable to fetch';
        }
    } else {
        balanceDisplay.textContent = 'Current Balance: Connect and load a wallet';
    }
}

let availableBalanceXrp = 0;

async function calculateAvailableBalance(address, additionalTrustlines = 0) {
    try {
        const serverInfo = await client.request({ command: "server_info" });
        const validatedLedger = serverInfo?.result?.info?.validated_ledger;
        if (!validatedLedger || !validatedLedger.reserve_base_xrp || !validatedLedger.reserve_inc_xrp) {
            log(`Invalid server info: ${JSON.stringify(serverInfo)}`);
            return { totalBalanceXrp: 0, totalReserveXrp: 0, availableBalanceXrp: 0 };
        }

        const reserveBaseXrp = validatedLedger.reserve_base_xrp;
        const reserveIncXrp = validatedLedger.reserve_inc_xrp;

        const accountInfo = await client.request({
            command: "account_info",
            account: address,
            ledger_index: "current"
        });

        if (!accountInfo?.result?.account_data?.Balance) {
            log(`Invalid account info for ${address}: ${JSON.stringify(accountInfo)}`);
            return { totalBalanceXrp: 0, totalReserveXrp: 0, availableBalanceXrp: 0 };
        }

        const accountLines = await client.request({
            command: "account_lines",
            account: address,
            ledger_index: "current"
        });

        const balanceDrops = accountInfo.result.account_data.Balance;
        if (!balanceDrops || !/^-?[0-9]+$/.test(balanceDrops)) {
            log(`Invalid balance for ${address}: ${balanceDrops}`);
            return { totalBalanceXrp: 0, totalReserveXrp: 0, availableBalanceXrp: 0 };
        }

        const totalBalanceXrp = xrpl.dropsToXrp(balanceDrops);
        const trustlines = accountLines?.result?.lines?.length || 0 + additionalTrustlines;
        const totalReserveXrp = parseFloat(reserveBaseXrp) + (trustlines * parseFloat(reserveIncXrp));
        const availableBalanceXrpLocal = parseFloat(totalBalanceXrp) - totalReserveXrp;

        availableBalanceXrp = availableBalanceXrpLocal;

        return { totalBalanceXrp, totalReserveXrp, availableBalanceXrp: availableBalanceXrpLocal };
    } catch (error) {
        log(`Error calculating available balance - If this is a new account you will need to fund it first: ${error.message}`);
        return { totalBalanceXrp: 0, totalReserveXrp: 0, availableBalanceXrp: 0 };
    }
}

let globalLPTokens = [];

async function checkBalance() {
    const errorElement = document.getElementById('address-error');
    try {
        await ensureConnected();
        const address = globalAddress;
        const accountAddress = document.getElementById('account-address');
        const assetGrid = document.getElementById('asset-grid');

        if (!xrpl.isValidAddress(address)) {
            if (errorElement) errorElement.textContent = 'Invalid XRPL address.';
            log('Error: Invalid XRPL address.');
            return;
        }

        if (errorElement) errorElement.textContent = '';

        const { totalBalanceXrp, totalReserveXrp, availableBalanceXrp } = await calculateAvailableBalance(address);

        const accountLines = await client.request({
            command: "account_lines",
            account: address,
            ledger_index: "current"
        });

        dynamicAssets = [];
        globalLPTokens = [];
        for (const line of accountLines.result.lines) {
            const currencyHex = line.currency;
            const issuer = line.account;
            const lpName = await decodeLPToken(currencyHex, issuer);
            if (lpName) {
                globalLPTokens.push({
                    lpName: lpName,
                    currency: currencyHex,
                    issuer: issuer,
                    balance: parseFloat(line.balance)
                });
                dynamicAssets.push({ name: lpName, issuer: issuer, hex: currencyHex, isLP: true });
            } else {
                const currencyName = xrpl.convertHexToString(currencyHex).replace(/\0/g, '') || currencyHex;
                if (!prefabAssets.some(a => a.hex === currencyHex)) {
                    dynamicAssets.push({ name: currencyName, issuer: issuer, hex: currencyHex, isLP: false });
                }
            }
        }
        log(`Updated globalLPTokens: ${JSON.stringify(globalLPTokens)}`);

        if (accountAddress && assetGrid) {
            accountAddress.innerHTML = `Address: <a href="https://xrpscan.com/account/${address}" class="address-link" target="_blank">${address}</a>`;
            assetGrid.innerHTML = `
                <div class="asset-item">
                    <span class="asset-name">XRP</span>
                    <div class="asset-balance">
                        Total: ${formatBalance(totalBalanceXrp)} XRP<br>
                        Reserve: ${formatBalance(totalReserveXrp)} XRP<br>
                        Available: ${formatBalance(availableBalanceXrp)} XRP
                    </div>
                </div>
            `;

            for (const line of accountLines.result.lines) {
                const currencyHex = line.currency;
                let assetName = xrpl.convertHexToString(currencyHex).replace(/\0/g, '') || `[HEX:${currencyHex.slice(0, 8)}]`;
                const issuer = line.account;
                const lpName = await decodeLPToken(currencyHex, issuer);
                if (lpName) {
                    assetName = lpName;
                }

                const issuerLink = `<a href="https://xrpscan.com/account/${issuer}" class="address-link" target="_blank"><span class="asset-name">${assetName}</span></a>`;
                assetGrid.innerHTML += `
                    <div class="asset-item">
                        ${issuerLink}
                        <div class="asset-balance">${formatBalance(line.balance)}</div>
                    </div>
                `;
            }
        } else {
            log('Error: UI elements (account-address or asset-grid) not found.');
        }

        log('Wallet balance checked.');
        updateBalances();
        selectTrustAsset();
        await new Promise(resolve => setTimeout(resolve, 100));
        populateAssetDropdowns();
    } catch (error) {
        log(`Error checking balance: ${error.message}`);
        if (errorElement) errorElement.textContent = 'Failed to check balance';
        throw error;
    }
}

function populateAssetDropdowns() {
    if (!prefabAssets || !Array.isArray(prefabAssets)) {
        log('Error: prefabAssets is not defined or not an array.');
        return;
    }
    if (!dynamicAssets || !Array.isArray(dynamicAssets)) {
        log('Warning: dynamicAssets is not defined or not an array, proceeding with prefabAssets only.');
        dynamicAssets = [];
    }

    const combinedAssets = [...prefabAssets, ...dynamicAssets.filter(da => !prefabAssets.some(pa => pa.hex === da.hex))];
    combinedAssets.sort((a, b) => a.name.localeCompare(b.name));

    const nonLPAssets = combinedAssets.filter(asset => !asset.isLP);

    const dropdowns = [
        { id: 'send-asset-select', defaultValue: 'XRP', useNonLP: true },
        { id: 'trust-asset-select', defaultValue: combinedAssets.length > 0 ? combinedAssets[0].name : 'XRP', useNonLP: false },
        { id: 'nuke-asset-select', defaultValue: combinedAssets.length > 0 ? combinedAssets[0].name : 'XRP', useNonLP: false },
        { id: 'swap-input-asset', defaultValue: 'XRP', useNonLP: true },
        { id: 'swap-output-asset', defaultValue: nonLPAssets.length > 0 ? nonLPAssets[0].name : 'XRP', useNonLP: true },
        { id: 'lp-asset1', defaultValue: 'XRP', useNonLP: true },
        { id: 'lp-asset2', defaultValue: nonLPAssets.length > 0 ? nonLPAssets[0].name : 'XRP', useNonLP: true }
    ];

    dropdowns.forEach(({ id, defaultValue, useNonLP }) => {
        const select = document.getElementById(id);
        if (!select) {
            log(`Warning: Dropdown with ID ${id} not found in DOM.`);
            return;
        }

        const currentValue = select.value || defaultValue;
        select.innerHTML = '';

        const assetsToUse = useNonLP ? nonLPAssets : combinedAssets;
        if (id !== 'trust-asset-select' && id !== 'nuke-asset-select') {
            const xrpOption = document.createElement('option');
            xrpOption.value = "XRP";
            xrpOption.textContent = "XRP";
            if (id === 'send-asset-select') {
                xrpOption.setAttribute('data-is-lp', 'false');
            }
            select.appendChild(xrpOption);
        }

        assetsToUse.forEach(asset => {
            const option = document.createElement('option');
            option.value = asset.name;
            option.textContent = asset.name;
            if (id === 'send-asset-select') {
                option.setAttribute('data-is-lp', asset.isLP ? 'true' : 'false');
                if (asset.isLP) {
                    option.setAttribute('data-currency-hex', asset.hex);
                    option.setAttribute('data-issuer', asset.issuer);
                }
            }
            select.appendChild(option);
        });

        select.value = assetsToUse.some(a => a.name === currentValue) || currentValue === "XRP" ? currentValue : defaultValue;
    });

    selectSendAsset();
    selectTrustAsset(false);
    updateNukeAssetDetails(false);
    updateSwapDirection();
}

function getAssetByName(assetName) {
    if (assetName === "XRP") {
        return { name: "XRP", currency: "XRP" };
    }
    const asset = prefabAssets.find(a => a.name === assetName) || dynamicAssets.find(a => a.name === assetName);
    if (!asset) {
        log(`Error: Asset ${assetName} not found in prefabAssets or dynamicAssets.`);
        return null;
    }
    return asset;
}

async function selectTrustAsset(forceFetch = false) {
    const trustAssetSelect = document.getElementById('trust-asset-select');
    const selectedAssetName = trustAssetSelect.value;
    const asset = getAssetByName(selectedAssetName);
    const trustIssuerInput = document.getElementById('trust-issuer');
    const trustCurrencyInput = document.getElementById('trust-currency');
    const trustLimitInput = document.getElementById('trust-limit');
    const currentLimitDisplay = document.getElementById('current-trust-limit');
    const address = globalAddress;

    if (asset) {
        trustIssuerInput.value = asset.issuer;
        trustCurrencyInput.value = asset.hex;

        if (!forceFetch) {
            if (currentLimitDisplay) currentLimitDisplay.textContent = 'Current Trustline Limit: -';
        } else if (xrpl.isValidAddress(address) && client && client.isConnected()) {
            try {
                const accountLines = await client.request({ command: "account_lines", account: address, ledger_index: "current" });
                const existingTrustline = accountLines.result.lines.find(line => line.currency === asset.hex && line.account === asset.issuer);
                if (existingTrustline) {
                    if (currentLimitDisplay) currentLimitDisplay.textContent = `Current Trustline Limit: ${existingTrustline.limit} (Balance: ${formatBalance(existingTrustline.balance)})`;
                } else {
                    if (currentLimitDisplay) currentLimitDisplay.textContent = 'Current Trustline Limit: None';
                }
            } catch (error) {
                log(`Error checking existing trustline for ${asset.name}: ${error.message}`);
                if (currentLimitDisplay) currentLimitDisplay.textContent = 'Current Trustline Limit: Unable to fetch';
            }
        } else {
            if (address || (client && client.isConnected())) log('Cannot check trustline: Invalid address or not connected to XRPL server.');
            if (currentLimitDisplay) currentLimitDisplay.textContent = 'Current Trustline Limit: Connect to XRPL server and enter a valid address';
        }

        const defaultLimit = "1000000000000000";
        trustLimitInput.value = defaultLimit;
    } else {
        trustIssuerInput.value = '';
        trustCurrencyInput.value = '';
        trustLimitInput.value = '';
        if (currentLimitDisplay) currentLimitDisplay.textContent = 'Current Trustline Limit: None';
    }
}

function selectSendAsset() {
    const sendAssetSelect = document.getElementById('send-asset-select');
    const selectedAssetName = sendAssetSelect.value;
    const asset = getAssetByName(selectedAssetName);
    document.getElementById('send-amount').placeholder = asset ? `Amount (e.g., 200 or 1.134891)` : "Amount (e.g., 200 or 1.134891 XRP)";
}


function updateSwapDirection() {
    const inputAsset = document.getElementById('swap-input-asset')?.value;
    const outputAsset = document.getElementById('swap-output-asset')?.value;
    if (inputAsset && outputAsset && inputAsset === outputAsset) {
        const availableAssets = ['XRP', ...prefabAssets.map(a => a.name)];
        const otherAsset = availableAssets.find(a => a !== inputAsset);
        document.getElementById('swap-output-asset').value = otherAsset;
    }
    if (document.getElementById('swap-result')) document.getElementById('swap-result').innerHTML = '<p>Swap Result: -</p>';
    updateBalances();
}

async function updateBalances() {
    
    if (window.isUpdatingBalances) {
        
        return;
    }
    window.isUpdatingBalances = true;

    try {
        const address = globalAddress;
        if (!address || !xrpl.isValidAddress(address)) {
            if (document.getElementById('input-balance')) document.getElementById('input-balance').textContent = 'Balance: -';
            if (document.getElementById('output-balance')) document.getElementById('output-balance').textContent = 'Balance: -';
            const slider = document.getElementById('swap-balance-slider');
            if (slider) {
                slider.value = 0;
                slider.disabled = true;
                document.getElementById('slider-percentage').textContent = '0%';
                document.getElementById('swap-amount').value = '';
                document.getElementById('swap-output-amount').value = '';
            }
            return;
        }

        await ensureConnected();
        const inputAsset = document.getElementById('swap-input-asset')?.value;
        const outputAsset = document.getElementById('swap-output-asset')?.value;

        const now = Date.now();
        let xrpBalance, accountLines;
        if (!cachedBalance || (now - cachedBalance.timestamp) > 120000) {
            const accountInfo = await client.request({ command: "account_info", account: address, ledger_index: "current" });
            xrpBalance = xrpl.dropsToXrp(accountInfo.result.account_data.Balance);
            accountLines = await client.request({ command: "account_lines", account: address, ledger_index: "current" });
            cachedBalance = await calculateAvailableBalance(address);
            cachedBalance.timestamp = now;
            cachedAccountLines = accountLines;
            lastAccountLinesFetch = now;
            
        } else {
            xrpBalance = cachedBalance.totalBalanceXrp;
            if (!cachedAccountLines || (now - lastAccountLinesFetch) > 60000) {
            
                accountLines = await client.request({ command: "account_lines", account: address, ledger_index: "current" });
                cachedAccountLines = accountLines;
                lastAccountLinesFetch = now;
            } else {
                accountLines = cachedAccountLines;
            
            }
        }

        if (inputAsset && outputAsset) {
            const inputAssetData = inputAsset === "XRP" ? null : getAssetByName(inputAsset);
            const outputAssetData = outputAsset === "XRP" ? null : getAssetByName(outputAsset);
            const inputAssetHex = inputAssetData ? inputAssetData.hex : null;
            const outputAssetHex = outputAssetData ? outputAssetData.hex : null;
            const inputBalance = inputAsset === "XRP" ? xrpBalance : (accountLines?.result?.lines?.find(line => line.currency === inputAssetHex)?.balance || "0");
            const outputBalance = outputAsset === "XRP" ? xrpBalance : (accountLines?.result?.lines?.find(line => line.currency === outputAssetHex)?.balance || "0");
            if (document.getElementById('input-balance')) document.getElementById('input-balance').textContent = `Balance: ${formatBalance(inputBalance)}`;
            if (document.getElementById('output-balance')) document.getElementById('output-balance').textContent = `Balance: ${formatBalance(outputBalance)}`;
        }

        const slider = document.getElementById('swap-balance-slider');
        if (slider) {
            const timeDiff = ammState.lastPriceCheckTimestamp ? now - ammState.lastPriceCheckTimestamp : Infinity;
            const isPriceFresh = timeDiff <= 180000;
            const hasPoolPrice = !!ammState.lastPoolPrice;
            const assetMatch = hasPoolPrice && inputAsset === (ammState.lastPoolPrice?.direction.includes("XRP-to-Token") ? "XRP" : ammState.lastPoolPrice?.assetName) && outputAsset === (ammState.lastPoolPrice?.direction.includes("Token-to-XRP") ? "XRP" : ammState.lastPoolPrice?.assetName);

            if (!isPriceFresh && !hasPoolPrice) {
                slider.value = 0;
                slider.disabled = true;
                document.getElementById('slider-percentage').textContent = '0%';
                document.getElementById('swap-amount').value = '';
                document.getElementById('swap-output-amount').value = '';
                if (hasPoolPrice) {
                    const currentPair = `${inputAsset}-${outputAsset}`;
                    const storedPair = ammState.lastPoolPrice.direction === "XRP-to-Token" ? `XRP-${ammState.lastPoolPrice.assetName}` : `${ammState.lastPoolPrice.assetName}-XRP`;
                    if (currentPair !== storedPair) {
                        ammState.lastPoolPrice = null;
                        ammState.lastPriceCheckTimestamp = null;
                    }
                }
            } else {
                slider.disabled = false;
            }
        }
    } catch (error) {
        log(`Balance update error: ${error.message}`);
        if (document.getElementById('input-balance')) document.getElementById('input-balance').textContent = 'Balance: -';
        if (document.getElementById('output-balance')) document.getElementById('output-balance').textContent = 'Balance: -';
        const slider = document.getElementById('swap-balance-slider');
        if (slider) {
            slider.value = 0;
            slider.disabled = true;
            document.getElementById('slider-percentage').textContent = '0%';
            document.getElementById('swap-amount').value = '';
            document.getElementById('swap-output-amount').value = '';
        }
    } finally {
        window.isUpdatingBalances = false;
    }
}



function populateDonation(address) {
    const destinationInput = document.getElementById('send-destination');
    const assetSelect = document.getElementById('send-asset-select');
    const memoInput = document.getElementById('send-memo');
    
    if (destinationInput && assetSelect && memoInput) {
        destinationInput.value = address;
        assetSelect.value = "XRP";
        memoInput.value = "Happy Mad Lab!";
        log(`Donation fields populated: Address=${address}, Asset=XRP, Memo="Happy Mad Lab!"`);
    } else {
        log('Error: Could not find transaction input fields to populate donation.');
    }
}

async function fetchDomain() {
    try {
        await ensureConnected();
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-domain');

        if (!xrpl.isValidAddress(address)) {
            log('Error: Invalid XRPL address.');
            if (errorElement) errorElement.textContent = 'Invalid XRPL address.';
            return;
        }

        const accountInfo = await client.request({ command: "account_info", account: address, ledger_index: "current" });
        const domainHex = accountInfo.result.account_data.Domain;
        const domain = hexToDomain(domainHex);
        const currentDomainDisplay = document.getElementById('current-domain');
        if (currentDomainDisplay) {
            currentDomainDisplay.textContent = `Current Domain: ${domain || 'None'}`;
        }
        log(`Current domain for ${address}: ${domain || 'None'}`);
    } catch (error) {
        log(`Error fetching domain: ${error.message}`);
    }
}

async function queueDomainTransaction() {
    try {
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-domain');

        if (!contentCache || !displayTimer) {
            log('Error: No wallet loaded. Load a wallet in the Wallet Management section.');
            errorElement.textContent = 'No wallet loaded.';
            return;
        }
        if (!xrpl.isValidAddress(address)) {
            log('Error: Invalid address. Load a valid wallet in the Wallet Management section.');
            errorElement.textContent = 'Invalid address.';
            return;
        }

        const preEther = spawnEtherNoise(4);
        window.etherPreFlux = preEther;

        const domainInput = document.getElementById('domain-input').value.trim();
        if (!domainInput) {
            log('Error: Domain input is empty. Enter a domain or click "Remove Domain" to clear it.');
            errorElement.textContent = 'Domain input is empty.';
            return;
        }

        const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z]{2,})+$/;
        if (!domainRegex.test(domainInput)) {
            log('Error: Invalid domain format. Use a valid domain (e.g., example.com).');
            errorElement.textContent = 'Invalid domain format.';
            return;
        }

        const seed = await fetchRenderContent();
        const wallet = xrpl.Wallet.fromSeed(seed);
        if (wallet.classicAddress !== address) {
            log('Error: Seed does not match address.');
            errorElement.textContent = 'Seed does not match address.';
            return;
        }

        const domainHex = domainToHex(domainInput);
        const tx = {
            TransactionType: "AccountSet",
            Account: address,
            Domain: domainHex,
            Fee: TRANSACTION_FEE_DROPS
        };

        const scheduleCheckbox = document.getElementById('schedule-tx-domain');
        const delayInput = document.getElementById('schedule-delay-domain');
        let delayMs = 0;

        if (scheduleCheckbox.checked && delayInput.value) {
            const delayMinutes = parseInt(delayInput.value);
            if (isNaN(delayMinutes) || delayMinutes <= 0) {
                log('Error: Invalid delay time.');
                errorElement.textContent = 'Invalid delay time.';
                return;
            }
            delayMs = delayMinutes * 60 * 1000;
            log(`Scheduling domain transaction to be sent in ${delayMinutes} minutes...`);
        }

        const txEntry = {
            tx: tx,
            wallet: wallet,
            description: `Set domain to ${domainInput}`,
            delayMs: delayMs,
            type: "domain",
            queueElementId: "domain-queue"
        };

        transactionQueue.push(txEntry);
        log(`Domain transaction added to queue. Current queue length: ${transactionQueue.length}`);
        updateTransactionQueueDisplay();

        if (!isProcessingQueue) processTransactionQueue();
    } catch (error) {
        log(`Domain queue error: ${error.message}`);
    }
}
async function removeDomain() {
    try {
        const address = globalAddress;
        const errorElement = document.getElementById('address-error-domain');

        if (!contentCache || !displayTimer) {
            log('Error: No wallet loaded. Load a wallet in the Wallet Management section.');
            errorElement.textContent = 'No wallet loaded.';
            return;
        }
        if (!xrpl.isValidAddress(address)) {
            log('Error: Invalid address. Load a valid wallet in the Wallet Management section.');
            errorElement.textContent = 'Invalid address.';
            return;
        }

        const preEther = spawnEtherNoise(4);
        window.etherPreFlux = preEther;

        const seed = await fetchRenderContent();
        const wallet = xrpl.Wallet.fromSeed(seed);
        if (wallet.classicAddress !== address) {
            log('Error: Seed does not match address.');
            errorElement.textContent = 'Seed does not match address.';
            return;
        }

        const tx = {
            TransactionType: "AccountSet",
            Account: address,
            Domain: "",
            Fee: TRANSACTION_FEE_DROPS
        };

        const scheduleCheckbox = document.getElementById('schedule-tx-domain');
        const delayInput = document.getElementById('schedule-delay-domain');
        let delayMs = 0;

        if (scheduleCheckbox.checked && delayInput.value) {
            const delayMinutes = parseInt(delayInput.value);
            if (isNaN(delayMinutes) || delayMinutes <= 0) {
                log('Error: Invalid delay time.');
                errorElement.textContent = 'Invalid delay time.';
                return;
            }
            delayMs = delayMinutes * 60 * 1000;
            log(`Scheduling domain removal transaction to be sent in ${delayMinutes} minutes...`);
        }

        const txEntry = {
            tx: tx,
            wallet: wallet,
            description: `Remove domain from account`,
            delayMs: delayMs,
            type: "domain",
            queueElementId: "domain-queue"
        };

        transactionQueue.push(txEntry);
        log(`Domain removal transaction added to queue. Current queue length: ${transactionQueue.length}`);
        updateTransactionQueueDisplay();

        if (!isProcessingQueue) processTransactionQueue();
    } catch (error) {
        log(`Domain removal queue error: ${error.message}`);
    }
}

function domainToHex(domain) {
    return Array.from(domain.toLowerCase())
        .map(char => char.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('');
}

function hexToDomain(hex) {
    if (!hex) return '';
    return hex.match(/.{1,2}/g)
        .map(byte => String.fromCharCode(parseInt(byte, 16)))
        .join('');
}

function reapplyCursorStyle() {
    document.body.style.cursor = "url('test-tube-cursor.png') 0 0, auto";
    const allElements = document.querySelectorAll('*');
    allElements.forEach(element => {
        element.style.cursor = "url('test-tube-cursor.png') 0 0, auto";
    });
}

function emergencyClearQueue() {
    if (transactionQueue.length === 0) {
        log('No transactions in queue to clear.');
        return;
    }

    log('Emergency Clear Queue triggered! Clearing the following transactions:');
    transactionQueue.forEach((txEntry, index) => {
        log(`${index + 1}. ${txEntry.description}`);
    });


    transactionQueue = [];
    isProcessingQueue = false;

    updateTransactionQueueDisplay();

    log('Queue cleared successfully. All pending transactions aborted.');
}

const debouncedUpdateSwapAmounts = debounce(updateSwapAmountsFromSlider, 100);

function setupDisclaimerPopup() {
    const disclaimerPopup = document.getElementById('disclaimerPopup');
    const gratitudeCheckbox = document.getElementById('gratitude-checkbox');
    const acceptButton = document.getElementById('accept-disclaimer-btn');
    
    if (!disclaimerPopup || !gratitudeCheckbox || !acceptButton) {
        log('Error: Disclaimer popup elements not found.');
        return;
    }
    gratitudeCheckbox.addEventListener('change', () => {
        acceptButton.disabled = !gratitudeCheckbox.checked;
    });
    
    acceptButton.addEventListener('click', () => {
        disclaimerPopup.style.display = 'none';
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const welcomePopup = document.getElementById('welcomePopup');
    if (welcomePopup) {
        welcomePopup.style.display = 'flex';
    } else {
        log('Error: #welcomePopup not found on page load.');
    }
    setupDisclaimerPopup();
    randomizeServerSelection();
    populateAssetDropdowns();

    setTimeout(() => {
        const trustSelect = document.getElementById('trust-asset-select');
        if (!trustSelect?.options?.length) {
            populateAssetDropdowns();
        }
    }, 1000);

    const ammSwapSection = document.getElementById('amm-swap');
    let hasInitializedAmmSwap = false;
    if (ammSwapSection) {
        ammSwapSection.querySelector('.section-header').addEventListener('click', async function () {
            if (!hasInitializedAmmSwap && !ammSwapSection.classList.contains('minimized')) {
                await checkBalance();
                await updateBalances();
                hasInitializedAmmSwap = true;
            }
        });

        const ammSwapNavLink = document.querySelector('a[href="#amm-swap"]');
        if (ammSwapNavLink) {
            ammSwapNavLink.addEventListener('click', async function () {
                if (!hasInitializedAmmSwap) {
                    await checkBalance();
                    await updateBalances();
                    hasInitializedAmmSwap = true;
                }
            });
        }
    }

    const nukeAssetSelect = document.getElementById('nuke-asset-select');
    if (nukeAssetSelect) {
        nukeAssetSelect.addEventListener('change', () => updateNukeAssetDetails(true));
    }

    const sendTransactionsSection = document.getElementById('send-transactions');
    if (sendTransactionsSection) {
        sendTransactionsSection.querySelector('.section-header').addEventListener('click', () => {
            if (!sendTransactionsSection.classList.contains('minimized')) {
                updateNukeAssetDetails(true);
            }
        });

        const sendButton = sendTransactionsSection.querySelector('#send-tx-btn');
        if (sendButton) {
            sendButton.removeEventListener('click', queueTransaction);
            const debouncedQueueTx = debounce(queueTransaction, 300);
            sendButton.addEventListener('click', (e) => {
                debouncedQueueTx(e);
            });
        }
    }

    const trustAssetSelect = document.getElementById('trust-asset-select');
    if (trustAssetSelect) {
        trustAssetSelect.addEventListener('change', () => selectTrustAsset(true));
    }
    const trustlineManagementSection = document.getElementById('trustline-management');
    if (trustlineManagementSection) {
        trustlineManagementSection.querySelector('.section-header').addEventListener('click', () => {
            if (!trustlineManagementSection.classList.contains('minimized')) {
                selectTrustAsset(true);
            }
        });
    }

    const loadUnencryptedBtn = document.getElementById('load-unencrypted-wallet-btn');
    if (loadUnencryptedBtn) {
        loadUnencryptedBtn.addEventListener('click', () => {
            document.getElementById('unencryptedWalletFile').click();
        });
    }
});

function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}