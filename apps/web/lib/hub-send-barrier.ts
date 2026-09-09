// The main composer checks the auxiliary view before sending, so an outstanding
// Hub selection cannot silently become a message sent with the old selection.
let synchronize: (() => Promise<void>) | undefined;
export function registerHubSendBarrier(handler: () => Promise<void>) {
  synchronize = handler;
  return () => {
    if (synchronize === handler) synchronize = undefined;
  };
}
export async function synchronizeHubBeforeSend() {
  await synchronize?.();
}
