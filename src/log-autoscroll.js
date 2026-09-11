// Keep the game log pinned to the newest message whenever React adds or replaces log entries.
const attachLogAutoScroll = () => {
  const log = document.querySelector('.game-log');
  if (!log) return false;
  const scrollToLatest = () => {
    log.scrollTop = log.scrollHeight;
  };
  scrollToLatest();
  const observer = new MutationObserver(() => {
    requestAnimationFrame(scrollToLatest);
  });
  observer.observe(log, { childList: true, subtree: true, characterData: true });
  return true;
};

if (!attachLogAutoScroll()) {
  const rootObserver = new MutationObserver(() => {
    if (attachLogAutoScroll()) rootObserver.disconnect();
  });
  rootObserver.observe(document.documentElement, { childList: true, subtree: true });
}
