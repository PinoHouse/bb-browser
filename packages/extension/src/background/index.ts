/**
 * bb-browser background service worker.
 *
 * Chrome Native Messaging owns the Native Host lifecycle. This worker keeps a
 * single port and exposes connection status to the options page.
 */

import { handleCommand } from "./command-handler";
import { NativeClient } from "./native-client";

const nativeClient = new NativeClient({
  extensionVersion: chrome.runtime.getManifest().version,
  handleCommand,
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "bb-browser.status") {
    sendResponse(nativeClient.status());
    return true;
  }
  sendResponse({ received: true });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  nativeClient.connect();
});

chrome.runtime.onStartup.addListener(() => {
  nativeClient.connect();
});

nativeClient.connect();
