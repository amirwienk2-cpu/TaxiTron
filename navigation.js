  /* ================= NAVIGATION ================= */
  const screens = document.querySelectorAll('.screen');
  const navButtons = document.querySelectorAll('.bottomnav button');
  function showScreen(name){
    screens.forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
    navButtons.forEach(b => b.classList.toggle('active', b.dataset.screen === name));
    refreshTopUI();
    if (name === 'tournament') renderLeaderboard();
  }
  navButtons.forEach(b => b.addEventListener('click', () => {
    if (b.dataset.screen === 'game'){ enterGame(); }
    else { showScreen(b.dataset.screen); }
  }));
  document.getElementById('toHomeBtn').addEventListener('click', () => showScreen('home'));

  function enterGame(){
    if (!hasAttemptsLeft()){
      showScreen('home');
      return;
    }
    consumeAttempt();
    renderAttemptsUI();
    document.querySelectorAll('.bottomnav button').forEach(b=>b.classList.remove('active'));
    screens.forEach(s => s.classList.toggle('active', s.id === 'screen-game'));
    document.getElementById('gameOverScreen').style.display = 'none';
    reset();
    running = true;
  }
  function leaveGameToHome(){
    showScreen('home');
  }
  document.getElementById('homePlayBtn').addEventListener('click', enterGame);
  document.getElementById('exitRunBtn').addEventListener('click', () => {
    if (running){ running = false; commitRun(); }
    leaveGameToHome();
  });
  document.getElementById('goHomeBtn').addEventListener('click', leaveGameToHome);

