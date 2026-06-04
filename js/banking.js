/**
 * NexusBank — load per-user accounts & transactions from Supabase; bank statements.
 */
(function () {
  'use strict';

  const TX_ICONS = {
    building: 'fa-building',
    shopping: 'fa-shopping-bag',
    coffee: 'fa-coffee',
    percentage: 'fa-percentage',
    phone: 'fa-phone-alt',
    deposit: 'fa-arrow-down',
    transfer: 'fa-exchange-alt',
    default: 'fa-receipt',
  };

  function getClient() {
    return window.NexusAuth?.supabase;
  }

  function formatCurrency(amount) {
    const n = Number(amount) || 0;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  }

  function formatTxDate(iso) {
    const d = new Date(iso);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfTx = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((startOfToday - startOfTx) / 86400000);
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    if (diffDays === 0) return `Today, ${time}`;
    if (diffDays === 1) return `Yesterday, ${time}`;
    if (diffDays < 7) return `${diffDays} days ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatStatementDate(iso) {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function txIconClass(iconKey, type) {
    const key = (iconKey || '').toLowerCase();
    return TX_ICONS[key] || TX_ICONS.default;
  }

  async function ensureBanking() {
    const client = getClient();
    if (!client) throw new Error('Supabase client not ready');

    const { data, error } = await client.rpc('ensure_user_banking');
    if (error) {
      console.warn('ensure_user_banking:', error.message);
      const { count, error: countError } = await client
        .from('bank_accounts')
        .select('*', { count: 'exact', head: true });
      if (countError || !count) throw error;
    }
    return data;
  }

  async function fetchAccounts() {
    const client = getClient();
    const { data, error } = await client
      .from('bank_accounts')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async function fetchRecentTransactions(limit = 10) {
    if (window.NexusMoney?.fetchMoneyTransactions) {
      return window.NexusMoney.fetchMoneyTransactions(limit);
    }
    const client = getClient();
    const { data, error } = await client
      .from('transactions')
      .select('*, bank_accounts(account_name, account_type, account_number_last4)')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  async function fetchAllTransactions() {
    if (window.NexusMoney?.fetchMoneyTransactions) {
      return window.NexusMoney.fetchMoneyTransactions();
    }
    const client = getClient();
    const { data, error } = await client
      .from('transactions')
      .select('*, bank_accounts(account_name, account_type, account_number_last4)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  function accountTypeLabel(type) {
    const map = { checking: 'Checking', savings: 'Savings', investment: 'Investment' };
    return map[type] || type;
  }

  function renderAccountCard(account) {
    const type = account.account_type || 'checking';
    const apyLine =
      account.apy != null
        ? `<div class="account-change positive">
            <i class="fas fa-arrow-up" style="font-size:0.65rem"></i>
            ${account.apy}% APY
          </div>`
        : `<div class="account-change positive">
            <i class="fas fa-check" style="font-size:0.65rem"></i>
            Active account
          </div>`;

    return `
      <div class="account-card" data-account-id="${account.id}">
        <div class="account-card-header">
          <span class="account-type-badge ${type}">
            <i class="fas fa-circle" style="font-size:0.45rem"></i> ${accountTypeLabel(type)}
          </span>
          <button type="button" class="account-more-btn" aria-label="Account options">
            <i class="fas fa-ellipsis-h"></i>
          </button>
        </div>
        <div class="account-name">${escapeHtml(account.account_name)}</div>
        <div class="account-number">**** ${escapeHtml(account.account_number_last4)}</div>
        <div class="account-balance">${formatCurrency(account.balance)}</div>
        ${apyLine}
        <div class="account-actions">
          <a href="transfer.html" class="btn-sm btn-sm-primary">
            <i class="fas fa-exchange-alt"></i> Transfer
          </a>
          <button type="button" class="btn-sm btn-sm-ghost js-view-statement" data-account-id="${account.id}">
            <i class="fas fa-file-alt"></i> Statement
          </button>
        </div>
      </div>`;
  }

  function renderTransactionItem(tx) {
    if (tx.type && window.NexusMoney?.renderMoneyTransactionRow) {
      return window.NexusMoney.renderMoneyTransactionRow(tx);
    }

    const type = tx.transaction_type === 'credit' ? 'credit' : 'debit';
    const sign = type === 'credit' ? '+' : '-';
    const icon = txIconClass(tx.icon, type);

    return `
      <div class="tx-item">
        <div class="tx-icon ${type}">
          <i class="fas ${icon}"></i>
        </div>
        <div class="tx-details">
          <div class="tx-name">${escapeHtml(tx.description)}</div>
          <div class="tx-date">${formatTxDate(tx.created_at)}</div>
        </div>
        <div class="tx-amount ${type}">${sign}${formatCurrency(tx.amount)}</div>
      </div>`;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildStatementHtml({ userName, userEmail, accounts, transactions, generatedAt }) {
    const total = accounts.reduce((sum, a) => sum + Number(a.balance || 0), 0);
    const periodStart =
      transactions.length > 0
        ? formatStatementDate(transactions[transactions.length - 1].created_at)
        : '—';
    const periodEnd =
      transactions.length > 0 ? formatStatementDate(transactions[0].created_at) : '—';

    const accountRows = accounts
      .map(
        (a) => `
        <tr>
          <td>${escapeHtml(a.account_name)}</td>
          <td>${escapeHtml(accountTypeLabel(a.account_type))}</td>
          <td>**** ${escapeHtml(a.account_number_last4)}</td>
          <td style="text-align:right">${formatCurrency(a.balance)}</td>
        </tr>`
      )
      .join('');

    const txRows = transactions
      .map((tx) => {
        const acct = tx.bank_accounts;
        const acctLabel = acct
          ? `${acct.account_name} (**** ${acct.account_number_last4})`
          : '—';
        const isCredit =
          tx.transaction_type === 'credit' ||
          (tx.type && window.NexusMoney?.isCreditType(tx.type));
        const type = isCredit ? 'Credit' : 'Debit';
        const sign = isCredit ? '+' : '-';
        return `
        <tr>
          <td>${formatStatementDate(tx.created_at)}</td>
          <td>${escapeHtml(tx.description)}</td>
          <td>${escapeHtml(acctLabel)}</td>
          <td>${type}</td>
          <td style="text-align:right">${sign}${formatCurrency(tx.amount)}</td>
          <td style="text-align:right">${tx.balance_after != null ? formatCurrency(tx.balance_after) : '—'}</td>
        </tr>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>NexusBank Statement — ${escapeHtml(userName)}</title>
  <style>
    body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a2e; margin: 40px; line-height: 1.5; }
    h1 { font-size: 1.5rem; margin: 0 0 4px; }
    .brand { color: #6C5CE7; font-weight: bold; }
    .meta { color: #555; font-size: 0.9rem; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0 28px; font-size: 0.88rem; }
    th, td { border: 1px solid #ccc; padding: 8px 10px; text-align: left; }
    th { background: #f4f4f8; }
    .summary { background: #f9f9fc; padding: 16px; border: 1px solid #ddd; margin-bottom: 24px; }
    .total { font-size: 1.25rem; font-weight: bold; }
    @media print { body { margin: 20px; } }
  </style>
</head>
<body>
  <p class="brand">NexusBank</p>
  <h1>Account Statement</h1>
  <div class="meta">
    <div><strong>${escapeHtml(userName)}</strong></div>
    <div>${escapeHtml(userEmail)}</div>
    <div>Statement period: ${periodStart} — ${periodEnd}</div>
    <div>Generated: ${formatStatementDate(generatedAt)}</div>
  </div>
  <div class="summary">
    <div>Total balance across all accounts</div>
    <div class="total">${formatCurrency(total)}</div>
  </div>
  <h2>Your Accounts</h2>
  <table>
    <thead><tr><th>Account</th><th>Type</th><th>Number</th><th>Balance</th></tr></thead>
    <tbody>${accountRows || '<tr><td colspan="4">No accounts</td></tr>'}</tbody>
  </table>
  <h2>Transaction History</h2>
  <table>
    <thead>
      <tr><th>Date</th><th>Description</th><th>Account</th><th>Type</th><th>Amount</th><th>Balance After</th></tr>
    </thead>
    <tbody>${txRows || '<tr><td colspan="6">No transactions</td></tr>'}</tbody>
  </table>
  <p style="font-size:0.8rem;color:#666;margin-top:32px;">
    This statement is for your records. For questions, contact NexusBank support.
  </p>
</body>
</html>`;
  }

  function downloadStatementDocument(html, filename) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function downloadBankStatement(user, profile) {
    const accounts = await fetchAccounts();
    const transactions = await fetchAllTransactions();
    const userName = profile?.full_name || user.user_metadata?.full_name || 'Account Holder';
    const userEmail = profile?.email || user.email || '';
    const html = buildStatementHtml({
      userName,
      userEmail,
      accounts,
      transactions,
      generatedAt: new Date().toISOString(),
    });
    const safeName = userName.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'statement';
    const datePart = new Date().toISOString().slice(0, 10);
    downloadStatementDocument(html, `NexusBank-Statement-${safeName}-${datePart}.html`);
  }

  function bindStatementButtons(user, profile) {
    const handler = async (e) => {
      e.preventDefault();
      const btn = e.currentTarget;
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        await downloadBankStatement(user, profile);
      } catch (err) {
        alert('Could not generate statement: ' + (err.message || 'Unknown error'));
      } finally {
        btn.disabled = false;
      }
    };

    document.querySelectorAll('.js-download-statement, .js-view-statement').forEach((el) => {
      el.addEventListener('click', handler);
    });
  }

  function showStatementModal(transactions, accounts) {
    let modal = document.getElementById('statementModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'statementModal';
      modal.className = 'statement-modal';
      modal.innerHTML = `
        <div class="statement-modal-backdrop"></div>
        <div class="statement-modal-panel" role="dialog" aria-labelledby="statementModalTitle">
          <div class="statement-modal-header">
            <h2 id="statementModalTitle">Bank Statement Preview</h2>
            <button type="button" class="statement-modal-close" aria-label="Close">&times;</button>
          </div>
          <div class="statement-modal-body" id="statementModalBody"></div>
          <div class="statement-modal-footer">
            <button type="button" class="btn-secondary js-download-statement">Download Statement</button>
            <button type="button" class="btn-primary statement-modal-close-btn">Close</button>
          </div>
        </div>`;
      document.body.appendChild(modal);

      modal.querySelector('.statement-modal-backdrop').addEventListener('click', () => modal.classList.remove('active'));
      modal.querySelectorAll('.statement-modal-close, .statement-modal-close-btn').forEach((btn) => {
        btn.addEventListener('click', () => modal.classList.remove('active'));
      });
    }

    const body = modal.querySelector('#statementModalBody');
    const total = accounts.reduce((s, a) => s + Number(a.balance || 0), 0);
    const previewTx = transactions.slice(0, 20);

    body.innerHTML = `
      <p class="statement-preview-total">Total balance: <strong>${formatCurrency(total)}</strong></p>
      <p class="statement-preview-meta">${previewTx.length} of ${transactions.length} transactions shown</p>
      <div class="statement-preview-list">
        ${previewTx.map((tx) => renderTransactionItem(tx)).join('') || '<p>No transactions yet.</p>'}
      </div>`;

    modal.classList.add('active');
  }

  async function refreshAccountsUI(user, profile) {
    const [accounts, transactions] = await Promise.all([
      fetchAccounts(),
      fetchRecentTransactions(10),
    ]);

    const total = accounts.reduce((sum, a) => sum + Number(a.balance || 0), 0);

    const balanceEl = document.getElementById('totalBalanceAmount');
    if (balanceEl) balanceEl.textContent = formatCurrency(total);

    const changeEl = document.getElementById('totalBalanceChange');
    if (changeEl) {
      const credits = transactions
        .filter((t) =>
          t.transaction_type === 'credit' ||
          (t.type && window.NexusMoney?.isCreditType(t.type))
        )
        .reduce((s, t) => s + Number(t.amount), 0);
      changeEl.innerHTML =
        credits > 0
          ? `<i class="fas fa-arrow-up"></i> ${formatCurrency(credits)} recent credits`
          : `<i class="fas fa-wallet"></i> Welcome to NexusBank`;
    }

    const grid = document.getElementById('accountsGrid');
    if (grid) {
      grid.innerHTML =
        accounts.length > 0
          ? accounts.map(renderAccountCard).join('')
          : '<p class="empty-accounts">No accounts found.</p>';
    }

    const txList = document.getElementById('recentTransactionsList');
    if (txList) {
      txList.innerHTML =
        transactions.length > 0
          ? transactions.map(renderTransactionItem).join('')
          : '<p class="empty-transactions">No transactions yet.</p>';
    }

    bindStatementButtons(user, profile);
    return accounts;
  }

  async function loadAccountsPage(user, profile) {
    await ensureBanking();
    const accounts = await refreshAccountsUI(user, profile);

    document.querySelectorAll('.js-open-statement-modal').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const allTx = await fetchAllTransactions();
        showStatementModal(allTx, accounts);
        bindStatementButtons(user, profile);
      });
    });

    document.querySelectorAll('.js-deposit-funds').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const accts = await fetchAccounts();
        window.NexusMoney?.openDepositModal(accts, () => refreshAccountsUI(user, profile));
      });
    });

    document.querySelectorAll('.js-withdraw-funds').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const accts = await fetchAccounts();
        window.NexusMoney?.openWithdrawModal(accts, () => refreshAccountsUI(user, profile));
      });
    });

    if (window.NexusMoney?.subscribeMoneyUpdates) {
      window.NexusMoney.subscribeMoneyUpdates(user.id, () => {
        refreshAccountsUI(user, profile);
      });
    }
  }

  window.NexusBanking = {
    ensureBanking,
    fetchAccounts,
    fetchRecentTransactions,
    fetchAllTransactions,
    formatCurrency,
    loadAccountsPage,
    downloadBankStatement,
  };
})();
