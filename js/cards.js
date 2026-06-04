/**
 * NexusBank — premium card management (Supabase v2)
 */
(function () {
  'use strict';

  let cardsChannel = null;
  let selectedCardId = null;
  let selectedTheme = 'purple';
  let selectedPartner = 'standard';

  const PARTNER_LABELS = {
    none: 'External',
    standard: 'NexusBank Standard',
    flexi: 'NexusBank × Flexi',
    blaze_wear: 'NexusBank × Blaze Wear',
  };

  function getClient() {
    return window.NexusAuth?.supabase;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatCurrency(amount) {
    return (
      window.NexusMoney?.formatCurrency(amount) ||
      new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(amount) || 0)
    );
  }

  function networkIcon(network) {
    const map = {
      visa: 'fab fa-cc-visa',
      mastercard: 'fab fa-cc-mastercard',
      amex: 'fab fa-cc-amex',
      discover: 'fab fa-cc-discover',
    };
    return map[(network || '').toLowerCase()] || 'fas fa-credit-card';
  }

  function networkLabel(network) {
    const n = (network || 'card').toLowerCase();
    return n.charAt(0).toUpperCase() + n.slice(1);
  }

  function maskedPan(card) {
    return `${networkLabel(card.card_network)} •••• •••• •••• ${escapeHtml(card.last_four_digits)}`;
  }

  function cardSubtitle(card) {
    if (card.is_virtual) return PARTNER_LABELS[card.partner_type] || 'Virtual Card';
    return card.card_type === 'credit' ? 'Credit Card' : 'Debit Card';
  }

  async function fetchCards() {
    const client = getClient();
    let { data, error } = await client.from('cards_safe').select('*').order('created_at', { ascending: false });

    if (error) {
      const fallback = await client
        .from('cards')
        .select(
          'id, user_id, card_name, card_type, card_network, last_four_digits, expiry_date, cardholder_name, status, is_virtual, spending_limit, created_at, updated_at'
        )
        .order('created_at', { ascending: false });
      if (fallback.error) {
        console.warn('fetchCards:', fallback.error.message);
        return [];
      }
      data = (fallback.data || []).map((c) => ({
        ...c,
        partner_type: 'none',
        balance: 0,
        card_theme: 'purple',
        is_single_use: false,
        online_only: false,
        allow_freeze: true,
      }));
    }
    return data || [];
  }

  async function fetchCardSettings() {
    const client = getClient();
    const { data, error } = await client.from('card_settings').select('*');
    if (error) return [];
    return data || [];
  }

  async function fetchCardTransactions(limit) {
    const client = getClient();
    let q = client
      .from('card_transactions')
      .select('*, cards(card_name, last_four_digits, card_network)')
      .order('transaction_date', { ascending: false });
    if (limit) q = q.limit(limit);
    const { data, error } = await q;
    if (error) {
      console.warn('fetchCardTransactions:', error.message);
      const simple = await client
        .from('card_transactions')
        .select('*')
        .order('transaction_date', { ascending: false })
        .limit(limit || 50);
      if (simple.error) return [];
      return simple.data || [];
    }
    return data || [];
  }

  async function fetchAnalytics() {
    const client = getClient();
    const { data, error } = await client.rpc('get_card_analytics');
    if (error) {
      return computeAnalyticsClient(await fetchCardTransactions(200));
    }
    return data;
  }

  function computeAnalyticsClient(transactions) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);

    const purchases = transactions.filter((t) => t.transaction_type === 'purchase');
    let monthly = 0;
    let weekly = 0;
    const byCategory = {};
    const byCard = {};

    purchases.forEach((t) => {
      const d = new Date(t.transaction_date);
      const amt = Number(t.amount) || 0;
      if (d >= monthStart) {
        monthly += amt;
        const cat = t.category || 'general';
        byCategory[cat] = (byCategory[cat] || 0) + amt;
      }
      if (d >= weekStart) weekly += amt;
      const name = t.cards?.card_name || 'Card';
      byCard[name] = (byCard[name] || 0) + amt;
    });

    const categories = Object.entries(byCategory)
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);

    const most = Object.entries(byCard).sort((a, b) => b[1] - a[1])[0];

    return {
      monthly_spending: monthly,
      weekly_spending: weekly,
      most_used_card: most ? most[0] : '—',
      categories,
    };
  }

  async function addExternalCardSecure(payload) {
    const client = getClient();
    const { data, error } = await client.rpc('add_external_card_secure', payload);
    if (error) throw new Error(error.message);
    return data;
  }

  async function createNexusVirtualCard(payload) {
    const client = getClient();
    const { data, error } = await client.rpc('create_nexus_virtual_card', payload);
    if (error) throw new Error(error.message);
    return data;
  }

  async function setCardStatus(cardId, status) {
    const client = getClient();
    const { data, error } = await client.rpc('set_card_status', { p_card_id: cardId, p_status: status });
    if (error) throw new Error(error.message);
    return data;
  }

  async function updateCardSettings(cardId, payload) {
    const client = getClient();
    const { data, error } = await client.rpc('update_card_settings', {
      p_card_id: cardId,
      ...payload,
    });
    if (error) throw new Error(error.message);
    return data;
  }

  function renderCard(card, settingsMap) {
    const theme = card.card_theme || (card.partner_type === 'flexi' ? 'flexi' : card.partner_type === 'blaze_wear' ? 'blaze' : 'purple');
    const frozen = card.status === 'frozen';
    const settings = settingsMap[card.id] || {};
    const balance =
      card.is_virtual && card.balance != null
        ? formatCurrency(card.balance)
        : card.spending_limit != null
          ? formatCurrency(card.spending_limit) + ' limit'
          : 'Linked';

    const partnerBadge =
      card.partner_type && card.partner_type !== 'none'
        ? `<span class="nb-card-partner">${escapeHtml(PARTNER_LABELS[card.partner_type] || card.partner_type)}</span>`
        : '';

    const singleUse = card.is_single_use ? '<span class="nb-card-partner">Single-use</span>' : '';
    const onlineOnly = card.online_only ? '<span class="nb-card-partner">Online only</span>' : '';

    return `
      <article class="nb-card theme-${escapeHtml(theme)}${frozen ? ' is-frozen' : ''}" data-card-id="${card.id}">
        <div class="nb-card-glow"></div>
        <div class="nb-card-top">
          <div>
            ${partnerBadge}
            ${singleUse}
            ${onlineOnly}
            <div class="nb-card-name">${escapeHtml(card.card_name)}</div>
          </div>
          <div class="nb-card-chip${card.is_virtual ? ' virtual' : ''}"></div>
        </div>
        <div class="nb-card-pan">${maskedPan(card)}</div>
        <div class="nb-card-meta">
          <div>
            <small>Cardholder</small>
            <span>${escapeHtml(card.cardholder_name)}</span>
          </div>
          <div>
            <small>Expires</small>
            <span>${escapeHtml(card.expiry_date)}</span>
          </div>
          <div class="nb-card-brand"><i class="${networkIcon(card.card_network)}"></i></div>
        </div>
        <div class="nb-card-footer">
          <div class="nb-card-balance">${escapeHtml(balance)}</div>
          <span class="nb-status ${frozen ? 'frozen' : 'active'}">
            <i class="fas fa-${frozen ? 'snowflake' : 'check-circle'}"></i>
            ${frozen ? 'Frozen' : 'Active'}
          </span>
        </div>
        <div class="nb-card-actions">
          ${
            card.allow_freeze !== false
              ? `<button type="button" class="nb-card-btn js-toggle-freeze" data-card-id="${card.id}" data-frozen="${frozen}">
                   <i class="fas fa-${frozen ? 'unlock' : 'snowflake'}"></i> ${frozen ? 'Unfreeze' : 'Freeze'}
                 </button>`
              : ''
          }
          <button type="button" class="nb-card-btn js-card-settings" data-card-id="${card.id}">Settings</button>
          <button type="button" class="nb-card-btn js-view-card-tx" data-card-id="${card.id}">Activity</button>
        </div>
      </article>`;
  }

  function renderTransaction(tx) {
    const isCredit = tx.transaction_type === 'payment' || tx.transaction_type === 'refund';
    const iconClass =
      tx.transaction_type === 'refund' ? 'refund' : tx.transaction_type === 'payment' ? 'payment' : 'purchase';
    const icon =
      tx.transaction_type === 'refund'
        ? 'fa-undo-alt'
        : tx.transaction_type === 'payment'
          ? 'fa-credit-card'
          : 'fa-shopping-cart';
    const cardLabel = tx.cards
      ? `${tx.cards.card_name} ••••${tx.cards.last_four_digits}`
      : 'Card';
    const sign = isCredit ? '+' : '-';
    const date = new Date(tx.transaction_date).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

    return `
      <div class="tx-item" data-card-id="${tx.card_id}">
        <div class="tx-icon ${iconClass}"><i class="fas ${icon}"></i></div>
        <div class="tx-details">
          <div class="tx-name">
            ${escapeHtml(tx.merchant_name)}
            <span class="tx-type-pill">${escapeHtml(tx.transaction_type)}</span>
          </div>
          <div class="tx-card-used">${escapeHtml(cardLabel)} · ${escapeHtml(tx.category || 'general')}</div>
          <div class="tx-date">${escapeHtml(date)}</div>
        </div>
        <div class="tx-amount ${isCredit ? 'credit' : 'debit'}">${sign}${formatCurrency(tx.amount)}</div>
      </div>`;
  }

  function renderAnalytics(analytics) {
    const monthly = formatCurrency(analytics.monthly_spending);
    const weekly = formatCurrency(analytics.weekly_spending);
    const categories = analytics.categories || [];
    const maxCat = Math.max(...categories.map((c) => Number(c.total) || 0), 1);

    const catHtml = categories.length
      ? categories
          .map(
            (c) => `
        <div class="category-row">
          <span>${escapeHtml(c.name)}</span>
          <div class="category-bar"><div class="category-bar-fill" style="width:${Math.round((Number(c.total) / maxCat) * 100)}%"></div></div>
          <span>${formatCurrency(c.total)}</span>
        </div>`
          )
          .join('')
      : '<p style="font-size:0.8rem;color:var(--text-tertiary)">No spending data this month yet.</p>';

    const el = document.getElementById('cardsAnalytics');
    if (!el) return;
    el.innerHTML = `
      <div class="analytics-tile">
        <h3>Monthly spending</h3>
        <div class="value">${monthly}</div>
      </div>
      <div class="analytics-tile">
        <h3>Weekly spending</h3>
        <div class="value">${weekly}</div>
      </div>
      <div class="analytics-tile">
        <h3>Most used card</h3>
        <div class="value" style="font-size:1rem">${escapeHtml(analytics.most_used_card || '—')}</div>
      </div>
      <div class="analytics-tile wide">
        <h3>Category breakdown</h3>
        <div class="category-bars">${catHtml}</div>
      </div>`;
  }

  function renderHeroStats(cards) {
    const active = cards.filter((c) => c.status === 'active').length;
    const frozen = cards.filter((c) => c.status === 'frozen').length;
    const totalBalance = cards.reduce((s, c) => s + Number(c.balance || 0), 0);

    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    set('statTotalCards', cards.length);
    set('statActiveCards', active);
    set('statFrozenCards', frozen);
    set('statCardBalance', formatCurrency(totalBalance));
  }

  function bindCardActions(cardsList) {
    document.querySelectorAll('.js-toggle-freeze').forEach((btn) => {
      btn.onclick = async () => {
        const cardId = btn.dataset.cardId;
        const frozen = btn.dataset.frozen === 'true';
        btn.disabled = true;
        try {
          await setCardStatus(cardId, frozen ? 'active' : 'frozen');
          window.NexusMoney?.showToast(frozen ? 'Card unfrozen' : 'Card frozen', 'success');
          await refreshCardsUI();
        } catch (err) {
          window.NexusMoney?.showToast(err.message, 'error');
        } finally {
          btn.disabled = false;
        }
      };
    });

    document.querySelectorAll('.js-card-settings').forEach((btn) => {
      btn.onclick = () => openSettingsModal(btn.dataset.cardId, cardsList);
    });

    document.querySelectorAll('.js-view-card-tx').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.cardId;
        document.getElementById('cardsActivitySection')?.scrollIntoView({ behavior: 'smooth' });
        document.querySelectorAll('#cardTransactionsList .tx-item').forEach((row) => {
          row.style.opacity = row.dataset.cardId === id ? '1' : '0.35';
        });
      };
    });
  }

  let refreshHandler = null;

  async function refreshCardsUI() {
    const grid = document.getElementById('cardsGrid');
    const txList = document.getElementById('cardTransactionsList');
    if (!grid) return;

    grid.innerHTML = '<div class="cards-skeleton"></div><div class="cards-skeleton"></div>';

    try {
      const [cards, settingsList, transactions, analytics] = await Promise.all([
        fetchCards(),
        fetchCardSettings(),
        fetchCardTransactions(15),
        fetchAnalytics(),
      ]);

      const settingsMap = {};
      settingsList.forEach((s) => {
        settingsMap[s.card_id] = s;
      });

      renderHeroStats(cards);
      renderAnalytics(analytics);

      if (!cards.length) {
        grid.innerHTML = `
          <div class="cards-empty" style="grid-column:1/-1">
            <i class="fas fa-credit-card empty-icon"></i>
            <h3>No cards yet</h3>
            <p>Create a NexusBank virtual card or add an existing debit/credit card.</p>
            <button type="button" class="btn-primary" id="emptyCreateCard" style="margin-top:1rem">Create Virtual Card</button>
          </div>`;
        document.getElementById('emptyCreateCard')?.addEventListener('click', () => openModal('virtualCardModal'));
      } else {
        grid.innerHTML = cards.map((c) => renderCard(c, settingsMap)).join('');
        bindCardActions(cards);
      }

      if (txList) {
        txList.innerHTML = transactions.length
          ? transactions.map(renderTransaction).join('')
          : '<p class="cards-empty">No card activity yet. Purchases will appear here in real time.</p>';
      }

    } catch (err) {
      console.error(err);
      grid.innerHTML = `
        <div class="cards-empty" style="grid-column:1/-1">
          <i class="fas fa-exclamation-triangle empty-icon"></i>
          <p>Could not load cards. Run <strong>supabase/cards-schema.sql</strong> and <strong>cards-schema-v2.sql</strong> in Supabase.</p>
          <p style="font-size:0.8rem;margin-top:0.5rem">${escapeHtml(err.message)}</p>
        </div>`;
      if (txList) txList.innerHTML = '<p class="cards-empty">—</p>';
    }
  }

  function subscribeCardUpdates(userId) {
    const client = getClient();
    if (!client || !userId) return;

    if (cardsChannel) client.removeChannel(cardsChannel);

    cardsChannel = client
      .channel('cards-hub-' + userId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cards', filter: 'user_id=eq.' + userId }, () =>
        refreshHandler?.()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'card_transactions', filter: 'user_id=eq.' + userId },
        () => refreshHandler?.()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'card_settings', filter: 'user_id=eq.' + userId },
        () => refreshHandler?.()
      )
      .subscribe();
  }

  function unsubscribeCardUpdates() {
    const client = getClient();
    if (cardsChannel && client) {
      client.removeChannel(cardsChannel);
      cardsChannel = null;
    }
  }

  function openModal(id) {
    document.getElementById(id)?.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeModal(id) {
    document.getElementById(id)?.classList.remove('active');
    if (!document.querySelector('.cards-modal.active')) {
      document.body.style.overflow = '';
    }
  }

  function setupModalClose() {
    document.querySelectorAll('[data-close-modal]').forEach((el) => {
      el.addEventListener('click', () => closeModal(el.dataset.closeModal));
    });
  }

  function formatCardNumberInput(input) {
    let v = input.value.replace(/\D/g, '').slice(0, 19);
    input.value = v.replace(/(\d{4})(?=\d)/g, '$1 ').trim();
  }

  function setupAddCardForm() {
    const panInput = document.getElementById('addCardNumber');
    panInput?.addEventListener('input', () => formatCardNumberInput(panInput));

    document.getElementById('addCardForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const pan = document.getElementById('addCardNumber').value.replace(/\D/g, '');
        const result = await addExternalCardSecure({
          p_card_number: pan,
          p_cardholder_name: document.getElementById('addCardHolder').value.trim(),
          p_expiry_date: document.getElementById('addCardExpiry').value.trim(),
          p_cvv: document.getElementById('addCardCvv').value.trim(),
          p_card_name: document.getElementById('addCardNickname').value.trim() || null,
          p_card_type: document.getElementById('addCardType').value,
        });
        window.NexusMoney?.showToast(result.message || 'Card saved', 'success');
        e.target.reset();
        closeModal('addCardModal');
        await refreshCardsUI();
      } catch (err) {
        window.NexusMoney?.showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  function setupPartnerPicker() {
    document.querySelectorAll('.partner-option').forEach((opt) => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('.partner-option').forEach((o) => o.classList.remove('selected'));
        opt.classList.add('selected');
        const radio = opt.querySelector('input[type="radio"]');
        if (radio) {
          radio.checked = true;
          selectedPartner = radio.value;
          if (selectedPartner === 'flexi') selectedTheme = 'flexi';
          else if (selectedPartner === 'blaze_wear') selectedTheme = 'blaze';
          else selectedTheme = 'purple';
          document.querySelectorAll('.theme-swatch').forEach((s) => {
            s.classList.toggle('selected', s.dataset.theme === selectedTheme);
          });
        }
      });
    });
  }

  function setupThemePicker() {
    document.querySelectorAll('.theme-swatch').forEach((sw) => {
      sw.addEventListener('click', () => {
        selectedTheme = sw.dataset.theme;
        document.querySelectorAll('.theme-swatch').forEach((s) => s.classList.remove('selected'));
        sw.classList.add('selected');
      });
    });
  }

  function setupVirtualCardForm() {
    document.getElementById('virtualCardForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const partner =
          document.querySelector('.partner-option input:checked')?.value || selectedPartner;
        const result = await createNexusVirtualCard({
          p_card_name: document.getElementById('virtualCardName').value.trim(),
          p_partner_type: partner,
          p_spending_limit: parseFloat(document.getElementById('virtualCardLimit').value),
          p_card_theme: selectedTheme,
          p_online_only: document.getElementById('virtualOnlineOnly')?.checked || false,
          p_single_use: document.getElementById('virtualSingleUse')?.checked || false,
          p_allow_freeze: document.getElementById('virtualAllowFreeze')?.checked !== false,
          p_expires_months: parseInt(document.getElementById('virtualExpiresMonths').value, 10) || 36,
        });
        window.NexusMoney?.showToast(
          (result.message || 'Card created') + ' · ' + (result.display || ''),
          'success'
        );
        closeModal('virtualCardModal');
        await refreshCardsUI();
      } catch (err) {
        window.NexusMoney?.showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  function openSettingsModal(cardId, cards) {
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;
    selectedCardId = cardId;

    document.getElementById('settingsCardTitle').textContent = card.card_name;
    const panEl = document.getElementById('settingsDisplayPan');
    if (panEl) {
      panEl.value =
        networkLabel(card.card_network) + ' •••• •••• •••• ' + card.last_four_digits;
    }

    const limitEl = document.getElementById('settingsSpendingLimit');
    if (limitEl) limitEl.value = card.spending_limit || 1000;

    document.getElementById('settingsOnline').checked = card.online_only || false;
    document.getElementById('settingsAtm').checked = !card.online_only;
    document.getElementById('settingsInternational').checked = true;

    openModal('cardSettingsModal');
  }

  function setupSettingsForm() {
    document.getElementById('cardSettingsForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!selectedCardId) return;
      const btn = e.target.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        await updateCardSettings(selectedCardId, {
          p_online_payments: document.getElementById('settingsOnline').checked,
          p_atm_withdrawals: document.getElementById('settingsAtm').checked,
          p_international_payments: document.getElementById('settingsInternational').checked,
          p_spending_limit: parseFloat(document.getElementById('settingsSpendingLimit').value) || null,
          p_merchant_restrictions: document.getElementById('settingsMerchants').value.trim() || null,
        });
        window.NexusMoney?.showToast('Card settings saved', 'success');
        closeModal('cardSettingsModal');
        await refreshCardsUI();
      } catch (err) {
        window.NexusMoney?.showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  /** Attach click handlers once — must not depend on Supabase load succeeding */
  function bindPageActions() {
    function bindClick(id, handler) {
      const el = document.getElementById(id);
      if (!el || el.dataset.cardsBound === '1') return;
      el.dataset.cardsBound = '1';
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handler(e);
      });
    }

    bindClick('btnCreateVirtual', () => openModal('virtualCardModal'));
    bindClick('quickCreate', () => openModal('virtualCardModal'));
    bindClick('btnAddCard', () => openModal('addCardModal'));
    bindClick('quickAdd', () => openModal('addCardModal'));
    bindClick('quickViewTx', () => {
      document.getElementById('cardsActivitySection')?.scrollIntoView({ behavior: 'smooth' });
    });

    bindClick('quickSettings', async () => {
      try {
        const list = await fetchCards();
        if (list.length) openSettingsModal(list[0].id, list);
        else window.NexusMoney?.showToast('Add a card first', 'info');
      } catch (err) {
        window.NexusMoney?.showToast(err.message || 'Could not load cards', 'error');
      }
    });

    bindClick('quickFreeze', async () => {
      try {
        const cards = await fetchCards();
        const active = cards.filter((c) => c.status === 'active' && c.allow_freeze !== false);
        if (!active.length) {
          window.NexusMoney?.showToast('No active cards to freeze', 'info');
          return;
        }
        await setCardStatus(active[0].id, 'frozen');
        window.NexusMoney?.showToast('Card frozen', 'success');
        await refreshCardsUI();
      } catch (err) {
        window.NexusMoney?.showToast(err.message || 'Freeze failed', 'error');
      }
    });

    bindClick('quickUnfreeze', async () => {
      try {
        const cards = await fetchCards();
        const frozen = cards.filter((c) => c.status === 'frozen');
        if (!frozen.length) {
          window.NexusMoney?.showToast('No frozen cards', 'info');
          return;
        }
        await setCardStatus(frozen[0].id, 'active');
        window.NexusMoney?.showToast('Card unfrozen', 'success');
        await refreshCardsUI();
      } catch (err) {
        window.NexusMoney?.showToast(err.message || 'Unfreeze failed', 'error');
      }
    });
  }

  async function initCardsPage(user) {
    refreshHandler = refreshCardsUI;

    bindPageActions();
    setupModalClose();
    setupAddCardForm();
    setupPartnerPicker();
    setupThemePicker();
    setupVirtualCardForm();
    setupSettingsForm();

    await refreshCardsUI();
    subscribeCardUpdates(user.id);
  }

  window.NexusCards = {
    fetchCards,
    fetchCardTransactions,
    refreshCardsUI,
    initCardsPage,
    unsubscribeCardUpdates,
  };
})();
