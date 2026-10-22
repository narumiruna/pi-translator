import { getProvidersForOAuthOrigins } from "../auth/browser-oauth.js";
import { ProviderRuntime } from "../auth/runtime.js";
import * as SiteProfiles from "../content/extraction/site-profiles.js";
import * as Appearance from "../shared/appearance.js";
import * as EmbeddedFrames from "../shared/embedded-frames.js";
import { createLogger } from "../shared/logger.js";
import * as Messages from "../shared/messages.js";
import * as Pdf from "../shared/pdf.js";
import * as Settings from "../shared/settings.js";
import * as TranslationSession from "../shared/translation-session.js";
import * as Api from "../translation/api.js";
import { createAuthPortHandler } from "./auth-port.js";
import { createBackgroundController } from "./controller.js";
import { createPdfController } from "./pdf-controller.js";
import { createBackgroundPlatform } from "./platform.js";

const logger = createLogger("background");
const providerRuntime = new ProviderRuntime({ chrome, settingsApi: Settings });
const runtimeReady = providerRuntime.initialize();
runtimeReady.catch(() => logger.error("runtime-initialization-failed"));
const translationApi = Api.createTranslationApi(providerRuntime);
const handleAuthPort = createAuthPortHandler({
	runtime: providerRuntime,
	runtimeId: chrome.runtime.id,
});
const platform = createBackgroundPlatform({
	chrome,
	Appearance,
	EmbeddedFrames,
	Messages,
	ProviderRuntime: providerRuntime,
	Settings,
	SiteProfiles,
});
const pdfController = createPdfController({
	chrome,
	Api: translationApi,
	Pdf,
	logger,
	platform,
});
const controller = createBackgroundController({
	chrome,
	Api: translationApi,
	Messages,
	ProviderRuntime: providerRuntime,
	Settings,
	SiteProfiles,
	TranslationSession,
	logger,
	openPdfTranslator: (tab) => pdfController.openPdfTranslator(tab),
	platform,
});

async function translateTab(tab) {
	if (Pdf.isPdfCandidateUrl(tab?.url)) {
		return pdfController.openPdfTranslator(tab);
	}

	return controller.translatePage(tab);
}

const actionRequests = new Map();

async function runAction(tab, operation) {
	const request = {};
	actionRequests.set(tab?.id, request);
	const isCurrent = () => actionRequests.get(tab?.id) === request;
	try {
		await runtimeReady;
		if (isCurrent()) await operation();
	} catch (error) {
		await handleFailure(tab, error, isCurrent);
	} finally {
		if (isCurrent()) actionRequests.delete(tab?.id);
	}
}

function handleFailure(tab, error, isCurrent) {
	if (!tab?.id || !isCurrent()) {
		return Promise.resolve();
	}

	logger.error("translation-failed", {
		error: error?.message || String(error),
		tabId: tab.id,
	});
	// Page startup cleanup is session-scoped in the controller.
	// An unrelated selection/configuration failure must not stop a page session.
	return platform
		.sendToast(tab.id, error.message, "error")
		.then(() => isCurrent() && platform.setBadge(tab.id, "!"));
}

chrome.runtime.onInstalled.addListener(() => {
	controller.setupContextMenus().catch((error) => {
		logger.error("context-menu-setup-failed", { error: error.message });
	});
});

chrome.runtime.onStartup.addListener(() => {
	controller.setupContextMenus().catch((error) => {
		logger.error("context-menu-setup-failed", { error: error.message });
	});
});

chrome.action.onClicked.addListener(async (tab) => {
	logger.info("action-clicked", { tabId: tab?.id });
	await runAction(tab, () => translateTab(tab));
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
	logger.info("context-menu-clicked", {
		frameId: info.frameId,
		menuItemId: info.menuItemId,
		tabId: tab?.id,
	});
	await runAction(tab, async () => {
		if (info.menuItemId === "translate-page") {
			await translateTab(tab);
		} else if (info.menuItemId === "open-pdf-reader") {
			await pdfController.openPdfTranslator(tab, { allowUnknownType: true });
		} else if (info.menuItemId === "translate-selection" && tab?.id) {
			await controller.translateSelection(
				tab.id,
				info.selectionText,
				info.frameId,
			);
		}
	});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.status === "loading") {
		actionRequests.delete(tabId);
		controller.removePageTranslationState(tabId);
		platform.setBadge(tabId, "");
		logger.debug("tab-loading", { tabId });
	}
});

chrome.tabs.onRemoved.addListener((tabId) => {
	actionRequests.delete(tabId);
	controller.removePageTranslationState(tabId);
	pdfController.removeSessionByTab(tabId);
	logger.debug("tab-removed", { tabId });
});

chrome.runtime.onConnect.addListener((port) => {
	if (port.name === "vibe-translator-auth") {
		handleAuthPort(port);
		return;
	}
	pdfController.handleConnect(port);
});

chrome.permissions.onRemoved.addListener((permissions) => {
	for (const providerId of getProvidersForOAuthOrigins(permissions.origins)) {
		providerRuntime.invalidateCredential(providerId, "oauth").catch((error) =>
			logger.error("oauth-credential-invalidation-failed", {
				error: error.message,
				providerId,
			}),
		);
	}
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	runtimeReady
		.then(() => controller.handleRuntimeMessage(message, sender))
		.then((result) => sendResponse(result))
		.catch((error) => {
			logger.error("message-failed", {
				error: error.message,
				frameId: sender.frameId,
				tabId: sender.tab?.id,
				type: message?.type,
			});
			sendResponse({ ok: false, error: error.message });
		});

	return true;
});
