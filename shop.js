  /* ================= SHOP ================= */
  function refreshShopUI(){
    document.querySelectorAll('.shop-item').forEach(item => {
      const key = item.dataset.upgrade;
      const btn = item.querySelector('.shop-buy-btn');
      const price = parseInt(btn.dataset.price, 10);
      if (store.upgrades[key]){
        btn.textContent = t('buyOwned');
        btn.classList.add('owned');
        btn.disabled = true;
      } else {
        btn.textContent = price + ' 🪙';
        btn.classList.remove('owned');
        btn.disabled = store.coins < price;
      }
    });
  }
  document.querySelectorAll('.shop-buy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.shop-item');
      const key = item.dataset.upgrade;
      const price = parseInt(btn.dataset.price, 10);
      if (store.upgrades[key] || store.coins < price) return;
      store.coins -= price;
      store.upgrades[key] = true;
      saveStore();
      refreshTopUI();
    });
  });

  /* ================= TAXI SKIN SHOP ================= */
  const SKIN_LEVELS = [
    { level:1, key:'yellow', nameKey:'skinNameYellow', price:0,  status:'free', dailyReward:0,    rewardDays:0  },
    { level:2, key:'red',    nameKey:'skinNameRed',    price:5,  status:'buy',  dailyReward:0.33, rewardDays:30 },
    { level:3, key:'white',  nameKey:'skinNameWhite',  price:15, status:'buy',  dailyReward:0.5,  rewardDays:30 },
    { level:4, key:'green',  nameKey:'skinNameGreen',  price:0,  status:'soon', dailyReward:0,    rewardDays:0  },
    { level:5, key:'black',  nameKey:'skinNameBlack',  price:0,  status:'soon', dailyReward:0,    rewardDays:0  }
  ];
  function fmtTon(n){
    return (Math.round(n * 100) / 100).toString().replace(/\.0+$/,'').replace(/(\.\d*[1-9])0+$/,'$1');
  }
  function renderSkinShop(){
    const grid = document.getElementById('skinGrid');
    if (!grid) return;
    grid.innerHTML = '';
    SKIN_LEVELS.forEach(def => {
      const owned = store.ownedSkins.indexOf(def.key) !== -1;
      const selected = store.skin === def.key;
      const reward = store.skinRewards[def.key];
      const rewardActive = !!(reward && reward.remainingDays > 0);

      const item = document.createElement('div');
      item.className = 'skin-item' + (selected ? ' selected' : '') + (def.status==='soon' ? ' soon' : '');

      const img = (typeof SKIN_IMAGES !== 'undefined' && SKIN_IMAGES[def.key]) ? SKIN_IMAGES[def.key] : '';

      let btnHtml;
      if (def.status === 'soon'){
        btnHtml = '<button class="skin-buy-btn soon-btn" disabled>' + t('skinComingSoon') + '</button>';
      } else if (selected){
        btnHtml = '<button class="skin-buy-btn selected-btn" disabled>' + t('skinSelected') + '</button>';
      } else if (owned){
        btnHtml = '<button class="skin-buy-btn owned" data-skin="' + def.key + '" data-action="select">' + t('skinSelectBtn') + '</button>';
      } else {
        const priceLabel = def.price > 0 ? (def.price + ' TON') : t('skinFree');
        btnHtml = '<button class="skin-buy-btn" data-skin="' + def.key + '" data-action="buy" ' +
          (def.price > store.points ? 'disabled' : '') + '>' + priceLabel + '</button>';
      }

      let metaHtml = '';
      if (def.status === 'soon'){
        metaHtml = '<span class="skin-tag tag-soon">' + t('skinComingSoon') + '</span>';
      } else if (def.price === 0){
        metaHtml = '<span class="skin-tag tag-free">' + t('skinFree') + '</span>';
      } else {
        metaHtml = '<span class="skin-tag tag-price">' + def.price + ' TON</span>';
      }
      if (def.dailyReward > 0){
        metaHtml += '<span class="skin-tag tag-reward">⚡ +' + fmtTon(def.dailyReward) + ' TON/' + t('skinPerDay') + '</span>';
      }

      let rewardBlock = '';
      if (def.dailyReward > 0){
        if (rewardActive){
          const pct = Math.round(((def.rewardDays - reward.remainingDays) / def.rewardDays) * 100);
          rewardBlock =
            '<div class="skin-reward-box active">' +
              '<div class="skin-reward-row">' +
                '<span>🎁 ' + t('skinRewardActive') + '</span>' +
                '<span>' + reward.remainingDays + ' ' + t('skinDaysLeft') + '</span>' +
              '</div>' +
              '<div class="skin-reward-track"><div class="skin-reward-fill" style="width:' + pct + '%"></div></div>' +
            '</div>';
        } else if (!owned) {
          rewardBlock =
            '<div class="skin-reward-box">' +
              '<div class="skin-reward-row">' +
                '<span>🎁 ' + t('skinRewardOffer') + '</span>' +
              '</div>' +
              '<div class="skin-reward-hint">+' + fmtTon(def.dailyReward) + ' TON ' + t('skinPerDayFor') + ' ' + def.rewardDays + ' ' + t('skinDays') + '</div>' +
            '</div>';
        }
      }

      item.innerHTML =
        '<div class="skin-item-top">' +
          '<div class="skin-item-img"><span class="skin-level-badge">' + def.level + '</span>' + (img ? '<img src="' + img + '" alt="">' : '') + '</div>' +
          '<div class="skin-item-info">' +
            '<div class="skin-item-title">' + t(def.nameKey) + '<span class="skin-item-sub">' + t('skinLevelLabel') + ' ' + def.level + '</span></div>' +
            '<div class="skin-item-tags">' + metaHtml + '</div>' +
          '</div>' +
        '</div>' +
        rewardBlock;
      item.insertAdjacentHTML('beforeend', '<div class="skin-item-actions">' + btnHtml + '</div>');
      grid.appendChild(item);
    });
    grid.querySelectorAll('.skin-buy-btn[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.skin;
        const action = btn.dataset.action;
        const def = SKIN_LEVELS.find(d => d.key === key);
        if (!def || def.status === 'soon') return;
        if (action === 'buy'){
          if (store.ownedSkins.indexOf(key) === -1){
            if (def.price > 0 && store.points < def.price) return;
            store.points -= def.price;
            store.ownedSkins.push(key);
            if (def.dailyReward > 0){
              store.skinRewards[key] = { remainingDays: def.rewardDays, lastCreditDate: '' };
            }
          }
          store.skin = key;
        } else if (action === 'select'){
          store.skin = key;
        }
        saveStore();
        creditSkinRewards();
        setPlayerSkin(store.skin);
        refreshTopUI();
      });
    });
  }

