/** Observe a running local conversation without overlapping probes or firing after completion. */
export function watchLocalConversationAvailability(
  check: () => Promise<void>,
  onUnavailable: (error: unknown) => void,
) {
  let live = true;
  let busy = false;
  const timer = setInterval(() => {
    if (!live || busy) return;
    busy = true;
    void check()
      .catch((error) => {
        if (!live) return;
        stop();
        onUnavailable(error);
      })
      .finally(() => {
        busy = false;
      });
  }, 3000);
  timer.unref?.();
  function stop() {
    live = false;
    clearInterval(timer);
  }
  return stop;
}
