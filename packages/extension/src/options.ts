interface NativeStatus {
  connected: boolean;
  hostName: string;
  lastConnectedAt: number | null;
  lastError: string | null;
}

const hostName = document.getElementById("host-name") as HTMLElement;
const extensionId = document.getElementById("extension-id") as HTMLElement;
const connected = document.getElementById("connected") as HTMLElement;
const lastConnectedAt = document.getElementById(
  "last-connected-at",
) as HTMLElement;
const lastError = document.getElementById("last-error") as HTMLElement;
const refresh = document.getElementById("refresh") as HTMLButtonElement;

extensionId.textContent = chrome.runtime.id;

function render(status: NativeStatus): void {
  hostName.textContent = status.hostName;
  connected.textContent = status.connected ? "Connected" : "Disconnected";
  connected.dataset.state = status.connected ? "connected" : "disconnected";
  lastConnectedAt.textContent = status.lastConnectedAt
    ? new Date(status.lastConnectedAt).toLocaleString()
    : "Never";
  lastError.textContent = status.lastError ?? "None";
}

function loadStatus(): void {
  chrome.runtime.sendMessage(
    { type: "bb-browser.status" },
    (status: NativeStatus | undefined) => {
      if (chrome.runtime.lastError || !status) {
        render({
          connected: false,
          hostName: "com.pinix.bb_browser",
          lastConnectedAt: null,
          lastError:
            chrome.runtime.lastError?.message ??
            "Background service worker unavailable",
        });
        return;
      }
      render(status);
    },
  );
}

refresh.addEventListener("click", loadStatus);
loadStatus();
