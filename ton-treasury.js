/**
 * TT treasury wallet client
 * ------------------------------------------------------------------
 * Wraps the treasury wallet that actually holds the TT jetton supply and
 * signs/sends the on-chain jetton transfers for withdrawals.
 *
 * SECURITY: the mnemonic only ever comes from process.env.TREASURY_MNEMONIC
 * (set as a Railway variable). It is never logged, never written to disk,
 * and never sent to any client. init() verifies the address derived from
 * the mnemonic matches the configured TREASURY_ADDRESS before marking the
 * treasury "ready" - if it doesn't match (or the mnemonic is missing),
 * withdrawals stay disabled and the rest of the server keeps running
 * normally.
 * ------------------------------------------------------------------
 */

const { TonClient, WalletContractV5R1, JettonMaster, JettonWallet, Address, internal, toNano, SendMode, beginCell } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

let client = null;
let walletContract = null;
let keyPair = null;
let treasuryJettonWalletAddress = null;
let ready = false;
let initError = '';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function init({ mnemonic, treasuryAddress, jettonMaster, tonCenterUrl, tonCenterApiKey }) {
  ready = false;
  initError = '';
  try {
    if (!mnemonic || !mnemonic.trim()) throw new Error('TREASURY_MNEMONIC is not set');
    if (!treasuryAddress) throw new Error('TREASURY_ADDRESS is not set');
    if (!jettonMaster) throw new Error('TT_JETTON_MASTER is not set');
    const words = mnemonic.trim().split(/\s+/);
    if (words.length !== 24) throw new Error('TREASURY_MNEMONIC must contain exactly 24 words');

    keyPair = await mnemonicToPrivateKey(words);
    const wallet = WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey });
    const expectedAddress = Address.parse(treasuryAddress);
    if (!wallet.address.equals(expectedAddress)) {
      throw new Error(
        'Address derived from TREASURY_MNEMONIC (' + wallet.address.toString() +
        ') does not match TREASURY_ADDRESS (' + expectedAddress.toString() + ')'
      );
    }

    client = new TonClient({ endpoint: tonCenterUrl, apiKey: tonCenterApiKey || undefined });
    walletContract = client.open(wallet);
    const jettonMasterContract = client.open(JettonMaster.create(Address.parse(jettonMaster)));
    treasuryJettonWalletAddress = await jettonMasterContract.getWalletAddress(wallet.address);

    ready = true;
    console.log('[treasury] ready. wallet=' + wallet.address.toString() + ' jettonWallet=' + treasuryJettonWalletAddress.toString());
  } catch (e) {
    client = null;
    walletContract = null;
    keyPair = null;
    treasuryJettonWalletAddress = null;
    ready = false;
    initError = e && e.message ? e.message : String(e);
    console.error('[treasury] init failed: ' + initError + ' — TT withdrawals stay disabled.');
  }
}

function isReady() { return ready; }
function getInitError() { return initError; }
function getTreasuryAddress() { return walletContract ? walletContract.address.toString() : ''; }
function getTreasuryJettonWalletAddress() { return treasuryJettonWalletAddress ? treasuryJettonWalletAddress.toString() : ''; }

async function getTonBalance() {
  if (!ready) return 0;
  const balance = await client.getBalance(walletContract.address);
  return Number(balance) / 1e9;
}

async function getTtBalanceUnits() {
  if (!ready) return 0n;
  const jettonWallet = client.open(JettonWallet.create(treasuryJettonWalletAddress));
  return jettonWallet.getBalance();
}

async function getTtBalance(decimals) {
  const units = await getTtBalanceUnits();
  return Number(units) / Math.pow(10, decimals);
}

function buildJettonTransferBody({ amountUnits, toAddress, responseAddress, queryId, forwardTonAmountUnits }) {
  return beginCell()
    .storeUint(0xf8a7ea5, 32) // jetton transfer op (TEP-74)
    .storeUint(queryId, 64)
    .storeCoins(amountUnits)
    .storeAddress(toAddress)
    .storeAddress(responseAddress)
    .storeBit(false) // custom_payload: none
    .storeCoins(forwardTonAmountUnits) // forward_ton_amount, so the recipient wallet gets a transfer notification
    .storeBit(false) // forward_payload: none (inline empty slice)
    .endCell();
}

/**
 * Builds, signs and broadcasts a single jetton transfer from the treasury's
 * jetton wallet to `toAddressStr`. Returns the seqno the wallet had BEFORE
 * this transfer (used to detect once it has been accepted) and the queryId
 * used in the transfer body (for later lookup/audit).
 */
async function sendJettonTransfer({ toAddressStr, amountTT, decimals, gasTon }) {
  if (!ready) throw new Error('treasury-not-ready');
  const toAddress = Address.parse(toAddressStr);
  const amountUnits = BigInt(Math.round(amountTT * Math.pow(10, decimals)));
  if (amountUnits <= 0n) throw new Error('invalid-amount');
  const queryId = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const body = buildJettonTransferBody({
    amountUnits,
    toAddress,
    responseAddress: walletContract.address,
    queryId,
    forwardTonAmountUnits: 1n,
  });

  const seqnoBefore = await walletContract.getSeqno();
  await walletContract.sendTransfer({
    seqno: seqnoBefore,
    secretKey: keyPair.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [internal({
      to: treasuryJettonWalletAddress,
      value: toNano(String(gasTon)),
      bounce: true,
      body,
    })],
  });
  return { seqnoBefore, queryId: queryId.toString(), amountUnits: amountUnits.toString() };
}

/** Polls until the wallet's seqno changes (the external message was accepted/processed). */
async function waitSeqnoChange(seqnoBefore, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    try {
      const seqno = await walletContract.getSeqno();
      if (seqno !== seqnoBefore) return true;
    } catch (e) {
      // transient RPC hiccup - keep polling until the deadline
    }
  }
  return false;
}

/** Polls until the treasury jetton balance has dropped by (at least) amountUnits. */
async function waitBalanceDrop(balanceBeforeUnits, amountUnits, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    try {
      const balance = await getTtBalanceUnits();
      if (balance <= balanceBeforeUnits - amountUnits) return true;
    } catch (e) {
      // transient RPC hiccup - keep polling until the deadline
    }
  }
  return false;
}

module.exports = {
  init,
  isReady,
  getInitError,
  getTreasuryAddress,
  getTreasuryJettonWalletAddress,
  getTonBalance,
  getTtBalanceUnits,
  getTtBalance,
  sendJettonTransfer,
  waitSeqnoChange,
  waitBalanceDrop,
};
