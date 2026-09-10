  camera.position.set(0, 3.6, 8.5);
  camera.lookAt(0, 1.2, -14);
  loop();
  refreshTopUI();
  applyLanguage(currentLang);

  if (window.Telegram && window.Telegram.WebApp){
    const tg = window.Telegram.WebApp;
    tg.ready();
    if (typeof tg.requestFullscreen === 'function') { tg.requestFullscreen(); } else { tg.expand(); }
    if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes();
    if (typeof tg.disableSwipeToClose === 'function') tg.disableSwipeToClose();
  }
  initServerSession();
